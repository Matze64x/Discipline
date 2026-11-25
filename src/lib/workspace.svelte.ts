/**
 * The app's data: the working copy plus its sync state, persisted in the browser storage (also in
 * the desktop app, whose window is a browser engine).
 *
 * Every change goes through `#commit`, which saves first and only then updates what's shown, so
 * the screen never shows data that isn't stored. A failed save throws and changes nothing.
 *
 * Exchanging data with a Discipline file, in the browser and the desktop app alike: importing one
 * adds its records (preview first, can be undone; see `core/sync.ts`), exporting hands the data out
 * as a file. The desktop app can also keep a backup file (`settings.backupPath`): written a few
 * seconds after each change and when the window closes, never read back by itself (restoring it is
 * an import). Files are only written if they read back, and always atomically.
 */
import {
	EMPTY_DATA,
	hashText,
	nowUtcSeconds,
	parseDiscipline,
	planImport,
	serializeDiscipline,
	type DisciplineData,
	type ImportPlan,
	type Issue,
	type StoredBase,
	type SyncStore,
	type UtcSeconds,
} from '../core';
import * as desktop from './desktop';
import { errorMessage } from './errors';
import { saveFile } from './files';
import { settings } from './settings.svelte';
import { deleteBase, loadBase, loadWorkspace, requestPersistentStorage, saveWorkspace, StaleWorkspaceError, watchWorkspace, type StoredBaseText, type StoredSnapshot } from './storage';

const DEFAULT_FILE_NAME = 'discipline.json';
/** How long the backup waits after a change, so a burst of edits writes it once */
const BACKUP_DELAY_MS = 3000;

interface Snapshot {
	readonly working: DisciplineData;
	/** The file last imported or exported, to suggest its name for the next export */
	readonly fileName: string | null;
}

export interface ImportSource {
	readonly fileName: string;
	/** The data the plan was made from; applying is refused if the data changed since */
	readonly from: DisciplineData;
}

export type ImportCandidate =
	| (ImportSource & { readonly ok: true; readonly plan: ImportPlan; readonly warnings: readonly Issue[] })
	| (ImportSource & { readonly ok: false; readonly errors: readonly Issue[] });

function parseStored(text: string): DisciplineData {
	const result = parseDiscipline(text);
	if (result.ok) return result.data;
	const [first] = result.errors;
	throw new Error(`The data stored in this browser is damaged (${first?.path || 'file'}: ${first?.message}).`);
}

/**
 * The file text of data, serialized once per data object (they're never changed): each save stores
 * the working copy, base and export as text, and only the working copy is new after an edit.
 */
const serialized = new WeakMap<DisciplineData, string>();
function serialize(data: DisciplineData): string {
	let text = serialized.get(data);
	if (text === undefined) serialized.set(data, (text = serializeDiscipline(data)));
	return text;
}

/** The file text, after making sure it reads back: a file is never written if it couldn't be opened again. */
function fileText(data: DisciplineData): string {
	const text = serialize(data);
	if (!parseDiscipline(text).ok) throw new Error("The file wasn't written: it wouldn't read back correctly. Please report this.");
	return text;
}

function toStored({ working, fileName }: Snapshot): StoredSnapshot {
	return { working: serialize(working), fileName };
}

function fromStored(stored: StoredSnapshot): Snapshot {
	return { working: parseStored(stored.working), fileName: stored.fileName };
}

/**
 * Formats loaded data once while the browser is idle: saving after the first edit then only
 * formats what changed (with years of data, the whole text takes a noticeable moment on a phone).
 */
function prepareSaving(...data: (DisciplineData | undefined)[]): void {
	const run = () => data.forEach((d) => d && serialize(d));
	// (not before the app has shown the data: an idle moment comes even before that)
	setTimeout(() => (typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 2000 }) : run()), 1000);
}

interface UndoEntry {
	readonly before: DisciplineData;
	readonly after: DisciplineData;
	readonly label: string;
}

/** A change of the working copy: `peer` is the device a sync came from (null: an edit, an import, another tab) */
export type ChangeListener = (peer: string | null) => void;

export class Workspace implements SyncStore {
	readonly isDesktop = desktop.isDesktop;

	// $state.raw: snapshots are replaced as a whole, never mutated, so deep reactivity isn't needed
	#current = $state.raw<Snapshot>({ working: EMPTY_DATA, fileName: null });
	#beforeImport = $state.raw<Snapshot | null>(null);
	ready = $state(false);
	/** Increases whenever another tab changed the data and it was reloaded */
	revision = $state(0);
	/** Desktop app: why the last backup failed (null: it worked, or there is none) */
	backupError = $state<string | null>(null);

	readonly data = $derived(this.#current.working);
	readonly fileName = $derived(this.#current.fileName);
	readonly canUndoImport = $derived(this.#beforeImport !== null);

	/**
	 * Edits that can be undone (Mod+Z) and redone. Only valid while the data hasn't changed otherwise
	 * (import, another tab): then the labels are null and undo/redo clear the stacks.
	 */
	#undo = $state.raw<readonly UndoEntry[]>([]);
	#redo = $state.raw<readonly UndoEntry[]>([]);
	readonly undoLabel = $derived(this.#undo.at(-1)?.after === this.#current.working ? this.#undo.at(-1)!.label : null);
	readonly redoLabel = $derived(this.#redo.at(-1)?.before === this.#current.working ? this.#redo.at(-1)!.label : null);

	/** Changes run one at a time, so they can't interleave */
	#queue: Promise<unknown> = Promise.resolve();
	#backupTimer: ReturnType<typeof setTimeout> | undefined;
	/** The working copy last written to the backup file (in memory: each start writes it once) */
	#backedUp: DisciplineData | null = null;
	/** The bases loaded so far (see `core/peer-sync.ts`), by peer; null: none stored */
	#bases = new Map<string, StoredBase | null>();
	#listeners = new Set<ChangeListener>();
	/** The stored revision this tab loaded or saved last (see `saveWorkspace`) */
	#savedRevision = 0;

	/** Loads the stored data. Throws if storage is unavailable or the data is damaged. */
	async load(): Promise<void> {
		const stored = await loadWorkspace();
		this.#savedRevision = stored?.revision ?? 0;
		if (stored) {
			this.#current = fromStored(stored.current);
			try {
				this.#beforeImport = stored.beforeImport && fromStored(stored.beforeImport);
			} catch {
				// a damaged undo snapshot must not prevent loading the data itself
				this.#beforeImport = null;
			}
			prepareSaving(this.#current.working, this.#beforeImport?.working);
		}
		this.ready = true;
	}

	/** Loads the data and keeps it up to date with other tabs; the desktop app backs it up before closing. Throws only if the data can't be loaded. */
	async start(): Promise<() => void> {
		void requestPersistentStorage();
		await this.load();
		const stopWatchingTabs = watchWorkspace(() => this.#serial(() => this.#reload()));
		let stopWatchingClose = () => {};
		if (this.isDesktop) {
			stopWatchingClose = await desktop.onWindowClose(() => this.flushBackup());
			// catches up on changes the last run couldn't back up (e.g. it was killed)
			this.#scheduleBackup();
		}
		return () => {
			stopWatchingTabs();
			stopWatchingClose();
			clearTimeout(this.#backupTimer);
		};
	}

	// ------------------------------------------------------------------ import and export

	/** Plans merging a file into the working copy; nothing changes until `applyImport`. */
	planImport(fileName: string, text: string): ImportCandidate {
		const source = { fileName, from: this.#current.working };
		const result = parseDiscipline(text);
		if (!result.ok) return { ...source, ok: false, errors: result.errors };
		return { ...source, ok: true, plan: planImport(source.from, result.data), warnings: result.warnings };
	}

	/** Desktop app: lets the user pick a file and plans importing it. Null if cancelled. */
	async chooseImport(): Promise<ImportCandidate | null> {
		const path = await desktop.chooseExistingFile('Import a Discipline file');
		return path ? this.planImport(desktop.fileNameOf(path), await desktop.readFile(path)) : null;
	}

	/** Applies a planned import; it can be undone until the next change. */
	applyImport(candidate: ImportCandidate & { ok: true }): Promise<void> {
		return this.#serial(async () => {
			if (this.#current.working !== candidate.from) throw new Error('Your data changed in the meantime. Please try again.');
			await this.#commit({ working: candidate.plan.next, fileName: candidate.fileName }, this.#current);
		});
	}

	undoImport(): Promise<void> {
		return this.#serial(async () => {
			if (this.#beforeImport) await this.#commit(this.#beforeImport, null);
		});
	}

	/**
	 * Hands the working copy to the user as a file: in the browser as a download or via the share
	 * sheet (it must start right from the click: browsers block it after an await), in the desktop
	 * app saved where the user chooses. Returns false if cancelled.
	 */
	async exportFile(): Promise<boolean> {
		const handedOut = this.#current.working;
		const name = this.#current.fileName ?? DEFAULT_FILE_NAME;
		if (this.isDesktop) {
			const path = await desktop.chooseFileToSave('Export a Discipline file', name);
			if (!path) return false;
			// (in the queue: no other write, e.g. the backup, can run at the same time)
			await this.#serial(async () => {
				await desktop.writeFile(path, fileText(handedOut));
				await this.#rememberFileName(desktop.fileNameOf(path));
			});
			return true;
		}
		if (!(await saveFile(fileText(handedOut), name))) return false;
		await this.#serial(() => this.#rememberFileName(name));
		return true;
	}

	/** The name suggested for the next export. Must run inside `#serial`. */
	async #rememberFileName(fileName: string): Promise<void> {
		if (this.#current.fileName !== fileName) await this.#commit({ ...this.#current, fileName }, this.#beforeImport);
	}

	// ------------------------------------------------------------------ desktop: backup file

	/** Sets (or, with null, turns off) the backup file; a new one is written right away. */
	async setBackupPath(path: string | null): Promise<void> {
		settings.backupPath = path;
		this.#backedUp = null;
		this.backupError = null;
		clearTimeout(this.#backupTimer);
		if (path) await this.backupNow();
	}

	/** Writes the backup file now (if there is one). A failure shows in `backupError`, and is retried on the next change. */
	backupNow(): Promise<void> {
		clearTimeout(this.#backupTimer);
		this.#backupTimer = undefined;
		return this.#serial(async () => {
			const path = settings.backupPath;
			if (!this.isDesktop || !path) return;
			const data = this.#current.working;
			if (data === this.#backedUp) return;
			try {
				await desktop.writeFile(path, fileText(data));
				this.#backedUp = data;
				this.backupError = null;
			} catch (e) {
				this.backupError = errorMessage(e);
			}
		});
	}

	/** Waits until the changes made so far are saved (e.g. before the app reloads) */
	async settled(): Promise<void> {
		// (a task can queue another one: wait until nothing new was queued)
		let queue;
		do {
			queue = this.#queue;
			await queue.catch(() => undefined);
		} while (queue !== this.#queue);
	}

	/** Writes a pending backup right away (e.g. the window is closing). */
	async flushBackup(): Promise<void> {
		// a change still being saved schedules its backup only when it's done: wait for it
		await this.#queue;
		if (this.#backupTimer !== undefined) await this.backupNow();
	}

	#scheduleBackup(): void {
		if (!this.isDesktop || !settings.backupPath) return;
		clearTimeout(this.#backupTimer);
		this.#backupTimer = setTimeout(() => void this.backupNow(), BACKUP_DELAY_MS);
	}

	// ------------------------------------------------------------------ editing

	/**
	 * Applies an edit (a pure function from `core/edit.ts`) to the working copy and saves it.
	 * `label` describes it for undo, e.g. 'Delete “Rent”' (`undoable` false: not offered for undo,
	 * e.g. a change the app makes by itself). Throws (and changes nothing) if the edit is invalid.
	 */
	edit(label: string, change: (data: DisciplineData, now: UtcSeconds) => DisciplineData, { undoable = true } = {}): Promise<void> {
		return this.#serial(async () => {
			const before = this.#current.working;
			const after = change(before, nowUtcSeconds());
			if (after === before) return;
			await this.#replaceWorking(after);
			if (!undoable) return;
			this.#undo = [...this.#undo.slice(-49), { before, after, label }];
			this.#redo = [];
		});
	}

	/** Undoes the last edit. Returns its label, or null if there's nothing (valid) to undo. */
	undo(): Promise<string | null> {
		return this.#serial(async () => {
			const last = this.#undo.at(-1);
			if (!last) return null;
			// an import changed the data since: undoing would also revert that, so don't
			if (this.#current.working !== last.after) {
				this.#undo = [];
				this.#redo = [];
				return null;
			}
			await this.#replaceWorking(last.before);
			this.#undo = this.#undo.slice(0, -1);
			this.#redo = [...this.#redo, last];
			return last.label;
		});
	}

	redo(): Promise<string | null> {
		return this.#serial(async () => {
			const next = this.#redo.at(-1);
			if (!next || this.#current.working !== next.before) {
				this.#redo = [];
				return null;
			}
			await this.#replaceWorking(next.after);
			this.#redo = this.#redo.slice(0, -1);
			this.#undo = [...this.#undo, next];
			return next.label;
		});
	}

	/** Must run inside `#serial`. An edit invalidates "undo import" (it would discard the edit). */
	async #replaceWorking(working: DisciplineData): Promise<void> {
		await this.#commit({ ...this.#current, working }, null);
	}

	// ------------------------------------------------------------------ syncing with other devices

	/** Calls `listener` after each change of the working copy. Returns a function to stop. */
	onChange(listener: ChangeListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(peer: string | null): void {
		for (const listener of this.#listeners) listener(peer);
	}

	current(): DisciplineData {
		return this.#current.working;
	}

	/** `SyncStore`: a sync's change of the working copy and the peer's base, saved in one transaction. */
	transact<T>(peer: string, change: (working: DisciplineData, base: StoredBase | null) => { working: DisciplineData; base: StoredBase | null; value: T }): Promise<T> {
		return this.#serial(async () => {
			const base = await this.#base(peer);
			const before = this.#current.working;
			const result = change(before, base);
			const workingChanged = result.working !== before;
			const baseChanged = result.base !== base;
			if (workingChanged || baseChanged) {
				const previous = result.base?.previous;
				const stored: StoredBaseText | null = result.base && {
					text: serialize(result.base.data),
					hash: result.base.hash,
					previous: previous ? { text: serialize(previous.data), hash: previous.hash } : null,
				};
				// a sync's change invalidates "undo import" like an edit does
				await this.#commit({ ...this.#current, working: result.working }, workingChanged ? null : this.#beforeImport, baseChanged ? { peer, value: stored } : undefined, peer);
				this.#bases.set(peer, result.base);
			}
			return result.value;
		});
	}

	async #base(peer: string): Promise<StoredBase | null> {
		const cached = this.#bases.get(peer);
		if (cached !== undefined) return cached;
		const stored = await loadBase(peer);
		// a damaged or outdated base only means merging without one (nothing counts as deleted)
		const read = (text: string, hash: string) => {
			const result = parseDiscipline(text);
			return result.ok && hashText(text) === hash ? { data: result.data, hash } : null;
		};
		let base: StoredBase | null = null;
		if (stored) {
			const current = read(stored.text, stored.hash);
			if (current) base = { ...current, previous: stored.previous ? read(stored.previous.text, stored.previous.hash) : null };
		}
		this.#bases.set(peer, base);
		return base;
	}

	/** Reloads what another tab saved. Must run inside `#serial`. */
	async #reload(): Promise<void> {
		const before = this.#current.working;
		await this.load();
		// (another tab may have synced too)
		this.#bases.clear();
		this.revision++;
		if (this.#current.working !== before) this.#emit(null);
	}

	/** Forgets what was last agreed on with a device (it was unpaired). */
	forgetPeer(peer: string): Promise<void> {
		return this.#serial(async () => {
			await deleteBase(peer);
			this.#bases.delete(peer);
		});
	}

	/**
	 * Runs a task after the ones before it. If another tab saved in between (`StaleWorkspaceError`),
	 * reloads its data and runs the task again on it, so neither tab's change is lost.
	 */
	#serial<T>(task: () => Promise<T>): Promise<T> {
		const attempt = async (): Promise<T> => {
			for (let tries = 1; ; tries++) {
				try {
					return await task();
				} catch (e) {
					if (!(e instanceof StaleWorkspaceError) || tries >= 3) throw e;
					await this.#reload();
				}
			}
		};
		const run = this.#queue.then(attempt, attempt);
		this.#queue = run.catch(() => undefined);
		return run;
	}

	/**
	 * Saves and then shows a new state. `beforeImport` is what "Undo import" restores; any change
	 * other than an import or export (e.g. editing) must pass null, so undo can't discard it.
	 */
	async #commit(next: Snapshot, beforeImport: Snapshot | null, base?: { peer: string; value: StoredBaseText | null }, cause: string | null = null): Promise<void> {
		this.#savedRevision = await saveWorkspace({ current: toStored(next), beforeImport: beforeImport && toStored(beforeImport) }, this.#savedRevision, base);
		const changed = next.working !== this.#current.working;
		this.#current = next;
		this.#beforeImport = beforeImport;
		if (changed) {
			this.#scheduleBackup();
			this.#emit(cause);
		}
	}
}
