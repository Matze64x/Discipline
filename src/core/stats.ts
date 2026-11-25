/**
 * Statistics over a habit's history: which goal periods were met, how each day went, how often a
 * habit is done on each weekday, and amount totals per week or month. Pure functions of the data,
 * like `progress.ts` (which they build on).
 *
 * A goal period counts once it's settled (`isSettled`): over, or decided early (a goal to build met,
 * a limit broken). An open day or week is neither met nor missed yet. Periods are those of the goal in effect on their days (`goalOn`), so a changed goal
 * keeps the past as it was; a goal that changes within a week or month takes that whole period.
 * A habit archived within a week or month: that period counts only if it was decided early.
 */
import { addDays, daysBetween, daysInMonth, dateParts, weekday, WEEKDAYS, type CivilDate, type Weekday } from './dates';
import { goalOn, startOf, type Aim, type DisciplineData, type Habit } from './model';
import { decidedEarly, entriesBetween, entriesByHabit, isActiveOn, isSettled, periodOf, progressOn } from './progress';

export interface PeriodResult {
	readonly aim: Aim;
	readonly from: CivilDate;
	readonly to: CivilDate;
	readonly done: number;
	readonly target: number;
	readonly met: boolean;
}

const minDate = (a: CivilDate, b: CivilDate) => (a < b ? a : b);
const maxDate = (a: CivilDate, b: CivilDate) => (a > b ? a : b);
const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The goal periods of a habit that overlap `from`…`to` and count by `today` (settled),
 * in date order. Days a daily goal doesn't ask for aren't periods.
 */
export function periodResults(data: DisciplineData, habit: Habit, from: CivilDate, to: CivilDate, weekStart: Weekday, today: CivilDate): PeriodResult[] {
	const results: PeriodResult[] = [];
	const last = minDate(to, today);
	for (let d = maxDate(from, startOf(habit)); d <= last; ) {
		if (habit.archived !== null && d >= habit.archived) break;
		const progress = progressOn(data, habit, d, weekStart);
		if (!progress) break;
		const { goal } = progress;
		// a goal that changes within a week or month takes that whole period (as Today shows it): an
		// earlier goal's period (or day) reaching into it doesn't count
		const nextGoal = habit.goals.find((g) => g.from > d);
		const superseded = habit.goals.some((g) => g.from > d && periodOf(g, g.from, weekStart).from <= progress.to);
		const next = superseded ? nextGoal!.from : goal.period === 'day' ? addDays(d, 1) : addDays(progress.to, 1);
		// archived within a week or month: that period only counts if it was decided before
		const cut = habit.archived !== null && progress.to >= habit.archived && !decidedEarly(progress);
		if (!superseded && !cut && progress.due && isSettled(progress, today)) {
			results.push({ aim: goal.aim, from: progress.from, to: progress.to, done: progress.done, target: progress.target, met: progress.met });
		}
		d = next;
	}
	return results;
}

/** How many of the periods were met */
export function rateOf(results: readonly PeriodResult[]): { met: number; counted: number } {
	return { met: results.filter((r) => r.met).length, counted: results.length };
}

/**
 * The goals of all habits met in each week (the weeks starting on `weeks`), each period counted in
 * the week it ends in (a month in its last week).
 */
export function weekShares(data: DisciplineData, weeks: readonly CivilDate[], weekStart: Weekday, today: CivilDate): { met: number; counted: number }[] {
	const shares = weeks.map(() => ({ met: 0, counted: 0 }));
	if (weeks.length === 0) return shares;
	const [first, end] = [weeks[0]!, addDays(weeks[weeks.length - 1]!, 6)];
	for (const habit of data.habits) {
		for (const r of periodResults(data, habit, first, end, weekStart, today)) {
			if (r.to < first || r.to > end) continue;
			const share = shares[Math.floor(daysBetween(first, r.to) / 7)]!;
			share.counted++;
			if (r.met) share.met++;
		}
	}
	return shares;
}

/**
 * A day of a habit, for its calendar:
 * - `inactive`: before its start, archived, or still to come
 * - `met`, `missed`, `open` (not settled yet), `notDue`: a day of a daily goal
 * - `free`: a day of a weekly or monthly goal (done or not, it isn't missed on its own)
 */
export interface DayCell {
	readonly state: 'inactive' | 'met' | 'missed' | 'open' | 'notDue' | 'free';
	/** The day's entry (0: none) */
	readonly value: number;
	/**
	 * How much of what the day asks for was done, 0…1: check habits 1 if done; amounts against the
	 * daily target, or against the share of a weekly or monthly target that falls on one day.
	 * Limits: 1 for a day kept (within a daily limit, or nothing under a weekly or monthly one; today
	 * only once over), else 0.
	 */
	readonly fill: number;
}

export function dayCell(data: DisciplineData, habit: Habit, date: CivilDate, today: CivilDate): DayCell {
	// (a single day's progress doesn't depend on the week start)
	const progress = date > today ? null : progressOn(data, habit, date, 1);
	if (!progress) return { state: 'inactive', value: 0, fill: 0 };
	const value = entriesBetween(entriesByHabit(data).get(habit.id) ?? [], date, date)[0]?.value ?? 0;
	const { goal } = progress;
	if (goal.aim === 'limit') {
		if (goal.period !== 'day') return { state: 'free', value, fill: value === 0 && date < today ? 1 : 0 };
		const state = !progress.due ? 'notDue' : !isSettled(progress, today) ? 'open' : progress.met ? 'met' : 'missed';
		return { state, value, fill: state === 'met' ? 1 : 0 };
	}
	if (goal.period === 'day') {
		const fill = progress.met ? 1 : habit.kind === 'check' ? (value > 0 ? 1 : 0) : Math.min(1, value / goal.target);
		const state = !progress.due ? 'notDue' : !isSettled(progress, today) ? 'open' : progress.met ? 'met' : 'missed';
		return { state, value, fill };
	}
	const perDay = goal.target / (daysBetween(progress.from, progress.to) + 1);
	return { state: 'free', value, fill: habit.kind === 'check' ? (value > 0 ? 1 : 0) : Math.min(1, value / perDay) };
}

/**
 * On each weekday from `from` to `to` (up to `today`): on how many of the days the habit was active
 * (and due, for a daily goal) it was done (met, for a daily amount goal). Under a limit, "done" is
 * a slip: a daily limit broken, or anything entered under a weekly or monthly one. Today counts
 * once done.
 */
export function weekdayShares(data: DisciplineData, habit: Habit, from: CivilDate, to: CivilDate, today: CivilDate): Record<Weekday, { done: number; days: number }> {
	const shares = Object.fromEntries(WEEKDAYS.map((w) => [w, { done: 0, days: 0 }])) as Record<Weekday, { done: number; days: number }>;
	const last = minDate(to, today);
	for (let d = maxDate(from, startOf(habit)); d <= last; d = addDays(d, 1)) {
		const cell = dayCell(data, habit, d, today);
		if (cell.state === 'inactive' || cell.state === 'notDue') continue;
		const limit = goalOn(habit, d)?.aim === 'limit';
		const done = cell.state === 'free' ? cell.value > 0 : limit ? cell.state === 'missed' : cell.state === 'met';
		if (d === today && !done) continue;
		const share = shares[weekday(d)];
		share.days++;
		if (done) share.done++;
	}
	return shares;
}

export interface AmountBucket {
	readonly from: CivilDate;
	readonly to: CivilDate;
	readonly total: number;
	/** What the goals in effect ask for in the bucket (a weekly goal per week, daily ones summed, …) */
	readonly target: number;
	/** The aim of the goal in effect on the bucket's last active day */
	readonly aim: Aim;
}

/**
 * Amount totals in each bucket (a week or a month), with what the goals ask for there. A bucket
 * that is a period of the goal owning it (as in `periodResults`: the goal in effect on its last
 * active day) gets that goal's target; any other gets each active day's share (a daily goal's
 * target if due, a weekly goal's seventh, a monthly goal's share of its month).
 */
export function amountBuckets(data: DisciplineData, habit: Habit, buckets: readonly { from: CivilDate; to: CivilDate }[], weekStart: Weekday): AmountBucket[] {
	const entries = entriesByHabit(data).get(habit.id) ?? [];
	return buckets.map(({ from, to }) => {
		const total = round(entriesBetween(entries, from, to).reduce((sum, e) => sum + e.value, 0));
		const lastActive = habit.archived !== null && habit.archived <= to ? addDays(habit.archived, -1) : to;
		const owner = lastActive >= maxDate(from, startOf(habit)) ? goalOn(habit, lastActive) : undefined;
		if (owner && owner.period !== 'day') {
			const period = periodOf(owner, lastActive, weekStart);
			if (period.from === from && period.to === to) return { from, to, total, target: owner.target, aim: owner.aim };
		}
		let target = 0;
		for (let d = maxDate(from, startOf(habit)); d <= to; d = addDays(d, 1)) {
			if (!isActiveOn(habit, d)) continue;
			const goal = goalOn(habit, d);
			if (!goal) continue;
			if (goal.period === 'day') target += goal.days.includes(weekday(d)) ? goal.target : 0;
			else if (goal.period === 'week') target += goal.target / 7;
			else {
				const { year, month } = dateParts(d);
				target += goal.target / daysInMonth(year, month);
			}
		}
		return { from, to, total, target: round(target), aim: owner?.aim ?? 'build' };
	});
}
