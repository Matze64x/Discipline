/**
 * Syncing in the desktop app: phones and other PCs connect to the Rust side (`src-tauri/src/sync`),
 * which hands this window authenticated connections; the sync itself runs here (`SyncManager`).
 * Also pairing (QR codes for phones, a code to compare for PCs), the paired devices and this PC's
 * name.
 */
import type { SyncReport } from '../../core';
import { SyncManager } from './manager.svelte';
import type { Workspace } from '../workspace.svelte';

export interface DesktopInfo {
	readonly deviceId: string;
	readonly name: string;
	/** Networking is on (off at every start) */
	readonly enabled: boolean;
	/** "ip:port" phones connect to; null: off, or not on a local network */
	readonly address: string | null;
}

export interface PairedPhone {
	readonly id: string;
	readonly name: string;
	/** Unix seconds */
	readonly pairedAt: number;
}

export interface PairedPc {
	readonly id: string;
	readonly name: string;
	/** Unix seconds */
	readonly pairedAt: number;
}

/** A PC running Discipline on the network */
export interface FoundPc {
	readonly id: string;
	readonly name: string;
}

/** Pairing with another PC: both screens show the code until both users confirmed it */
export interface PcPairing {
	readonly code: string;
	readonly peerId: string;
	readonly peerName: string;
	/** Started on the other PC */
	readonly incoming: boolean;
	/** Confirmed here; waiting for the other PC */
	readonly confirmed: boolean;
}

type PairingEvent =
	| { state: 'code'; code: string; peerId: string; peerName: string; incoming: boolean }
	| { state: 'done'; peerId: string; peerName: string }
	| { state: 'failed'; reason: string };

export interface PairingQr {
	readonly payload: string;
	readonly svg: string;
	readonly seconds: number;
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
	const { invoke } = await import('@tauri-apps/api/core');
	try {
		return await invoke<T>(command, args);
	} catch (e) {
		throw new Error(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));
	}
}

export class DesktopSync {
	readonly #workspace: Workspace;
	readonly manager: SyncManager;
	info = $state.raw<DesktopInfo | null>(null);
	phones = $state.raw<readonly PairedPhone[]>([]);
	pcs = $state.raw<readonly PairedPc[]>([]);
	/** PCs on the network (paired ones too) */
	found = $state.raw<readonly FoundPc[]>([]);
	pcPairing = $state.raw<PcPairing | null>(null);
	/** The PC a pairing was started with here, until both show the code */
	pcPairingStarting = $state<string | null>(null);
	/** How the last PC pairing ended (null while none ended, or once seen) */
	pcPairingResult = $state.raw<{ readonly ok: boolean; readonly message: string } | null>(null);
	/** Why syncing couldn't start */
	problem = $state<string | null>(null);
	readonly #connections = new Map<number, { peerId: string; receive: (text: string) => void; closed: () => void }>();
	/** Switching networking and the pairing gate: one after the other (separate invokes can overtake each other) */
	#settings: Promise<unknown> = Promise.resolve();
	/** Called when a phone was paired (e.g. to close the QR code) */
	onPaired: ((name: string) => void) | null = null;

	constructor(workspace: Workspace, report: (report: SyncReport) => void) {
		this.#workspace = workspace;
		this.manager = new SyncManager(workspace, () => ({ id: this.info!.deviceId, name: this.info!.name, kind: 'pc' }), report);
	}

	/** Listens for phones, then starts the endpoint. Returns the function that stops listening. */
	async start(): Promise<() => void> {
		const { listen } = await import('@tauri-apps/api/event');
		// a phone may connect before `sync_start` answered (this PC's id isn't known yet): its events
		// wait until then, in order
		let waiting: (() => void)[] | null = [];
		const inOrder = (handle: () => void) => (waiting ? waiting.push(handle) : handle());
		const stops = await Promise.all([
			listen<{ conn: number; peerId: string; peerName: string; kind: 'phone' | 'pc' }>('sync-connected', ({ payload }) => inOrder(() => this.#connected(payload.conn, payload.peerId, payload.kind === 'phone'))),
			listen<{ conn: number; text: string }>('sync-message', ({ payload }) => inOrder(() => this.#connections.get(payload.conn)?.receive(payload.text))),
			listen<number>('sync-closed', ({ payload }) =>
				inOrder(() => {
					this.#connections.get(payload)?.closed();
					this.#connections.delete(payload);
				}),
			),
			listen<{ phoneId: string; phoneName: string }>('sync-paired', ({ payload }) => {
				void this.refreshPhones();
				this.onPaired?.(payload.phoneName);
			}),
			// (late events of a stopped instance don't count once networking is off)
			listen<string | null>('sync-address', ({ payload }) => {
				if (!this.enabled) return;
				this.info = { ...this.info!, address: payload };
				void this.refreshPcs();
			}),
			listen<FoundPc[]>('sync-pcs-found', ({ payload }) => {
				if (this.enabled) this.found = payload;
			}),
			listen<PairingEvent>('sync-pc-pairing', ({ payload }) => {
				if (this.enabled) this.#pairingEvent(payload);
			}),
			listen<{ peerId: string; reason: string }>('sync-pc-refused', ({ payload }) => this.manager.setProblem(payload.peerId, payload.reason)),
		]);
		try {
			this.info = await invoke<DesktopInfo>('sync_start');
			for (const handle of waiting.splice(0)) handle();
			waiting = null;
			await Promise.all([this.refreshPhones(), this.refreshPcs()]);
		} catch (e) {
			this.problem = e instanceof Error ? e.message : String(e);
		}
		return () => {
			for (const stop of stops) stop();
			this.manager.stop();
		};
	}

	#connected(conn: number, peerId: string, isPhone: boolean): void {
		// (a newer connection to the same device replaces an older one: never two sessions with one base)
		for (const [other, c] of this.#connections) {
			if (c.peerId !== peerId) continue;
			c.closed();
			this.#connections.delete(other);
			void invoke('sync_close', { conn: other }).catch(() => undefined);
		}
		// one message after the other: separate invokes could overtake each other
		let chain: Promise<unknown> = Promise.resolve();
		const handlers = this.manager.attach(
			{
				peerId,
				send: (text) => void (chain = chain.then(() => invoke('sync_send', { conn, text })).catch(() => undefined)),
				close: () => void (chain = chain.then(() => invoke('sync_close', { conn })).catch(() => undefined)),
			},
			isPhone,
		);
		this.#connections.set(conn, { peerId, ...handlers });
	}

	async refreshPhones(): Promise<void> {
		this.phones = await invoke<PairedPhone[]>('sync_phones');
	}

	startPairing(): Promise<PairingQr> {
		return invoke<PairingQr>('sync_pairing_start');
	}

	stopPairing(): Promise<void> {
		return invoke('sync_pairing_stop');
	}

	/** Unpairs a phone: it can't connect any more until it's paired again. */
	async forget(phoneId: string): Promise<void> {
		await invoke('sync_forget', { phoneId });
		this.manager.forgetDevice(phoneId);
		await this.#workspace.forgetPeer(phoneId);
		await this.refreshPhones();
	}

	get enabled(): boolean {
		return this.info?.enabled ?? false;
	}

	/** Turns networking on (listening, announcing this PC, connecting to paired PCs) or off. */
	async setEnabled(enabled: boolean): Promise<void> {
		const switched = this.#settings.then(() => invoke<DesktopInfo>('sync_set_enabled', { enabled }));
		this.#settings = switched.catch(() => undefined);
		this.info = await switched;
		if (!enabled) {
			this.pcPairing = null;
			this.pcPairingStarting = null;
		}
		await this.refreshPcs();
	}

	async refreshPcs(): Promise<void> {
		const { paired, found } = await invoke<{ paired: PairedPc[]; found: FoundPc[] }>('sync_pcs');
		this.pcs = paired;
		this.found = found;
	}

	#pairingEvent(event: PairingEvent): void {
		const started = this.pcPairingStarting !== null;
		this.pcPairingStarting = null;
		if (event.state === 'code') {
			this.pcPairingResult = null;
			this.pcPairing = { code: event.code, peerId: event.peerId, peerName: event.peerName, incoming: event.incoming, confirmed: false };
			return;
		}
		const shown = this.pcPairing !== null;
		this.pcPairing = null;
		if (event.state === 'done') {
			this.manager.forgetProblem(event.peerId);
			this.pcPairingResult = { ok: true, message: `Paired with ${event.peerName}.` };
			void this.refreshPcs();
		} else if (started || shown) {
			// (attempts nobody saw here, e.g. a stranger's, aren't reported)
			this.pcPairingResult = event.reason ? { ok: false, message: event.reason } : null;
		}
	}

	/** Starts pairing with a PC on the network: both then show a code (`pcPairing`). */
	async pairPc(peerId: string): Promise<void> {
		this.pcPairingResult = null;
		this.pcPairingStarting = peerId;
		try {
			await invoke('sync_pc_pair', { peerId });
		} catch (e) {
			this.pcPairingStarting = null;
			throw e;
		}
	}

	/** The user saw the same code on both PCs */
	async confirmPcPairing(): Promise<void> {
		const shown = this.pcPairing;
		if (!shown) return;
		// (the code goes along: a confirmation never applies to another pairing's code)
		await invoke('sync_pc_pair_confirm', { code: shown.code });
		if (this.pcPairing === shown) this.pcPairing = { ...shown, confirmed: true };
	}

	cancelPcPairing(): Promise<void> {
		this.pcPairing = null;
		this.pcPairingStarting = null;
		return invoke('sync_pc_pair_cancel');
	}

	/** Other PCs may start pairing with this one only while the Settings dialog is open */
	setPairingAllowed(allowed: boolean): void {
		this.#settings = this.#settings.then(() => invoke('sync_pc_pairing_allowed', { allowed })).catch(() => undefined);
	}

	/** Unpairs a PC: neither syncs with the other any more (until paired again). */
	async forgetPc(peerId: string): Promise<void> {
		await invoke('sync_forget_pc', { peerId });
		this.manager.forgetDevice(peerId);
		await this.#workspace.forgetPeer(peerId);
		await this.refreshPcs();
	}

	async rename(name: string): Promise<void> {
		this.info = await invoke<DesktopInfo>('sync_rename', { name });
	}
}
