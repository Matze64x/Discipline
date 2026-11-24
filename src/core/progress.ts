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
	/** What the goal asks for in the period. Check habits per month: at most the days the month has. */
	readonly target: number;
	readonly met: boolean;
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
	if (goal.period === 'month' && habit.kind === 'check') {
		const { year, month } = dateParts(date);
		target = Math.min(target, daysInMonth(year, month));
	}
	const due = goal.period !== 'day' || goal.days.includes(weekday(date));
	return { goal, from, to, due, done, target, met: done >= target };
}

/** How many days of a period are left from `date` on, including it */
export function daysLeft(progress: Pick<Progress, 'to'>, date: CivilDate): number {
	return daysBetween(date, progress.to) + 1;
}
