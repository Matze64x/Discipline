/** Formatting for display only (never for the file format). */
import { civilDate, dateParts, formatDateAs, type CivilDate, type UtcSeconds } from '../core';
import { settings } from './settings.svelte';

/** A date in the user's chosen style (reactive: re-renders when the setting changes). */
export function formatDate(date: CivilDate): string {
	return formatDateAs(date, settings.dateStyle);
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

/** A weekday's short name: "Mon" */
export function formatWeekday(date: CivilDate): string {
	const { year, month, day } = dateParts(date);
	return new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'short' });
}

const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });

/** An amount for display ("2.5", "1,000"), rounded to 3 decimals (sums of decimals can be off a little) */
export function formatValue(value: number): string {
	return numbers.format(value);
}
