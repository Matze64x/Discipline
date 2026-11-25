/**
 * How a habit is doing: whether it counts on a day, and its progress within the goal's period
 * (the day, week or month) that contains a day. Pure functions of the data, for the views and,
 * later, statistics.
 */
import { addDays, addMonths, dateParts, daysBetween, daysInMonth, startOfMonth, startOfWeek, weekday, type CivilDate, type Weekday } from './dates';
import type { Id } from './ids';
import { goalOn, startOf, type DatedGoal, type DisciplineData, type Entry, type Habit } from './model';

/** Whether a habit counts on a day: it has started and isn't archived yet */
export function isActiveOn(habit: Habit, date: CivilDate): boolean {
	return date >= startOf(habit) && (habit.archived === null || date < habit.archived);
}

const byHabitCache = new WeakMap<readonly Entry[], Map<Id, Entry[]>>();

/** Each habit's entries, by date ascending (computed once per entries array: data is never changed) */
export function entriesByHabit(data: DisciplineData): ReadonlyMap<Id, readonly Entry[]> {
	let map = byHabitCache.get(data.entries);
	if (!map) {
		map = new Map();
		for (const e of data.entries) {
			const list = map.get(e.habit);
			if (list) list.push(e);
			else map.set(e.habit, [e]);
		}
		byHabitCache.set(data.entries, map);
	}
	return map;
}

/** The entries of a habit from `from` to `to` (inclusive) */
export function entriesBetween(entries: readonly Entry[], from: CivilDate, to: CivilDate): Entry[] {
	// (sorted by date: binary search for the first one)
	let [low, high] = [0, entries.length];
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (entries[mid]!.date < from) low = mid + 1;
		else high = mid;
	}
	const result: Entry[] = [];
	for (let i = low; i < entries.length && entries[i]!.date <= to; i++) result.push(entries[i]!);
	return result;
}

export interface Progress {
	readonly goal: DatedGoal;
	/** The period the progress is about: the day itself, or the week or month containing it */
	readonly from: CivilDate;
	readonly to: CivilDate;
	/** Whether the goal asks for something on this day (a daily goal on another weekday: no) */
	readonly due: boolean;
	/** Check habits: the days done; amount habits: the total */
	readonly done: number;
	/** What the goal asks for in the period (a limit: what it allows). Check habits building per month: at most the days the month has. */
	readonly target: number;
	/** At least the target (`build`), or at most the target so far (`limit`: can still break) */
	readonly met: boolean;
}

/**
 * Whether a period's result is final on `today`: it's over, or it can't change any more (a goal
 * to build is met, a limit is broken). Until then, it's open: neither met nor missed.
 */
export function isSettled(progress: Pick<Progress, 'goal' | 'to' | 'met'>, today: CivilDate): boolean {
	return progress.to < today || decidedEarly(progress);
}

/** Whether a period's result is final before it's over: a goal to build met, a limit broken */
export function decidedEarly(progress: Pick<Progress, 'goal' | 'met'>): boolean {
	return progress.goal.aim === 'build' ? progress.met : !progress.met;
}

/** The period of a goal that contains `date` */
export function periodOf(goal: DatedGoal, date: CivilDate, weekStart: Weekday): { from: CivilDate; to: CivilDate } {
	if (goal.period === 'day') return { from: date, to: date };
	if (goal.period === 'week') {
		const from = startOfWeek(date, weekStart);
		return { from, to: addDays(from, 6) };
	}
	const from = startOfMonth(date);
	return { from, to: addDays(addMonths(from, 1), -1) };
}

/**
 * A habit's progress in the period of its goal containing `date`, by the goal in effect on that
 * day; null if the habit doesn't count then (see `isActiveOn`).
 */
export function progressOn(data: DisciplineData, habit: Habit, date: CivilDate, weekStart: Weekday): Progress | null {
	const goal = goalOn(habit, date);
	if (!goal || !isActiveOn(habit, date)) return null;
	const { from, to } = periodOf(goal, date, weekStart);
	const entries = entriesBetween(entriesByHabit(data).get(habit.id) ?? [], from, to);
	const done = Math.round(entries.reduce((sum, e) => sum + e.value, 0) * 1000) / 1000;
	let target = goal.target;
	if (goal.period === 'month' && habit.kind === 'check' && goal.aim === 'build') {
		const { year, month } = dateParts(date);
		target = Math.min(target, daysInMonth(year, month));
	}
	const due = goal.period !== 'day' || goal.days.includes(weekday(date));
	return { goal, from, to, due, done, target, met: goal.aim === 'build' ? done >= target : done <= target };
}

/** A day of a daily goal: met, missed (due, not met, settled), not due (or the habit wasn't active), or still open (see `isSettled`) */
export type DayMark = 'done' | 'missed' | 'off' | 'open';

/**
 * How a habit's days went by its daily goal (`today` and later can't be missed yet). A day under
 * a weekly or monthly goal (before or after a goal change) has no daily goal: off.
 */
export function dayMarks(data: DisciplineData, habit: Habit, days: readonly CivilDate[], today: CivilDate): DayMark[] {
	return days.map((d) => {
		// (the week start doesn't matter for a single day's goal)
		const progress = progressOn(data, habit, d, 1);
		if (!progress || !progress.due || progress.goal.period !== 'day') return 'off';
		if (!isSettled(progress, today)) return 'open';
		return progress.met ? 'done' : 'missed';
	});
}

/** How far the period `from`…`to` has run on `today`, 0…1 (today counts as begun) */
export function timeShare(period: Pick<Progress, 'from' | 'to'>, today: CivilDate): number {
	if (today < period.from) return 0;
	if (today > period.to) return 1;
	return (daysBetween(period.from, today) + 1) / (daysBetween(period.from, period.to) + 1);
}

/**
 * How many of the daily goals due on `date` were met (habits with weekly or monthly goals aside).
 * A limit still kept on `today` doesn't count yet (it can still break); one to build does (as not met).
 */
export function dayShare(data: DisciplineData, date: CivilDate, today: CivilDate): { met: number; due: number } {
	let [met, due] = [0, 0];
	for (const habit of data.habits) {
		const progress = progressOn(data, habit, date, 1);
		if (!progress || progress.goal.period !== 'day' || !progress.due) continue;
		if (progress.goal.aim === 'limit' && !isSettled(progress, today)) continue;
		due++;
		if (progress.met) met++;
	}
	return { met, due };
}

/** What's still missing to meet the goal in the period (0 when met) */
export function remainingOf(progress: Pick<Progress, 'done' | 'target'>): number {
	return Math.max(0, Math.round((progress.target - progress.done) * 1000) / 1000);
}

/** How many days of a period are left from `date` on, including it */
export function daysLeft(progress: Pick<Progress, 'to'>, date: CivilDate): number {
	return daysBetween(date, progress.to) + 1;
}
