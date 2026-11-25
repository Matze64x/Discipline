/**
 * Changes to the data, as pure functions (old data in, new data out). They keep the invariants the
 * file format and the merge rely on:
 * - new habits get fresh random ids; every entry's habit exists, at most one entry per habit and day
 * - names, units, goals, values, days and timestamps are valid (else `EditError`, nothing changes)
 * - `edited` is set on every change of a record, and only then; it never goes back (a device whose
 *   clock is behind still stamps its change as later than the version it changed)
 * - habits and entries stay sorted (`compareHabits`, `compareEntries`)
 * - an operation that changes nothing returns the same `data` object (so no undo step is recorded)
 * `now` is passed in, so callers (and tests) control the timestamps.
 */
import { isCivilDate, isUtcSeconds, type CivilDate, type UtcSeconds } from './dates';
import { deepEqual } from './equal';
import { newId, type Id } from './ids';
import {
	cleanText,
	compareEntries,
	compareHabits,
	goalOf,
	isColor,
	isDayStart,
	isEntryValue,
	isWeekStart,
	isPosition,
	isValidGoal,
	MAX_VALUE,
	latestGoal,
	startOf,
	type DatedGoal,
	type DisciplineData,
	type Entry,
	type Goal,
	type Habit,
	type HabitKind,
	type Preferences,
} from './model';

/** What the user edits of a habit: its settings, the latest goal and the day it starts. */
export interface HabitDraft {
	readonly name: string;
	readonly kind: HabitKind;
	readonly unit: string;
	readonly color: string;
	readonly start: CivilDate;
	readonly goal: Goal;
}

export class EditError extends Error {}

/** The draft of an existing habit, for its editor */
export function toDraft(habit: Habit): HabitDraft {
	return { name: habit.name, kind: habit.kind, unit: habit.unit, color: habit.color, start: startOf(habit), goal: goalOf(latestGoal(habit)) };
}

/** A typed amount rounded to what an entry can hold (3 decimals) */
export function roundValue(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function checkDay(date: CivilDate): void {
	if (!isCivilDate(date)) throw new EditError(`Invalid day ${date}`);
}

function checkNow(now: UtcSeconds): void {
	if (!isUtcSeconds(now)) throw new EditError(`Invalid time ${now}`);
}

/** The time a changed record gets: now, or just after its previous change if the clock is behind that */
function stamp(old: { edited: UtcSeconds } | undefined, now: UtcSeconds): UtcSeconds {
	if (!old || old.edited < now) return now;
	// (at the very end of the supported years: the same time; the merge then decides by content)
	const next = old.edited + 1;
	return isUtcSeconds(next) ? next : old.edited;
}

/** A goal in canonical form (only its own fields, in a fixed order) */
function cleanGoal(goal: Goal): Goal {
	return goal.period === 'day' ? { period: goal.period, days: [...goal.days], aim: goal.aim, target: goal.target } : { period: goal.period, aim: goal.aim, target: goal.target };
}

function cleanDraft(draft: HabitDraft): HabitDraft {
	const name = cleanText(draft.name);
	const unit = draft.kind === 'check' ? '' : cleanText(draft.unit);
	if (name === '') throw new EditError('The name is empty');
	if (!isValidGoal(draft.goal, draft.kind)) throw new EditError('Invalid goal');
	if (!isColor(draft.color.toLowerCase())) throw new EditError(`Invalid color ${draft.color}`);
	checkDay(draft.start);
	return { name, kind: draft.kind, unit, color: draft.color.toLowerCase(), start: draft.start, goal: cleanGoal(draft.goal) };
}

function habitIndex(data: DisciplineData, id: Id): number {
	const index = data.habits.findIndex((h) => h.id === id);
	if (index < 0) throw new EditError(`Unknown habit ${id}`);
	return index;
}

function replaceHabit(data: DisciplineData, index: number, habit: Habit): DisciplineData {
	return { ...data, habits: data.habits.with(index, habit).sort(compareHabits) };
}

/** Habits in the given order, numbered 1, 2, 3, …; only habits whose position changes are stamped */
function renumber(order: readonly Habit[], now: UtcSeconds): Habit[] {
	return order.map((h, i) => (h.position === i + 1 ? h : { ...h, position: i + 1, edited: stamp(h, now) }));
}

export function addHabit(data: DisciplineData, draft: HabitDraft, now: UtcSeconds): { data: DisciplineData; id: Id } {
	checkNow(now);
	const { goal, start, ...fields } = cleanDraft(draft);
	const id = newId(new Set(data.habits.map((h) => h.id)));
	const last = data.habits.at(-1);
	const position = last ? Math.floor(last.position) + 1 : 1;
	const habits = isPosition(position) ? data.habits : renumber(data.habits, now);
	const habit: Habit = { id, ...fields, goals: [{ from: start, ...goal }], position: isPosition(position) ? position : habits.length + 1, archived: null, edited: now };
	return { data: { ...data, habits: [...habits, habit].sort(compareHabits) }, id };
}

/** Goals starting on `start`: the one in effect then becomes the first, earlier ones go */
function withStart(goals: readonly DatedGoal[], start: CivilDate): DatedGoal[] {
	const first = goals.findLast((g) => g.from <= start) ?? goals[0]!;
	return [{ ...first, from: start }, ...goals.filter((g) => g.from > start && g !== first)];
}

/** Goals where `goal` applies from `from` on (replacing later ones); unchanged if it's the latest goal already */
function withGoal(goals: readonly DatedGoal[], goal: Goal, from: CivilDate): readonly DatedGoal[] {
	if (deepEqual(goalOf(goals.at(-1)!), goal)) return goals;
	const start = goals[0]!.from;
	if (from <= start) return [{ from: start, ...goal }];
	const before = goals.filter((g) => g.from < from);
	return deepEqual(goalOf(before.at(-1)!), goal) ? before : [...before, { from, ...goal }];
}

/**
 * Changes a habit. A goal different from the latest one applies from `goalFrom` on (usually
 * today), so earlier days are still judged by the goal they had; from the start on if `goalFrom`
 * is earlier. Changing the kind
 * starts the goals afresh (the old ones meant something else). `expected`: the version the user
 * edited; if the habit changed meanwhile (e.g. by a sync), this throws instead of overwriting that
 * change. An amount habit with amounts entered can't become a check habit (they would be lost);
 * the other way round is fine.
 */
export function updateHabit(data: DisciplineData, id: Id, draft: HabitDraft, goalFrom: CivilDate, now: UtcSeconds, expected?: Habit): DisciplineData {
	checkNow(now);
	checkDay(goalFrom);
	const index = habitIndex(data, id);
	const old = data.habits[index]!;
	if (expected && !deepEqual(old, expected)) throw new EditError('The habit was changed meanwhile (by a sync?)');
	const { goal, start, ...fields } = cleanDraft(draft);
	if (old.kind === 'amount' && fields.kind === 'check' && data.entries.some((e) => e.habit === id && e.value !== 1)) {
		throw new EditError('A habit with amounts entered can’t become a yes/no habit');
	}
	const goals = fields.kind !== old.kind ? [{ from: start, ...goal }] : withGoal(withStart(old.goals, start), goal, goalFrom);
	const updated: Habit = { ...old, ...fields, goals };
	if (deepEqual(updated, old)) return data;
	return replaceHabit(data, index, { ...updated, edited: stamp(old, now) });
}

/** Archives a habit from a day on (it stops counting then), or makes it active again (null) */
export function setArchived(data: DisciplineData, id: Id, from: CivilDate | null, now: UtcSeconds): DisciplineData {
	checkNow(now);
	if (from !== null) checkDay(from);
	const index = habitIndex(data, id);
	const old = data.habits[index]!;
	if (old.archived === from) return data;
	return replaceHabit(data, index, { ...old, archived: from, edited: stamp(old, now) });
}

/** Deletes a habit with all its entries */
export function deleteHabit(data: DisciplineData, id: Id): DisciplineData {
	habitIndex(data, id);
	return { ...data, habits: data.habits.filter((h) => h.id !== id), entries: data.entries.filter((e) => e.habit !== id) };
}

/**
 * Moves a habit to just before another one (`before`; null: to the end). Only the moved habit
 * changes: its position becomes the middle between its new neighbours'. When there's no room
 * between them (they tie, e.g. two habits added on two devices, or after many moves to the same
 * spot), all habits are numbered anew.
 */
export function moveHabit(data: DisciplineData, id: Id, before: Id | null, now: UtcSeconds): DisciplineData {
	checkNow(now);
	const from = habitIndex(data, id);
	if (before === id) throw new EditError('A habit can’t be moved before itself');
	const others = data.habits.filter((h) => h.id !== id);
	const index = before === null ? others.length : others.findIndex((h) => h.id === before);
	if (index < 0) throw new EditError(`Unknown habit ${before}`);
	if (index === from) return data;
	const [prev, next] = [others[index - 1], others[index]];
	const moved = data.habits[from]!;
	const position = prev === undefined ? Math.floor(next!.position) - 1 : next === undefined ? Math.floor(prev.position) + 1 : (prev.position + next.position) / 2;
	const fits = (prev === undefined || position > prev.position) && (next === undefined || position < next.position);
	if (fits && isPosition(position)) return replaceHabit(data, from, { ...moved, position, edited: stamp(moved, now) });
	return { ...data, habits: renumber([...others.slice(0, index), moved, ...others.slice(index)], now) };
}

/** The entry of a habit on a day, if any */
export function entryOn(data: DisciplineData, habit: Id, date: CivilDate): Entry | undefined {
	const index = findEntry(data.entries, { habit, date });
	return index >= 0 ? data.entries[index] : undefined;
}

/** Binary search: the index of the entry, or `-(insertion point) - 1` */
function findEntry(entries: readonly Entry[], key: Pick<Entry, 'habit' | 'date'>): number {
	let [low, high] = [0, entries.length - 1];
	while (low <= high) {
		const mid = (low + high) >>> 1;
		const c = compareEntries(entries[mid]!, key);
		if (c === 0) return mid;
		if (c < 0) low = mid + 1;
		else high = mid - 1;
	}
	return -low - 1;
}

/**
 * Sets what was done on a day: for a check habit 1 (done) or null (not done), for an amount habit
 * the amount or null (nothing). Amounts must be valid (`isEntryValue`; round typed input with
 * `roundValue`).
 */
export function setEntry(data: DisciplineData, habit: Id, date: CivilDate, value: number | null, now: UtcSeconds): DisciplineData {
	checkNow(now);
	checkDay(date);
	const h = data.habits[habitIndex(data, habit)]!;
	if (value !== null) {
		if (!isEntryValue(value)) throw new EditError(`Invalid amount ${value}`);
		if (h.kind === 'check' && value !== 1) throw new EditError('A yes/no habit is done (1) or not');
	}
	const index = findEntry(data.entries, { habit, date });
	const old = index >= 0 ? data.entries[index] : undefined;
	if (old?.value === (value ?? undefined)) return data;
	if (value === null) return { ...data, entries: data.entries.toSpliced(index, 1) };
	const entry: Entry = { habit, date, value, edited: stamp(old, now) };
	return { ...data, entries: old ? data.entries.with(index, entry) : data.entries.toSpliced(-index - 1, 0, entry) };
}

/**
 * Adds to what was done on a day of an amount habit (nothing entered counts as 0); the sum is
 * rounded like typed input. `amount` must be positive.
 */
export function addToEntry(data: DisciplineData, habit: Id, date: CivilDate, amount: number, now: UtcSeconds): DisciplineData {
	if (!(amount > 0)) throw new EditError(`Invalid amount ${amount}`);
	if (data.habits[habitIndex(data, habit)]!.kind !== 'amount') throw new EditError('Only amounts add up');
	const value = roundValue((entryOn(data, habit, date)?.value ?? 0) + amount);
	if (value > MAX_VALUE) throw new EditError('That is more than an entry can hold.');
	return setEntry(data, habit, date, value, now);
}

/** Marks a check habit done on a day, or not done if it was */
export function toggleCheck(data: DisciplineData, habit: Id, date: CivilDate, now: UtcSeconds): DisciplineData {
	return setEntry(data, habit, date, entryOn(data, habit, date) ? null : 1, now);
}

/**
 * A typed amount: digits with one decimal separator, a dot or a comma (whichever the keyboard
 * has), e.g. "30", "2.5", "2,5", ".5". Rounded to 3 decimals. Null for anything else (also for
 * thousands separators like "1,000.5", which would be ambiguous), or for 0 or a negative amount.
 */
export function parseValueInput(text: string): number | null {
	const t = text.trim();
	if (!/^(\d+([.,]\d*)?|[.,]\d+)$/.test(t)) return null;
	const value = roundValue(Number(t.replace(',', '.')));
	return isEntryValue(value) ? value : null;
}

/** Changes how days and weeks are counted (for all synced devices) */
export function setPreferences(data: DisciplineData, changes: Partial<Pick<Preferences, 'dayStart' | 'weekStart'>>, now: UtcSeconds): DisciplineData {
	checkNow(now);
	const old = data.preferences;
	const dayStart = changes.dayStart ?? old.dayStart;
	const weekStart = changes.weekStart ?? old.weekStart;
	if (!isDayStart(dayStart)) throw new EditError(`Invalid day start ${dayStart}`);
	if (!isWeekStart(weekStart)) throw new EditError(`Invalid week start ${weekStart}`);
	if (dayStart === old.dayStart && weekStart === old.weekStart) return data;
	return { ...data, preferences: { dayStart, weekStart, edited: stamp(old.edited === null ? undefined : { edited: old.edited }, now) } };
}
