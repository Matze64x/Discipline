/**
 * Importing a file (manual restore, e.g. from a backup), platform-independent.
 *
 * An import only adds: records the app doesn't have are added, records with the same id are merged
 * (the later edit wins, as in `merge`), and deletions never carry over, since there is no common
 * base to tell a deletion from a record that was never there. Syncing between devices (which does
 * carry deletions) keeps a merge base per device instead.
 */
import { deepEqual } from './equal';
import { byKey, merge, RECORD_KEYS, type MergeResult } from './merge';
import { EMPTY_DATA, type DisciplineData } from './model';

export interface ChangeCounts {
	readonly added: number;
	readonly changed: number;
	readonly deleted: number;
}

export type ChangeSummary = { readonly [K in keyof typeof RECORD_KEYS]: ChangeCounts } & {
	/** Whether the day or week start changed */
	readonly preferences: boolean;
};

const KINDS = Object.keys(RECORD_KEYS) as (keyof typeof RECORD_KEYS)[];

/** Records of one kind by key, for all kinds at once. */
function keyed(data: DisciplineData) {
	return {
		habits: byKey(RECORD_KEYS.habits, data.habits),
		entries: byKey(RECORD_KEYS.entries, data.entries),
	} as const satisfies { [K in keyof typeof RECORD_KEYS]: Map<string, unknown> };
}

/** What changed from `before` to `after`, counted per record. */
export function summarizeChanges(before: DisciplineData | null, after: DisciplineData): ChangeSummary {
	const [b, a] = [keyed(before ?? EMPTY_DATA), keyed(after)];
	const count = (bm: Map<string, unknown>, am: Map<string, unknown>): ChangeCounts => ({
		added: [...am.keys()].filter((k) => !bm.has(k)).length,
		changed: [...am].filter(([k, r]) => bm.has(k) && !deepEqual(bm.get(k), r)).length,
		deleted: [...bm.keys()].filter((k) => !am.has(k)).length,
	});
	const [bp, ap] = [(before ?? EMPTY_DATA).preferences, after.preferences];
	return { habits: count(b.habits, a.habits), entries: count(b.entries, a.entries), preferences: bp.dayStart !== ap.dayStart || bp.weekStart !== ap.weekStart };
}

export function totalChanges(summary: ChangeSummary): number {
	return KINDS.reduce((sum, kind) => sum + summary[kind].added + summary[kind].changed + summary[kind].deleted, 0) + (summary.preferences ? 1 : 0);
}

export type ImportWarning =
	/** Both have habits, but not one in common: probably a different person's or a test file */
	'unrelated-file';

export interface ImportPlan {
	readonly merge: MergeResult;
	/** What the import changes in the working copy (nothing is ever deleted) */
	readonly changes: ChangeSummary;
	/** Signs that this is probably not the right file; the UI should ask before applying */
	readonly warnings: readonly ImportWarning[];
	/** The working copy after applying the import */
	readonly next: DisciplineData;
}

/** Plans importing a file's content (`theirs`) into the working copy; nothing is applied yet. */
export function planImport(working: DisciplineData, theirs: DisciplineData): ImportPlan {
	const result = merge(null, working, theirs);
	const known = new Set(working.habits.map((h) => h.id));
	const unrelated = known.size > 0 && theirs.habits.length > 0 && !theirs.habits.some((h) => known.has(h.id));
	return {
		merge: result,
		changes: summarizeChanges(working, result.data),
		warnings: unrelated ? ['unrelated-file'] : [],
		next: result.data,
	};
}
