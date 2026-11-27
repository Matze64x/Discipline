/**
 * Syncing the data between two devices over a connection, platform-independent (the transport,
 * pairing and storage are someone else's job: see `SyncStore` and `PeerSession.send`).
 *
 * Each pair of devices keeps a **base**: the data they last agreed on. One side of the connection
 * is the **merger** (the PC for a phone; the lower device id between two PCs), the other the
 * **client**. Only the client starts a round, so rounds on one connection never overlap:
 *
 *   client                                   merger
 *   state { base: hash, data | null }  ──▶   merge(base, mine, theirs); save it as working copy
 *                                             and as the new base for this client, atomically
 *                                     ◀──   result { hash, data | null (= what you sent) }
 *   save the result as working copy and as
 *   the new base, atomically
 *
 * - The client sends its data only if it differs from the base (else the merger knows it).
 * - The merger also keeps the base before (`previous`: the one the client last named) until the
 *   client names the new one: if a result never arrives (connection lost, the client's save
 *   failed), the client names the old base again, and the merge still knows what was deleted.
 * - If the client's base changed while a round was under way (its data was cleared), it drops the
 *   result and starts another round.
 * - If the base the client names isn't the merger's (one side lost or never had it), the merge
 *   runs without a base: nothing counts as deleted, both sides are combined. That errs towards
 *   keeping data. If the client sent no data then, the merger asks for it (`resend`).
 * - If the client's data changed while the round was under way, its new edits are merged on top of
 *   the result (three-way: what it sent, what it has now, the result), and another round follows.
 * - When the merger's data changes (an edit, another device), it tells the client (`changed`),
 *   which then starts a round. So changes travel on: phone → PC → other PCs → their phones.
 * - Saving the working copy and the base together (one storage transaction) keeps them consistent
 *   even if the app is closed halfway.
 * Data travels in the file format, so it's checked like a file; both sides must use the same
 * format version and protocol (checked in `hello`).
 */
import { FORMAT_VERSION, parseDiscipline, serializeDiscipline } from './format';
import { merge, type MergeResult } from './merge';
import type { DisciplineData } from './model';
import { summarizeChanges, type ChangeSummary } from './sync';

export const SYNC_PROTOCOL = 1;

export type DeviceKind = 'pc' | 'phone';

export interface DeviceInfo {
	readonly id: string;
	readonly name: string;
	readonly kind: DeviceKind;
}

export type SyncMessage =
	| { readonly type: 'hello'; readonly protocol: number; readonly format: number; readonly device: DeviceInfo }
	| { readonly type: 'state'; readonly base: string | null; readonly data: string | null }
	| { readonly type: 'resend' }
	| { readonly type: 'result'; readonly hash: string; readonly data: string | null }
	| { readonly type: 'changed' }
	| { readonly type: 'error'; readonly message: string };

export interface StoredBase {
	readonly data: DisciplineData;
	/** `hashText` of its file text */
	readonly hash: string;
	/**
	 * Merger only: the base the client named last, kept until the client names this one (it may not
	 * have received the result that made this one)
	 */
	readonly previous?: { readonly data: DisciplineData; readonly hash: string } | null;
}

/** The working copy and the bases, as the app stores them. */
export interface SyncStore {
	current(): DisciplineData;
	/**
	 * Runs `change` on the current working copy and this peer's base, atomically with any other
	 * change to the data, and saves what it returns (working copy and base in one go; returning the
	 * same objects saves nothing). Returns `change`'s `value`.
	 */
	transact<T>(peer: string, change: (working: DisciplineData, base: StoredBase | null) => { working: DisciplineData; base: StoredBase | null; value: T }): Promise<T>;
}

/** What a finished round changed in this device's data, and the conflicts the merge decided. */
export interface SyncReport {
	readonly peer: DeviceInfo;
	readonly changes: ChangeSummary;
	readonly conflicts: number;
}

/**
 * A fast 64-bit hash of a text (two 32-bit FNV-1a variants over the UTF-16 code units), as 16 hex
 * digits. Only to tell whether two devices have the same base; not for security (the connection
 * is authenticated and encrypted by the transport).
 */
export function hashText(text: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ text.length;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193);
		b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
	}
	return ((a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')).toLowerCase();
}

export class SyncError extends Error {}

function parseData(text: string): DisciplineData {
	const result = parseDiscipline(text);
	if (!result.ok) {
		const [first] = result.errors;
		throw new SyncError(`The other device sent invalid data (${first?.path || 'data'}: ${first?.message}).`);
	}
	return result.data;
}

/** The file text of data, made once per data object (they're never changed) */
const texts = new WeakMap<DisciplineData, string>();
function textOf(data: DisciplineData): string {
	let text = texts.get(data);
	if (text === undefined) texts.set(data, (text = serializeDiscipline(data)));
	return text;
}
const hashes = new WeakMap<DisciplineData, string>();
function hashOf(data: DisciplineData): string {
	let hash = hashes.get(data);
	if (hash === undefined) hashes.set(data, (hash = hashText(textOf(data))));
	return hash;
}

function baseOf(data: DisciplineData): StoredBase {
	return { data, hash: hashOf(data) };
}

function conflictCount(result: MergeResult): number {
	const c = result.conflicts;
	return c.habits.length + c.entries.length;
}

/** Same data (as the file would store it), regardless of object identity (by hash: a 64-bit collision is negligible) */
function sameData(a: DisciplineData, b: DisciplineData): boolean {
	return a === b || hashOf(a) === hashOf(b);
}

export interface PeerSessionOptions {
	readonly self: DeviceInfo;
	/** Whether this side merges (else it's the client and starts the rounds) */
	readonly merger: boolean;
	readonly store: SyncStore;
	/**
	 * The other device's id as the transport authenticated it (its key). A `hello` naming another id
	 * is refused, so a paired device can't pass itself off as another one (and use its base).
	 */
	readonly peerId: string;
	/** Sends a message to the other device (the transport serializes it) */
	readonly send: (message: SyncMessage) => void;
	/** A round changed this device's data (or found nothing to change) */
	readonly onSynced?: (report: SyncReport) => void;
	/** The session can't go on (wrong version, invalid data, …); the transport should close the connection */
	readonly onFailed?: (error: Error) => void;
}

/**
 * One connection's sync, for either side. Feed it the other side's messages (`receive`) and tell
 * it when this device's data changed (`localChanged`). Messages are handled one at a time.
 */
export class PeerSession {
	readonly #options: PeerSessionOptions;
	#peer: DeviceInfo | null = null;
	#started = false;
	#failed = false;
	#closed = false;
	#queue: Promise<void> = Promise.resolve();
	/** Client: a round is under way (state sent, result not yet received) */
	#inRound = false;
	/** Client: start another round when this one is done */
	#again = false;
	/** Client: the working copy sent in the current round */
	#sent: DisciplineData | null = null;
	/** Client: the hash of the base named in the current round (null: none) */
	#sentBase: string | null = null;

	constructor(options: PeerSessionOptions) {
		this.#options = options;
	}

	get peer(): DeviceInfo | null {
		return this.#peer;
	}

	/** Starts the session: both sides introduce themselves first. */
	start(): void {
		if (this.#started) return;
		this.#started = true;
		const { self } = this.#options;
		this.#options.send({ type: 'hello', protocol: SYNC_PROTOCOL, format: FORMAT_VERSION, device: self });
	}

	/** The connection is gone: nothing more is handled (nor saved). */
	close(): void {
		this.#closed = true;
	}

	receive(message: SyncMessage): void {
		// (introduce ourselves before answering anything, whatever the order of events)
		this.start();
		this.#queue = this.#queue.then(() => this.#handle(message)).catch((e: unknown) => this.#fail(e instanceof Error ? e : new Error(String(e))));
	}

	/** This device's data changed (an edit, or another device): pass it on. */
	localChanged(): void {
		if (this.#failed || this.#closed || !this.#peer) return;
		if (this.#options.merger) this.#options.send({ type: 'changed' });
		else this.#queue = this.#queue.then(() => this.#startRound()).catch((e: unknown) => this.#fail(e instanceof Error ? e : new Error(String(e))));
	}

	#fail(error: Error): void {
		if (this.#failed) return;
		this.#failed = true;
		if (!(error instanceof RemoteError)) this.#options.send({ type: 'error', message: error.message });
		this.#options.onFailed?.(error);
	}

	async #handle(message: SyncMessage): Promise<void> {
		if (this.#failed || this.#closed) return;
		if (message.type === 'error') throw new RemoteError(`The other device stopped syncing: ${message.message}`);
		if (message.type === 'hello') return this.#hello(message);
		if (!this.#peer) throw new SyncError('The other device did not introduce itself.');
		const { merger } = this.#options;
		switch (message.type) {
			case 'state':
				if (!merger) throw new SyncError('Unexpected state message.');
				return this.#merge(message.base, message.data);
			case 'resend':
				if (merger || !this.#inRound) throw new SyncError('Unexpected resend message.');
				return this.#sendState(true);
			case 'result':
				if (merger || !this.#inRound) throw new SyncError('Unexpected result message.');
				return this.#applyResult(message.hash, message.data);
			case 'changed':
				if (merger) throw new SyncError('Unexpected changed message.');
				return this.#startRound();
		}
	}

	async #hello(message: SyncMessage & { type: 'hello' }): Promise<void> {
		if (this.#peer) throw new SyncError('The other device introduced itself twice.');
		if (message.device.id !== this.#options.peerId) throw new SyncError("The other device's identity doesn't match its key.");
		if (message.protocol !== SYNC_PROTOCOL) throw new SyncError(`${message.device.name} runs another version of Discipline. Update both.`);
		if (message.format !== FORMAT_VERSION) throw new SyncError(`${message.device.name} uses another data format (${message.format}). Update both.`);
		this.#peer = message.device;
		// the client starts with a round, so both sides catch up right after connecting
		if (!this.#options.merger) await this.#startRound();
	}

	// ---------------------------------------------------------------- client

	async #startRound(): Promise<void> {
		if (this.#closed) return;
		if (this.#inRound) {
			this.#again = true;
			return;
		}
		this.#inRound = true;
		this.#again = false;
		await this.#sendState(false);
	}

	/** `full`: send the data even if it equals the base (the merger doesn't have our base) */
	async #sendState(full: boolean): Promise<void> {
		const peer = this.#peer!;
		const { working, base } = await this.#options.store.transact(peer.id, (working, base) => ({ working, base, value: { working, base } }));
		this.#sent = working;
		this.#sentBase = base?.hash ?? null;
		const unchanged = !full && base !== null && (base.data === working || base.hash === hashOf(working));
		this.#options.send({ type: 'state', base: base?.hash ?? null, data: unchanged ? null : textOf(working) });
	}

	async #applyResult(hash: string, data: string | null): Promise<void> {
		const peer = this.#peer!;
		const sent = this.#sent!;
		const result = data === null ? sent : parseData(data);
		const base = baseOf(result);
		if (base.hash !== hash) throw new SyncError("The other device's result didn't arrive intact.");
		type Outcome = { changes: ChangeSummary; conflicts: number; again: boolean } | 'outdated' | null;
		const report = await this.#options.store.transact<Outcome>(peer.id, (working, stored) => {
			if (this.#closed) return { working, base: stored, value: null };
			// the base changed meanwhile (the data here was cleared, or the device unpaired): the result
			// no longer fits; merged with the working copy it would delete what's gone here everywhere
			if ((stored?.hash ?? null) !== this.#sentBase) return { working, base: stored, value: 'outdated' };
			// edits made here since the state was sent are merged on top of the result
			const merged = working === sent ? null : merge(sent, working, result);
			const next = merged ? merged.data : result;
			const unchanged = sameData(next, working);
			return {
				working: unchanged ? working : next,
				base,
				value: { changes: summarizeChanges(working, unchanged ? working : next), conflicts: merged ? conflictCount(merged) : 0, again: merged !== null && !sameData(next, result) },
			};
		});
		if (report === null) return;
		this.#inRound = false;
		this.#sent = null;
		// (a new round names the base there is now: the merger then merges without deleting anything)
		if (report === 'outdated') return this.#startRound();
		this.#options.onSynced?.({ peer, changes: report.changes, conflicts: report.conflicts });
		if (report.again || this.#again) await this.#startRound();
	}

	// ---------------------------------------------------------------- merger

	async #merge(baseHash: string | null, data: string | null): Promise<void> {
		const peer = this.#peer!;
		const theirsSent = data === null ? null : parseData(data);
		const outcome = await this.#options.store.transact(peer.id, (working, stored) => {
			// (closed meanwhile: don't save a base for a result nobody receives)
			if (this.#closed) return { working, base: stored, value: undefined };
			const base = baseHash === null || stored === null ? null : stored.hash === baseHash ? stored : stored.previous?.hash === baseHash ? stored.previous : null;
			// "unchanged" only means something if we have the same base
			if (theirsSent === null && base === null) return { working, base: stored, value: null };
			const theirs = theirsSent ?? base!.data;
			// nothing changed on either side since the (current) base: nothing to merge
			if (base !== null && base === stored && sameData(theirs, base.data) && sameData(working, base.data)) {
				return { working, base: stored, value: { next: working, newBase: base, theirs, changes: summarizeChanges(working, working), conflicts: 0 } };
			}
			const merged = merge(base?.data ?? null, working, theirs);
			const next = sameData(merged.data, working) ? working : merged.data;
			// until the client names the new base, the one it named is still the common one
			const confirmed = base && { data: base.data, hash: base.hash };
			const newBase: StoredBase = { ...baseOf(next), previous: confirmed && confirmed.hash !== hashOf(next) ? confirmed : null };
			return {
				working: next,
				base: newBase,
				value: { next, newBase, theirs, changes: summarizeChanges(working, next), conflicts: conflictCount(merged) },
			};
		});
		if (outcome === undefined) return;
		if (outcome === null) {
			this.#options.send({ type: 'resend' });
			return;
		}
		const { next, newBase, theirs, changes, conflicts } = outcome;
		this.#options.send({ type: 'result', hash: newBase.hash, data: sameData(next, theirs) ? null : textOf(next) });
		this.#options.onSynced?.({ peer, changes, conflicts });
	}
}

/** The other side reported an error (not sent back to it). */
class RemoteError extends SyncError {}
