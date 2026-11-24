/**
 * Three-way merge of two versions of the data that were edited independently (e.g. on the phone
 * and on a PC), relative to the last version both had in common. Adapted from CashGuard's merge.
 *
 * Records are matched by key: habits by id, entries by habit and day. For every record:
 * - same on both sides             -> keep it
 * - changed on one side only       -> take that change (including adding or deleting it)
 * - changed differently on both    -> the later `edited` timestamp wins; reported as a conflict.
 *                                     An entry with the same value on both sides (e.g. checked off
 *                                     on both) is no conflict. A habit's parts merge separately
 *                                     (`HABIT_PARTS`: name, color, what's tracked (kind, unit,
 *                                     goals), position, archive day): a part changed on one side
 *                                     only is kept, and only a part changed differently on both is
 *                                     decided (and reported); for the archive day both archived:
 *                                     the earlier day, no conflict.
 * - deleted on one side, changed   -> keep the changed version; reported as a conflict
 *   on the other
 * Timestamps can tie: then a fixed order of the contents decides. So the merged data doesn't
 * depend on which device merges, and merging the result again with either side changes nothing.
 *
 * Afterwards:
 * - a habit that was deleted on one side but has new or changed entries on the other is
 *   restored, and reported
 * - a habit kept although one side deleted it (restored, or changed on the other side) keeps all
 *   the other side's entries: the deletion took them along only because of the habit
 * - a check habit with amounts in the result (one side turned an amount habit into a check habit,
 *   the other entered amounts) gets the amount version's kind, unit and goals back, and is reported
 * Habits carry one `edited` time: the later of both sides'. So with three devices, which of two
 * changes to a part wins can depend on the order of syncing (all devices still end up the same).
 *
 * Without a common base nothing counts as deleted: both versions are combined.
 *
 * Inputs must be valid on their own (as produced by `parseDiscipline` or `edit.ts`).
 */
import { canonicalString, deepEqual } from './equal';
import type { Id } from './ids';
import { compareEntries, compareHabits, EMPTY_DATA, entryKey, type DisciplineData, type Entry, type Habit } from './model';

export type ConflictReason = 'changed-on-both-sides' | 'deleted-and-changed' | 'deleted-habit-in-use' | 'amounts-for-check-habit';

export interface Conflict<T> {
	readonly reason: ConflictReason;
	/** The record's key (see `RECORD_KEYS`) */
	readonly key: string;
	/** The versions of the record; `undefined` where it doesn't exist (not yet, or deleted) */
	readonly base: T | undefined;
	readonly ours: T | undefined;
	readonly theirs: T | undefined;
	/** The version in the result */
	readonly kept: T;
}

export interface MergeResult {
	readonly data: DisciplineData;
	readonly conflicts: {
		readonly habits: readonly Conflict<Habit>[];
		readonly entries: readonly Conflict<Entry>[];
	};
}

interface RecordKind<T> {
	/** One unique key per record, in the same order */
	keys(records: readonly T[]): string[];
	/** Positive if `a` was edited later than `b`, negative if earlier, 0 if equal. */
	compareEdited(a: T, b: T): number;
	/**
	 * Two different versions of a record combined, and whether that decided a conflict; null to
	 * take the newer version as a whole (a conflict).
	 */
	combine?: (base: T | undefined, ours: T, theirs: T) => { value: T; conflict: boolean } | null;
}

/** Orders two different versions (or parts of them): positive if `a` wins (the later edit, else a fixed order of the contents) */
function compareVersions(byTime: number, a: unknown, b: unknown): number {
	if (byTime !== 0) return byTime;
	return canonicalString(a) > canonicalString(b) ? 1 : -1;
}

function newer<T>(kind: RecordKind<T>, a: T, b: T): T {
	return compareVersions(kind.compareEdited(a, b), a, b) > 0 ? a : b;
}

function mergeRecords<T>(kind: RecordKind<T>, base: readonly T[], ours: readonly T[], theirs: readonly T[]): { merged: T[]; conflicts: Conflict<T>[] } {
	// if one side didn't change anything, the other side is the result, exactly
	if (deepEqual(base, theirs)) return { merged: [...ours], conflicts: [] };
	if (deepEqual(base, ours)) return { merged: [...theirs], conflicts: [] };

	const [baseMap, oursMap, theirsMap] = [base, ours, theirs].map((records) => byKey(kind.keys, records)) as [Map<string, T>, Map<string, T>, Map<string, T>];
	const keys = new Set([...oursMap.keys(), ...theirsMap.keys()]);
	const merged: T[] = [];
	const conflicts: Conflict<T>[] = [];
	for (const key of keys) {
		const [b, o, t] = [baseMap.get(key), oursMap.get(key), theirsMap.get(key)];
		let kept: T | undefined;
		let reason: ConflictReason | undefined;
		if (deepEqual(o, t) || deepEqual(b, t)) kept = o;
		else if (deepEqual(b, o)) kept = t;
		else if (o === undefined || t === undefined) [kept, reason] = [(o ?? t)!, 'deleted-and-changed'];
		else {
			const combined = kind.combine?.(b, o, t);
			if (combined) [kept, reason] = [combined.value, combined.conflict ? 'changed-on-both-sides' : undefined];
			else [kept, reason] = [newer(kind, o, t), 'changed-on-both-sides'];
		}
		if (kept !== undefined) merged.push(kept);
		if (reason) conflicts.push({ reason, key, base: b, ours: o, theirs: t, kept: kept! });
	}
	return { merged, conflicts };
}

/** How records of each kind are matched between versions: one unique key per record, in order. */
export const RECORD_KEYS = {
	habits: (hs: readonly Habit[]): string[] => hs.map((h) => h.id),
	entries: (es: readonly Entry[]): string[] => es.map(entryKey),
};

/** Records by key, see `RECORD_KEYS` */
export function byKey<T>(keys: (records: readonly T[]) => string[], records: readonly T[]): Map<string, T> {
	const k = keys(records);
	return new Map(records.map((r, i) => [k[i]!, r]));
}

/** The parts of a habit that change independently (`id` and `edited` aside) */
const HABIT_PARTS = {
	name: (h: Habit) => h.name,
	color: (h: Habit) => h.color,
	// what's tracked: these only make sense together
	tracked: (h: Habit) => ({ kind: h.kind, unit: h.unit, goals: h.goals }),
	position: (h: Habit) => h.position,
	archived: (h: Habit) => h.archived,
};

/**
 * A habit merged part by part: a part changed on one side only is taken from there; a part both
 * changed differently from the side edited later (else by content), except the archive day.
 * Edited: the later of both sides.
 */
function combineHabits(base: Habit | undefined, ours: Habit, theirs: Habit): { value: Habit; conflict: boolean } | null {
	if (!base) return null;
	const byTime = ours.edited - theirs.edited;
	let conflict = false;
	const part = <V>(get: (h: Habit) => V, settle?: (o: V, t: V) => V | undefined): V => {
		const [b, o, t] = [get(base), get(ours), get(theirs)];
		if (deepEqual(o, b)) return t;
		if (deepEqual(t, b) || deepEqual(o, t)) return o;
		const settled = settle?.(o, t);
		if (settled !== undefined) return settled;
		conflict = true;
		return compareVersions(byTime, o, t) > 0 ? o : t;
	};
	const tracked = part(HABIT_PARTS.tracked);
	const value: Habit = {
		id: ours.id,
		name: part(HABIT_PARTS.name),
		kind: tracked.kind,
		unit: tracked.unit,
		goals: tracked.goals,
		color: part(HABIT_PARTS.color),
		position: part(HABIT_PARTS.position),
		// archived on both sides from different days: from the earlier one
		archived: part(HABIT_PARTS.archived, (o, t) => (o !== null && t !== null ? (o < t ? o : t) : undefined)),
		edited: Math.max(ours.edited, theirs.edited) as Habit['edited'],
	};
	return { value, conflict };
}

/** Entries with the same value on both sides (e.g. checked off on both): no conflict, the later stays */
function combineEntries(_: Entry | undefined, ours: Entry, theirs: Entry): { value: Entry; conflict: boolean } | null {
	return ours.value === theirs.value ? { value: newer(ENTRIES, ours, theirs), conflict: false } : null;
}

const HABITS: RecordKind<Habit> = { keys: RECORD_KEYS.habits, compareEdited: (a, b) => a.edited - b.edited, combine: combineHabits };
const ENTRIES: RecordKind<Entry> = { keys: RECORD_KEYS.entries, compareEdited: (a, b) => a.edited - b.edited, combine: combineEntries };

/**
 * Merges `ours` and `theirs`, which both derive from `base` (pass `null` if there is no common
 * version yet).
 */
export function merge(base: DisciplineData | null, ours: DisciplineData, theirs: DisciplineData): MergeResult {
	const b = base ?? EMPTY_DATA;
	const habits = mergeRecords(HABITS, b.habits, ours.habits, theirs.habits);
	const entries = mergeRecords(ENTRIES, b.entries, ours.entries, theirs.entries);

	const merged = new Map(habits.merged.map((h) => [h.id, h]));
	const find = (data: DisciplineData, id: Id) => data.habits.find((h) => h.id === id);
	const replaceConflict = (conflict: Conflict<Habit>) => {
		// this decides what's kept, so it replaces a conflict the habit may already have
		const earlier = habits.conflicts.findIndex((c) => c.key === conflict.key);
		if (earlier !== -1) habits.conflicts.splice(earlier, 1);
		habits.conflicts.push(conflict);
	};
	const versions = (id: Id) => ({ key: id, base: find(b, id), ours: find(ours, id), theirs: find(theirs, id) });

	// restore deleted habits that merged entries still belong to
	for (const e of entries.merged) {
		if (merged.has(e.habit)) continue;
		// every merged entry comes from ours or theirs, which had the habit
		const kept = find(ours, e.habit) ?? find(theirs, e.habit);
		if (!kept) throw new Error(`Habit ${e.habit} has entries but exists in neither version; the input is inconsistent`);
		merged.set(kept.id, kept);
		replaceConflict({ reason: 'deleted-habit-in-use', ...versions(kept.id), kept });
	}

	// a habit kept although one side deleted it keeps the other side's entries (the deleting side
	// removed them only along with the habit)
	const resultEntries = new Map(entries.merged.map((e) => [entryKey(e), e]));
	for (const id of merged.keys()) {
		if (!find(b, id)) continue;
		const [inOurs, inTheirs] = [find(ours, id) !== undefined, find(theirs, id) !== undefined];
		if (inOurs === inTheirs) continue;
		for (const e of (inOurs ? ours : theirs).entries) if (e.habit === id) resultEntries.set(entryKey(e), e);
	}

	// a check habit can't hold amounts: it gets the settings of a version that tracks amounts
	for (const e of resultEntries.values()) {
		const habit = merged.get(e.habit)!;
		if (habit.kind !== 'check' || e.value === 1) continue;
		const v = versions(habit.id);
		const amounts = [v.ours, v.theirs, v.base].find((h) => h?.kind === 'amount');
		const tracked = amounts ? { kind: amounts.kind, unit: amounts.unit, goals: amounts.goals } : { kind: 'amount' as const };
		// (merging the result again with either side gives the same: what's tracked is the base's or
		// the amount side's, so the check side's change applies again and is fixed up again alike)
		const kept: Habit = { ...habit, ...tracked };
		merged.set(kept.id, kept);
		replaceConflict({ reason: 'amounts-for-check-habit', ...v, kept });
	}

	return {
		data: { habits: [...merged.values()].sort(compareHabits), entries: [...resultEntries.values()].sort(compareEntries) },
		conflicts: { habits: habits.conflicts, entries: entries.conflicts },
	};
}
