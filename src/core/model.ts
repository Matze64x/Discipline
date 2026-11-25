/**
 * The data: habits and what was done on which day. Plain immutable objects; changes go through
 * `edit.ts`, which keeps the invariants listed there.
 */
import { compareIds, type Id } from './ids';
import { WEEKDAYS, type CivilDate, type UtcSeconds, type Weekday } from './dates';

/**
 * - `check`: done or not on a day (an entry's value is 1)
 * - `amount`: how much on a day, e.g. 30 (minutes) or 2.5 (km); an entry's value is that amount
 */
export type HabitKind = 'check' | 'amount';

/**
 * What counts as success:
 * - `day`: on each of the given weekdays (all seven: every day). A check habit must be done; an
 *   amount habit must reach `target` on the day (for a check habit, `target` is 1).
 * - `week` / `month`: `target` within each week or month. A check habit: on that many days (in a
 *   month with fewer days, all of them); an amount habit: that much in total. Which day a week
 *   starts on is a per-device setting, so weekly results can differ between devices that differ there.
 */
export type Goal =
	| { readonly period: 'day'; readonly days: readonly Weekday[]; readonly target: number }
	| { readonly period: 'week' | 'month'; readonly target: number };

/** A goal that applies from a day on (until the next one's `from`) */
export type DatedGoal = Goal & { readonly from: CivilDate };

export interface Habit {
	readonly id: Id;
	/** Not empty, no leading or trailing white space (see `isCleanText`) */
	readonly name: string;
	readonly kind: HabitKind;
	/** For amount habits, e.g. "min" or "km" (may be empty); empty for check habits */
	readonly unit: string;
	/**
	 * The goals over time, by `from` ascending (strictly), at least one. The first one's `from` is
	 * the day the habit starts counting; changing the goal later keeps how earlier days were judged.
	 */
	readonly goals: readonly DatedGoal[];
	/** "#rrggbb" */
	readonly color: string;
	/**
	 * Where it's listed: habits are shown by position, then id. Moving a habit changes only its own
	 * position (to between its new neighbours), so reordering on two devices merges.
	 */
	readonly position: number;
	/** From this day on the habit doesn't count any more and is hidden from daily use (its history stays); null: active */
	readonly archived: CivilDate | null;
	readonly edited: UtcSeconds;
}

/** What was done on a day. There is at most one entry per habit and day; no entry = nothing done. */
export interface Entry {
	readonly habit: Id;
	readonly date: CivilDate;
	/** Positive; at most 3 decimals (see `isEntryValue`). Always 1 for check habits. */
	readonly value: number;
	readonly edited: UtcSeconds;
}

/** The days a week can start on: Monday or Sunday */
export type WeekStart = 1 | 7;

/** Day starts that can be chosen: midnight to 06:00, in half hours (minutes after midnight) */
export const DAY_STARTS: readonly number[] = Object.freeze(Array.from({ length: 13 }, (_, i) => i * 30));

/**
 * How days and weeks are counted. Part of the data (so all synced devices count alike), not of
 * a device's own preferences.
 */
export interface Preferences {
	/** When a new day starts, in minutes after midnight (one of `DAY_STARTS`; 240: until 04:00 it's still yesterday) */
	readonly dayStart: number;
	/** The first day of the week (for weekly goals and week views) */
	readonly weekStart: WeekStart;
	/** The last change; null while never changed (the defaults) */
	readonly edited: UtcSeconds | null;
}

export const DEFAULT_PREFERENCES: Preferences = Object.freeze({ dayStart: 0, weekStart: 1, edited: null });

export function isDayStart(value: unknown): value is number {
	return typeof value === 'number' && DAY_STARTS.includes(value) && !Object.is(value, -0);
}

export function isWeekStart(value: unknown): value is WeekStart {
	return value === 1 || value === 7;
}

export interface DisciplineData {
	readonly preferences: Preferences;
	/** Sorted by `compareHabits` */
	readonly habits: readonly Habit[];
	/** Sorted by `compareEntries`; every entry's habit exists */
	readonly entries: readonly Entry[];
}

export const EMPTY_DATA: DisciplineData = Object.freeze({ preferences: DEFAULT_PREFERENCES, habits: Object.freeze([]), entries: Object.freeze([]) });

/** The largest value an entry or a target can have */
export const MAX_VALUE = 1_000_000_000;
/** Positions stay within ±this, so `position + 1` is always a different number */
export const MAX_POSITION = 1_000_000_000;

/** Whether a number can be an entry's value or a goal's target: positive, finite, at most 3 decimals */
export function isEntryValue(value: number): boolean {
	return Number.isFinite(value) && value > 0 && value <= MAX_VALUE && Math.round(value * 1000) / 1000 === value;
}

export function isPosition(value: number): boolean {
	return Number.isFinite(value) && Math.abs(value) <= MAX_POSITION && !Object.is(value, -0);
}

export function isColor(text: string): boolean {
	return /^#[0-9a-f]{6}$/.test(text);
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Whether text can be stored: no lone surrogate (half an emoji: not representable in UTF-8) */
export function isStorableText(text: string): boolean {
	return !LONE_SURROGATE.test(text);
}

/**
 * Text as the data keeps names and units: a lone surrogate (e.g. from cut-off pasted text)
 * becomes U+FFFD, NUL is dropped, and leading and trailing white space is removed.
 */
export function cleanText(text: string): string {
	return text.replace(new RegExp(LONE_SURROGATE.source, 'g'), '�').replaceAll('\0', '').trim();
}

/** Whether text is as `cleanText` leaves it */
export function isCleanText(text: string): boolean {
	return cleanText(text) === text;
}

export function compareHabits(a: Habit, b: Habit): number {
	return a.position !== b.position ? a.position - b.position : compareIds(a.id, b.id);
}

/** Chronological, then by habit id */
export function compareEntries(a: Pick<Entry, 'date' | 'habit'>, b: Pick<Entry, 'date' | 'habit'>): number {
	if (a.date !== b.date) return a.date < b.date ? -1 : 1;
	return compareIds(a.habit, b.habit);
}

/** The key that identifies an entry: one per habit and day */
export function entryKey(e: Pick<Entry, 'habit' | 'date'>): string {
	return `${e.habit}/${e.date}`;
}

/** Most days a period can have: a check habit's week or month target can't be more */
export const PERIOD_DAYS = { week: 7, month: 31 } as const;

/** Whether a goal is valid for a habit of the given kind */
export function isValidGoal(goal: Goal, kind: HabitKind): boolean {
	if (!isEntryValue(goal.target)) return false;
	if (goal.period === 'day') {
		const sorted = goal.days.every((d, i) => WEEKDAYS.includes(d) && (i === 0 || d > goal.days[i - 1]!));
		return sorted && goal.days.length > 0 && (kind === 'amount' || goal.target === 1);
	}
	return kind === 'amount' || (Number.isInteger(goal.target) && goal.target <= PERIOD_DAYS[goal.period]);
}

/** The goal without its date */
export function goalOf({ from: _, ...goal }: DatedGoal): Goal {
	return goal;
}

/** The day a habit starts counting */
export function startOf(habit: Habit): CivilDate {
	return habit.goals[0]!.from;
}

/** The goal that applies on a day; undefined before the habit starts */
export function goalOn(habit: Habit, date: CivilDate): DatedGoal | undefined {
	return habit.goals.findLast((g) => g.from <= date);
}

/** The latest goal (what the editor shows and changes) */
export function latestGoal(habit: Habit): DatedGoal {
	return habit.goals.at(-1)!;
}
