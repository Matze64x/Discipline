/** Formatting for display only (never for the file format). */
import { civilDate, dateParts, formatDateAs, type CivilDate, type Goal, type Habit, type Progress, type UtcSeconds, type Weekday } from '../core';
import { settings } from './settings.svelte';

/** A date in the user's chosen style (reactive: re-renders when the setting changes). */
export function formatDate(date: CivilDate): string {
	return formatDateAs(date, settings.dateStyle);
}

/** A date without the year, in the user's date format: "25.11.", "25/11", "11/25", "11-25" */
export function formatShortDate(date: CivilDate): string {
	const full = formatDate(date);
	switch (settings.dateStyle) {
		case 'DD.MM.YYYY':
			return full.slice(0, 6);
		case 'YYYY-MM-DD':
			return full.slice(5);
		default:
			return full.slice(0, 5);
	}
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** The local calendar day of a timestamp, in the user's chosen style. */
export function formatDay(time: UtcSeconds): string {
	const d = new Date(time * 1000);
	return formatDate(civilDate(d.getFullYear(), d.getMonth() + 1, d.getDate()));
}

/** A month's name: `formatMonth(date)` = "Sep", with `{ year: '2-digit' }` "Sep 26" (en-US: en-GB writes "Sept") */
export function formatMonth(date: CivilDate, options: Intl.DateTimeFormatOptions = {}): string {
	const { year, month } = dateParts(date);
	return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'short', ...options });
}


// no thousands separators: "1,000" would read as one with a decimal comma when typed back
// latin digits: other numbering systems (e.g. Arabic) couldn't be typed back
const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3, useGrouping: false, numberingSystem: 'latn' });

/** An amount for display ("2.5", or "2,5" where that's the decimal separator), at most 3 decimals */
export function formatValue(value: number): string {
	return numbers.format(value);
}

/** An amount with its unit: "30 min", "2.5" */
export function withUnit(value: number, unit: string): string {
	return unit ? `${formatValue(value)} ${unit}` : formatValue(value);
}

const WEEKDAY_NAMES: Record<Weekday, string> = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

export function weekdayName(day: Weekday): string {
	return WEEKDAY_NAMES[day];
}

/** Weekdays for a goal: "every day", "Mon–Fri", "weekends", "Mon, Wed, Fri" */
export function describeDays(days: readonly Weekday[]): string {
	const key = days.join('');
	if (key === '1234567') return 'every day';
	if (key === '12345') return 'Mon–Fri';
	if (key === '67') return 'weekends';
	return days.map(weekdayName).join(', ');
}

/** A goal in words: "every day", "30 min Mon–Fri", "3 times a week", "20 km a month" */
export function describeGoal(goal: Goal, habit: Pick<Habit, 'kind' | 'unit'>): string {
	const per = goal.period === 'week' ? 'a week' : 'a month';
	if (goal.period === 'day') return habit.kind === 'check' ? describeDays(goal.days) : `${withUnit(goal.target, habit.unit)} ${describeDays(goal.days)}`;
	if (habit.kind === 'check') return `${goal.target === 1 ? 'once' : goal.target === 2 ? 'twice' : `${goal.target} times`} ${per}`;
	return `${withUnit(goal.target, habit.unit)} ${per}`;
}

/** A daily amount goal's day in words: "20 / 30 min" ("Not due" on another weekday) */
export function describeDayAmount(progress: Progress, habit: Pick<Habit, 'unit'>): string {
	return progress.due ? `${formatValue(progress.done)} / ${withUnit(progress.target, habit.unit)}` : 'Not due';
}
