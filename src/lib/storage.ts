/** Persists the workspace in the browser (IndexedDB), as file-format text. */
import { createStore, del, get, promisifyRequest } from 'idb-keyval';

// idb-keyval's default database and store, opened explicitly to write several keys in one transaction
const store = createStore('keyval-store', 'keyval');

export interface StoredSnapshot {
	readonly working: string;
	readonly fileName: string | null;
}

export interface StoredWorkspace {
	readonly current: StoredSnapshot;
	/** The state before the last import, to undo it */
	readonly beforeImport: StoredSnapshot | null;
	/** Counts the saves, so a tab can tell that another one saved since it loaded (missing: 0) */
	readonly revision?: number;
}

/** Another tab saved the workspace since this one loaded it: reload and try again. */
export class StaleWorkspaceError extends Error {
	constructor() {
		super('Another tab changed the data at the same time. Please try again.');
	}
}

const KEY = 'discipline-workspace-v1';

// One channel for sending and receiving: a channel doesn't receive its own messages, so a tab is
// only told about saves of other tabs (a second channel object in the same tab would hear them).
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('discipline-workspace');

/** The data last agreed on with another device (see `core/peer-sync.ts`), as file-format text */
export interface StoredBaseText {
	readonly text: string;
	readonly hash: string;
	/** The merger's base before this one, until the other device confirms this one */
	readonly previous?: { readonly text: string; readonly hash: string } | null;
}

const BASE_PREFIX = 'discipline-base-v1:';
const baseKey = (peer: string) => `${BASE_PREFIX}${peer}`;

export async function loadWorkspace(): Promise<StoredWorkspace | undefined> {
	return get<StoredWorkspace>(KEY, store);
}

export async function loadBase(peer: string): Promise<StoredBaseText | undefined> {
	return get<StoredBaseText>(baseKey(peer), store);
}

/**
 * Saves the workspace and, if given, another device's base (null: delete it; 'forget all': delete
 * every device's base) in one transaction: either both are saved or neither. `revision` is the one this tab loaded or saved last: if another
 * tab saved since, nothing is saved and it throws `StaleWorkspaceError` (else one tab's save would
 * silently overwrite the other's). Returns the new revision. Tells other open tabs, so they reload.
 */
export async function saveWorkspace(
	workspace: Omit<StoredWorkspace, 'revision'>,
	revision: number,
	base?: { peer: string; value: StoredBaseText | null } | 'forget all',
): Promise<number> {
	/** Why the transaction was aborted here (else the browser reports only "aborted") */
	let failure: unknown = null;
	await store('readwrite', (s) => {
		const request = s.get(KEY);
		request.onsuccess = () => {
			try {
				if (((request.result as StoredWorkspace | undefined)?.revision ?? 0) !== revision) throw new StaleWorkspaceError();
				s.put({ ...workspace, revision: revision + 1 } satisfies StoredWorkspace, KEY);
				if (base === 'forget all') {
					const keys = s.getAllKeys();
					keys.onsuccess = () => {
						for (const key of keys.result) if (typeof key === 'string' && key.startsWith(BASE_PREFIX)) s.delete(key);
					};
				} else if (base) {
					if (base.value) s.put(base.value, baseKey(base.peer));
					else s.delete(baseKey(base.peer));
				}
			} catch (e) {
				failure = e;
				s.transaction.abort();
			}
		};
		return promisifyRequest(s.transaction).catch((e: unknown) => {
			throw failure ?? e;
		});
	});
	channel?.postMessage('saved');
	return revision + 1;
}

/** Forgets another device's base (when it's unpaired). */
export async function deleteBase(peer: string): Promise<void> {
	await del(baseKey(peer), store);
}

/** Calls `onChange` when another tab saved the workspace. Returns a function to stop listening. */
export function watchWorkspace(onChange: () => void): () => void {
	channel?.addEventListener('message', onChange);
	return () => channel?.removeEventListener('message', onChange);
}

/** Asks the browser not to evict the data under storage pressure (iOS evicts unused site data). */
export async function requestPersistentStorage(): Promise<void> {
	await navigator.storage?.persist?.().catch(() => undefined);
}
