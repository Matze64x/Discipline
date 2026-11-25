/**
 * Syncing on a phone (or in a browser): it pairs with PCs by their QR code and, while the app is
 * open, keeps a connection to one of them (whichever answers; one is enough, the PCs sync among
 * themselves). It reconnects by itself: when the app comes back to the foreground, the network
 * returns, or after a growing pause. Only one tab of the app syncs at a time (Web Locks).
 */
import { get, set, update } from 'idb-keyval';
import type { DeviceInfo, SyncReport } from '../../core';
import { errorMessage } from '../errors';
import type { Workspace } from '../workspace.svelte';
import { SyncManager } from './manager.svelte';
import type { PairingCode, PcAddress } from './pairing-code';
import { connectToPc, LinkError, type PcLink } from './phone-link';

export interface Pairing extends PcAddress {
	readonly pcId: string;
	/** The PC's name, as it said last */
	readonly name: string;
	/** Proves this device to the PC */
	readonly token: string;
	/** ms since 1970 */
	readonly pairedAt: number;
}

interface StoredSync {
	readonly device: { readonly id: string; readonly name: string };
	readonly pairings: readonly Pairing[];
}

const KEY = 'discipline-sync-v1';
/** Pauses between connection attempts while no PC answers or syncing fails (the last one repeats) */
const RETRY_MS = [5_000, 10_000, 20_000, 30_000];
/** The pause before reconnecting after a connection that worked ended */
const RECONNECT_MS = 1_000;
/** After the app was in the background this long, its connection may be dead: reconnect */
const STALE_AFTER_HIDDEN_MS = 10_000;

export type PhoneSyncStatus = 'starting' | 'off' | 'unpaired' | 'connecting' | 'connected' | 'unreachable' | 'other-tab';

function defaultName(): string {
	const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
	if (/iPhone/.test(ua)) return 'iPhone';
	if (/iPad/.test(ua)) return 'iPad';
	if (/Android/.test(ua)) return 'Android phone';
	return 'Browser';
}

function randomId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class PhoneSync {
	readonly #workspace: Workspace;
	readonly manager: SyncManager;
	device = $state.raw<{ id: string; name: string } | null>(null);
	pairings = $state.raw<readonly Pairing[]>([]);
	status = $state<PhoneSyncStatus>('starting');
	/** The PC connected to, by id */
	connectedTo = $state<string | null>(null);
	/** Why the last attempt to connect or sync failed */
	problem = $state<string | null>(null);
	/** Whether this tab may change the pairings: only the tab that syncs does (others would overwrite them) */
	canChange = $state(false);
	/** Networking is on (off at every start: this device connects to nothing until then) */
	enabled = $state(false);
	#link: PcLink | null = null;
	#running = false;
	#wake: (() => void) | null = null;
	#retry = 0;
	/** The pause before the next connection attempt (set when a connection ended) */
	#pause = 0;
	#busy = false;
	/** Ends connection attempts under way when networking is turned off */
	#attempts = new AbortController();

	constructor(workspace: Workspace, report: (report: SyncReport) => void) {
		this.#workspace = workspace;
		this.manager = new SyncManager(workspace, () => this.#self(), report);
	}

	#self(): DeviceInfo {
		const device = this.device!;
		return { id: device.id, name: device.name, kind: 'phone' };
	}

	async #save(): Promise<void> {
		await set(KEY, { device: this.device!, pairings: this.pairings } satisfies StoredSync);
	}

	/** Reads this device and its pairings; the first start makes the device id (once, even with several tabs starting). */
	async #load(): Promise<void> {
		await update<StoredSync>(KEY, (stored) => stored ?? { device: { id: randomId(), name: defaultName() }, pairings: [] });
		const stored = (await get<StoredSync>(KEY))!;
		this.device = stored.device;
		this.pairings = stored.pairings;
	}

	#backoff(): number {
		return RETRY_MS[Math.min(this.#retry++, RETRY_MS.length - 1)]!;
	}

	/** Loads the pairings and keeps connecting while the app runs. Returns the function that stops it. */
	async start(): Promise<() => void> {
		await this.#load();
		const wake = () => this.#wake?.();
		let hiddenSince: number | null = null;
		const onVisible = () => {
			if (document.visibilityState !== 'visible') {
				hiddenSince = Date.now();
				return;
			}
			// (a phone suspends a page in the background: its connection may be dead without saying so)
			if (hiddenSince !== null && Date.now() - hiddenSince > STALE_AFTER_HIDDEN_MS) this.#link?.close();
			hiddenSince = null;
			this.#retry = 0;
			this.#pause = 0;
			wake();
		};
		document.addEventListener('visibilitychange', onVisible);
		addEventListener('online', wake);
		this.#running = true;
		let releaseLock = () => {};
		// one tab syncs and changes the pairings: the others wait for the lock (and take over when that tab closes)
		if (navigator.locks) {
			this.status = 'other-tab';
			void navigator.locks.request('discipline-sync', async () => {
				if (!this.#running) return;
				// (the tab that had the lock may have changed them)
				await this.#load();
				this.canChange = true;
				void this.#loop();
				return new Promise<void>((resolve) => (releaseLock = resolve));
			});
		} else {
			this.canChange = true;
			void this.#loop();
		}
		return () => {
			this.#running = false;
			this.canChange = false;
			document.removeEventListener('visibilitychange', onVisible);
			removeEventListener('online', wake);
			this.#link?.close();
			wake();
			releaseLock();
		};
	}

	async #sleep(ms: number): Promise<void> {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			this.#wake = () => {
				clearTimeout(timer);
				resolve();
			};
		});
		this.#wake = null;
	}

	/** Turns connecting to PCs on or off (in the tab that syncs). */
	setEnabled(enabled: boolean): void {
		this.#mayChange();
		this.enabled = enabled;
		this.#retry = 0;
		this.#pause = 0;
		if (!enabled) {
			this.status = 'off';
			this.#attempts.abort();
			this.#attempts = new AbortController();
			this.#link?.close();
		}
		this.#wake?.();
	}

	async #loop(): Promise<void> {
		while (this.#running) {
			if (!this.enabled) {
				this.status = 'off';
				await this.#sleep(60_000);
				continue;
			}
			if (this.#link || this.#busy) {
				await this.#sleep(60_000);
				continue;
			}
			if (this.pairings.length === 0) {
				this.status = 'unpaired';
				await this.#sleep(60_000);
				continue;
			}
			if (document.visibilityState !== 'visible') {
				await this.#sleep(60_000);
				continue;
			}
			if (this.#pause > 0) {
				const pause = this.#pause;
				this.#pause = 0;
				await this.#sleep(pause);
				continue;
			}
			await this.#connectAny();
			if (!this.#link && this.#running && this.enabled) await this.#sleep(this.#backoff());
		}
	}

	async #connectAny(): Promise<void> {
		this.status = 'connecting';
		for (const pairing of this.pairings) {
			if (!this.#running || !this.enabled || this.#link) return;
			let link: PcLink | null = null;
			try {
				link = await connectToPc(pairing, { t: 'auth', id: this.device!.id, token: pairing.token, name: this.device!.name }, this.#attempts.signal);
				if (link.reply.id !== pairing.pcId) throw new LinkError('A different PC answered.');
				// (stopped, or paired meanwhile)
				if (!this.#running || this.#link) return link.close();
				if (link.reply.name !== pairing.name) await this.#update(pairing.pcId, { name: link.reply.name });
				this.#attach(link, pairing.pcId);
				return;
			} catch (e) {
				link?.close();
				if (!this.enabled) return;
				this.problem = errorMessage(e);
			}
		}
		if (this.enabled) this.status = 'unreachable';
	}

	#attach(link: PcLink, pcId: string): void {
		// (turned off or stopped meanwhile)
		if (!this.#running || !this.enabled) return link.close();
		this.#link?.close();
		this.#link = link;
		this.status = 'connected';
		this.connectedTo = pcId;
		let synced = false;
		const handlers = this.manager.attach({ peerId: pcId, send: (text) => link.send(text), close: () => link.close() }, false, {
			synced: () => {
				synced = true;
				this.#retry = 0;
				this.problem = null;
			},
		});
		link.onMessage = handlers.receive;
		link.onClose = () => {
			handlers.closed();
			if (this.#link === link) {
				this.#link = null;
				this.connectedTo = null;
				this.status = this.enabled ? 'connecting' : 'off';
				const failure = this.manager.problems[pcId];
				if (failure) this.problem = failure;
				// a connection that never synced (e.g. the versions differ) is retried with growing pauses, not right away
				this.#pause = synced && !failure ? RECONNECT_MS : this.#backoff();
				this.#wake?.();
			}
		};
	}

	async #update(pcId: string, changes: Partial<Pairing>): Promise<void> {
		this.pairings = this.pairings.map((p) => (p.pcId === pcId ? { ...p, ...changes } : p));
		await this.#save();
	}

	#mayChange(): void {
		if (!this.canChange) throw new Error('Another tab syncs: change devices there.');
	}

	/** Pairs with the PC whose code was scanned, and connects to it. Throws with a reason to show. */
	async pair(code: PairingCode): Promise<string> {
		this.#mayChange();
		if (!this.enabled) throw new Error('Turn on syncing first.');
		if (this.#busy) throw new LinkError('Already pairing.');
		this.#busy = true;
		try {
			const link = await connectToPc(code, { t: 'pair', secret: code.secret, id: this.device!.id, name: this.device!.name });
			const { id, name, token } = link.reply;
			if (id !== code.pcId || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
				link.close();
				throw new LinkError('The PC answered strangely. Try again.');
			}
			const { secret: _, ...address } = code;
			const pairing: Pairing = { ...address, pcId: id, name, token, pairedAt: Date.now() };
			this.pairings = [...this.pairings.filter((p) => p.pcId !== id), pairing];
			try {
				await this.#save();
			} catch (e) {
				link.close();
				throw e;
			}
			this.#retry = 0;
			this.manager.forgetProblem(id);
			this.#attach(link, id);
			return name;
		} finally {
			this.#busy = false;
			this.#wake?.();
		}
	}

	/** Unpairs a PC here (the PC keeps knowing this device until it's removed there too). */
	async forget(pcId: string): Promise<void> {
		this.#mayChange();
		this.pairings = this.pairings.filter((p) => p.pcId !== pcId);
		await this.#save();
		if (this.connectedTo === pcId) this.#link?.close();
		this.manager.forgetDevice(pcId);
		await this.#workspace.forgetPeer(pcId);
	}

	async rename(name: string): Promise<void> {
		this.#mayChange();
		const trimmed = name.trim().slice(0, 64);
		if (!trimmed) throw new Error('Enter a name.');
		this.device = { ...this.device!, name: trimmed };
		await this.#save();
	}
}
