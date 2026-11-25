/**
 * A phone's (or a browser's) connection to a PC's desktop app: WebRTC without a signaling server.
 * The PC's side of the handshake is built from what the pairing QR code holds (see
 * `src-tauri/src/sync/endpoint.rs`): its address, ICE credentials and certificate fingerprint.
 * The browser checks that fingerprint during the DTLS handshake, so only that PC can answer. No
 * STUN/TURN servers: only the local network. The first message proves who the phone is (pairing
 * secret or token); after the PC's "ok", sync messages flow.
 */
import { Reassembler, splitFrames } from './framing';
import type { PcAddress } from './pairing-code';

/** Messages carry the whole data (about 3 MB for 10 habits over 10 years of daily entries) */
const MESSAGE_LIMIT = 256 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
/** A connection that stays "disconnected" this long counts as lost (the PC may have dropped it) */
const DISCONNECTED_MS = 5_000;
/** Send more frames only while less than this is waiting in the browser's buffer */
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

export type FirstMessage = { t: 'pair'; secret: string; id: string; name: string } | { t: 'auth'; id: string; token: string; name: string };
export type Reply = { t: 'ok'; id: string; name: string; token?: string } | { t: 'denied'; reason: string };

export interface PcLink {
	/** The PC's answer to the first message (always "ok" here: a refusal throws) */
	readonly reply: Reply & { t: 'ok' };
	send(text: string): void;
	close(): void;
	readonly closed: boolean;
	/** Messages received before this is set are kept until then */
	onMessage: ((text: string) => void) | null;
	/** Called once when the connection ends (right away if it already did) */
	onClose: (() => void) | null;
}

export class LinkError extends Error {}

/** The PC's side of the handshake (an SDP answer) made from its address, for the browser's offer. */
export function answerFor(pc: PcAddress, offerSdp: string): string {
	const mid = /^a=mid:(\S+)/m.exec(offerSdp)?.[1] ?? '0';
	const fingerprint = pc.fingerprint.toUpperCase().match(/../g)!.join(':');
	return [
		'v=0',
		'o=- 1 2 IN IP4 127.0.0.1',
		's=-',
		't=0 0',
		'a=ice-lite',
		`a=group:BUNDLE ${mid}`,
		'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
		'c=IN IP4 0.0.0.0',
		`a=mid:${mid}`,
		`a=ice-ufrag:${pc.ufrag}`,
		`a=ice-pwd:${pc.pass}`,
		`a=fingerprint:sha-256 ${fingerprint}`,
		'a=setup:passive',
		'a=sctp-port:5000',
		'a=max-message-size:262144',
		`a=candidate:1 1 udp 2130706431 ${pc.ip} ${pc.port} typ host`,
		'a=end-of-candidates',
		'',
	].join('\r\n');
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new LinkError(message)), ms)))]).finally(() => clearTimeout(timer));
}

/**
 * Connects to a PC and sends the first message. Throws `LinkError` if it can't be reached or
 * refuses, or `abort` fired (then the attempt stops right away).
 */
export async function connectToPc(pc: PcAddress, first: FirstMessage, abort?: AbortSignal): Promise<PcLink> {
	if (abort?.aborted) throw new LinkError('Stopped.');
	if (typeof RTCPeerConnection === 'undefined') throw new LinkError('This browser doesn’t support WebRTC.');
	// no STUN/TURN servers: only the local network
	const peer = new RTCPeerConnection({ iceServers: [] });
	const channel = peer.createDataChannel('discipline', { negotiated: true, id: 0 });
	channel.bufferedAmountLowThreshold = LOW_WATER;
	const reassembler = new Reassembler(MESSAGE_LIMIT);
	const outbox: string[] = [];
	let closed = false;
	let replyResolve: ((reply: Reply) => void) | null = null;
	let replyReject: ((error: Error) => void) | null = null;
	let authenticated = false;
	/** Messages that arrive before a handler is set */
	const early: string[] = [];
	let messageHandler: ((text: string) => void) | null = null;
	let closeHandler: (() => void) | null = null;
	let disconnectedTimer: ReturnType<typeof setTimeout> | undefined;

	const link: PcLink = {
		reply: undefined as never,
		send(text) {
			if (closed) return;
			outbox.push(...splitFrames(text));
			pump();
		},
		close() {
			shutdown();
		},
		get closed() {
			return closed;
		},
		get onMessage() {
			return messageHandler;
		},
		set onMessage(handler) {
			messageHandler = handler;
			if (handler) for (const m of early.splice(0)) handler(m);
		},
		get onClose() {
			return closeHandler;
		},
		set onClose(handler) {
			closeHandler = handler;
			if (handler && closed && authenticated) handler();
		},
	};

	function pump() {
		while (outbox.length > 0 && channel.readyState === 'open' && channel.bufferedAmount < HIGH_WATER) channel.send(outbox.shift()!);
	}

	function shutdown() {
		if (closed) return;
		closed = true;
		clearTimeout(disconnectedTimer);
		replyReject?.(new LinkError('The connection closed.'));
		channel.close();
		peer.close();
		if (authenticated) closeHandler?.();
	}

	abort?.addEventListener('abort', shutdown, { once: true });
	channel.onbufferedamountlow = pump;
	channel.onclose = shutdown;
	peer.onconnectionstatechange = () => {
		const state = peer.connectionState;
		if (state === 'failed' || state === 'closed') return shutdown();
		clearTimeout(disconnectedTimer);
		// (it may recover by itself; if not, it's gone: reconnecting is quicker than waiting)
		if (state === 'disconnected') disconnectedTimer = setTimeout(shutdown, DISCONNECTED_MS);
	};
	channel.onmessage = (event) => {
		if (typeof event.data !== 'string') return shutdown();
		let message: string | null;
		try {
			message = reassembler.push(event.data);
		} catch {
			return shutdown();
		}
		if (message === null) return;
		if (!authenticated) {
			try {
				replyResolve?.(JSON.parse(message) as Reply);
			} catch {
				shutdown();
			}
			return;
		}
		if (messageHandler) messageHandler(message);
		else early.push(message);
	};

	try {
		const opened = new Promise<void>((resolve, reject) => {
			channel.onopen = () => resolve();
			channel.onerror = () => reject(new LinkError('The connection failed.'));
			abort?.addEventListener('abort', () => reject(new LinkError('Stopped.')), { once: true });
		});
		const offer = await peer.createOffer();
		await peer.setLocalDescription(offer);
		await peer.setRemoteDescription({ type: 'answer', sdp: answerFor(pc, offer.sdp ?? '') });
		await withTimeout(opened, CONNECT_TIMEOUT_MS, 'The PC can’t be reached. Is Discipline running there, on the same network?');

		const reply = await withTimeout(
			new Promise<Reply>((resolve, reject) => {
				replyResolve = resolve;
				replyReject = reject;
				link.send(JSON.stringify(first));
			}),
			CONNECT_TIMEOUT_MS,
			'The PC didn’t answer.',
		);
		replyResolve = replyReject = null;
		if (reply.t !== 'ok') throw new LinkError(reply.t === 'denied' && typeof reply.reason === 'string' ? reply.reason : 'The PC refused the connection.');
		if (typeof reply.id !== 'string' || typeof reply.name !== 'string') throw new LinkError('The PC answered strangely.');
		authenticated = true;
		Object.assign(link, { reply });
		return link;
	} catch (e) {
		shutdown();
		throw e instanceof LinkError ? e : new LinkError(`The connection failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}
