/**
 * Runs the sync (`core/peer-sync.ts`) over the open connections to other devices: one `PeerSession`
 * per connection, changes of the data passed on to all the other connections, and what each sync
 * brought in reported as a notice. The transports (WebRTC to phones, TLS between PCs) only hand it
 * authenticated connections.
 */
import { PeerSession, totalChanges, type DeviceInfo, type SyncReport } from '../../core';
import { errorMessage } from '../errors';
import type { Workspace } from '../workspace.svelte';

/** An open, authenticated connection to another device, carrying text messages in order */
export interface SyncConnection {
	/** The other device's id, as its key proved it */
	readonly peerId: string;
	send(text: string): void;
	/** Ends the connection (e.g. the sync failed) */
	close(): void;
}

export interface ConnectionState {
	readonly peer: DeviceInfo | null;
	readonly peerId: string;
	/** The last error that ended the sync on this connection */
	readonly error: string | null;
	/** When the last round finished (ms since 1970) */
	readonly lastSync: number | null;
}

/** Which side of a connection merges: the PC for a phone; between two PCs the lower id (both sides agree). */
export function isMerger(self: DeviceInfo, peerId: string, peerIsPhone: boolean): boolean {
	if (self.kind === 'phone') return false;
	return peerIsPhone || self.id < peerId;
}

const LAST_SYNCED_KEY = 'discipline-last-synced-v1';

/** When each device last synced with this one (a per-device convenience: kept in localStorage) */
function loadLastSynced(): Record<string, number> {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(LAST_SYNCED_KEY) ?? '{}');
		return stored && typeof stored === 'object' ? (stored as Record<string, number>) : {};
	} catch {
		return {};
	}
}

function saveLastSynced(value: Record<string, number>): void {
	try {
		localStorage.setItem(LAST_SYNCED_KEY, JSON.stringify(value));
	} catch {
		// (only a convenience)
	}
}

interface Attached {
	readonly connection: SyncConnection;
	readonly session: PeerSession;
	state: ConnectionState;
}

export class SyncManager {
	readonly #workspace: Workspace;
	readonly #self: () => DeviceInfo;
	readonly #report: (report: SyncReport) => void;
	readonly #attached = new Set<Attached>();
	/** Connections and their state, for the screens */
	connections = $state.raw<readonly ConnectionState[]>([]);
	/** Why syncing with a device failed last, by device id (until a round with it succeeds); kept after it disconnected */
	problems = $state.raw<Readonly<Record<string, string>>>({});
	/** When a round with each device last finished (ms since 1970), by device id */
	lastSynced = $state.raw<Readonly<Record<string, number>>>(loadLastSynced());
	#stopListening: () => void;

	/**
	 * `self`: this device (read at each new connection, so a renamed device introduces itself by its
	 * new name). `report`: called after each round that changed something here.
	 */
	constructor(workspace: Workspace, self: () => DeviceInfo, report: (report: SyncReport) => void) {
		this.#workspace = workspace;
		this.#self = self;
		this.#report = report;
		this.#stopListening = workspace.onChange((cause) => {
			for (const a of this.#attached) if (a.connection.peerId !== cause) a.session.localChanged();
		});
	}

	/**
	 * Starts syncing over a new connection. `peerIsPhone`: what the transport knows about the other
	 * side (phones connect over WebRTC). Returns the function to call with each received message,
	 * and the one to call when the connection closed.
	 */
	attach(connection: SyncConnection, peerIsPhone: boolean, hooks: { synced?: () => void } = {}): { receive: (text: string) => void; closed: () => void } {
		const self = this.#self();
		const attached: Attached = {
			connection,
			state: { peer: null, peerId: connection.peerId, error: null, lastSync: null },
			session: new PeerSession({
				self,
				merger: isMerger(self, connection.peerId, peerIsPhone),
				store: this.#workspace,
				peerId: connection.peerId,
				send: (message) => connection.send(JSON.stringify(message)),
				onSynced: (report) => {
					this.#update(attached, { peer: report.peer, lastSync: Date.now(), error: null });
					this.#problem(connection.peerId, null);
					this.lastSynced = { ...this.lastSynced, [connection.peerId]: Date.now() };
					saveLastSynced(this.lastSynced);
					hooks.synced?.();
					if (totalChanges(report.changes) > 0) this.#report(report);
				},
				onFailed: (error) => {
					this.#update(attached, { error: error.message });
					this.#problem(connection.peerId, error.message);
					connection.close();
				},
			}),
		};
		this.#attached.add(attached);
		this.#publish();
		attached.session.start();
		return {
			receive: (text) => {
				let message;
				try {
					message = JSON.parse(text);
				} catch (e) {
					const message = `Unreadable message from the other device (${errorMessage(e)}).`;
					this.#update(attached, { error: message });
					this.#problem(connection.peerId, message);
					attached.session.close();
					connection.close();
					return;
				}
				attached.session.receive(message);
			},
			closed: () => {
				attached.session.close();
				this.#attached.delete(attached);
				this.#publish();
			},
		};
	}

	#update(attached: Attached, changes: Partial<ConnectionState>): void {
		attached.state = { ...attached.state, ...changes, peer: changes.peer ?? attached.state.peer ?? attached.session.peer };
		this.#publish();
	}

	#problem(peerId: string, message: string | null): void {
		if ((this.problems[peerId] ?? null) === message) return;
		const { [peerId]: _, ...others } = this.problems;
		this.problems = message === null ? others : { ...others, [peerId]: message };
	}

	/** A problem the transport found (e.g. the other device refused this one) */
	setProblem(peerId: string, message: string): void {
		this.#problem(peerId, message);
	}

	/** Forgets a device's problem (e.g. it was paired anew) */
	forgetProblem(peerId: string): void {
		this.#problem(peerId, null);
	}

	/** Forgets what's known about a device (it was unpaired) */
	forgetDevice(peerId: string): void {
		this.#problem(peerId, null);
		const { [peerId]: _, ...others } = this.lastSynced;
		this.lastSynced = others;
		saveLastSynced(others);
	}

	#publish(): void {
		this.connections = [...this.#attached].map((a) => a.state);
	}

	stop(): void {
		this.#stopListening();
		for (const a of this.#attached) {
			a.session.close();
			a.connection.close();
		}
		this.#attached.clear();
		this.#publish();
	}
}
