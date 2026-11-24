import type { Brand } from './brand';

/**
 * A calendar date without time or timezone, stored as "YYYY-MM-DD" so that string comparison
 * is chronological. Deliberately not a JS `Date`, which would shift with the local timezone.
 */
export type CivilDate = Brand<string, 'CivilDate'>;

/** A point in time as whole seconds since the Unix epoch, UTC */
export type UtcSeconds = Brand<number, 'UtcSeconds'>;

/**
 * Years the data may have (days and timestamps). Date arithmetic (`civilDate`, `addDays`, …) works
 * in a wider range, 1000–9999, so the weeks and months around any valid day can be computed
 * (JS `Date.UTC` reads years below 100 as 1900 + year, so nothing goes below 1000).
 */
export const MIN_YEAR = 1900;
export const MAX_YEAR = 2200;
const MIN_ARITHMETIC_YEAR = 1000;
const MAX_ARITHMETIC_YEAR = 9999;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Whether a day exists; by default within the years the data may have (`MIN_YEAR`–`MAX_YEAR`) */
function isValidDate(year: number, month: number, day: number, minYear = MIN_YEAR, maxYear = MAX_YEAR): boolean {
	if (!Number.isInteger(year) || year < minYear || year > maxYear) return false;
	if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1) return false;
	return day <= daysInMonth(year, month);
}

/** The number of days in a month (1–12) */
export function daysInMonth(year: number, month: number): number {
	return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]!;
}

function pad(value: number, width = 2): string {
	return value.toString().padStart(width, '0');
}

function makeDate(year: number, month: number, day: number): CivilDate {
	return `${year}-${pad(month)}-${pad(day)}` as CivilDate;
}

export function civilDate(year: number, month: number, day: number): CivilDate {
	if (!isValidDate(year, month, day, MIN_ARITHMETIC_YEAR, MAX_ARITHMETIC_YEAR)) throw new RangeError(`Invalid date: ${year}-${month}-${day}`);
	return makeDate(year, month, day);
}

/** Whether a value is a day the data may have ("YYYY-MM-DD", an existing day in `MIN_YEAR`–`MAX_YEAR`) */
export function isCivilDate(value: string): value is CivilDate {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	return !!m && isValidDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function dateParts(date: CivilDate): { year: number; month: number; day: number } {
	const [year, month, day] = date.split('-').map(Number) as [number, number, number];
	return { year, month, day };
}

const MIN_TIME = Date.UTC(MIN_YEAR, 0, 1) / 1000;
const MAX_TIME = Date.UTC(MAX_YEAR, 11, 31, 23, 59, 59) / 1000;

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** Parses a timestamp as written in the file: "YYYY-MM-DDTHH:MM:SSZ" (UTC, whole seconds). */
export function parseTimestamp(text: string): UtcSeconds | null {
	const m = TIMESTAMP.exec(text);
	if (!m) return null;
	const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [number, number, number, number, number, number];
	if (!isValidDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
	return (Date.UTC(year, month - 1, day, hour, minute, second) / 1000) as UtcSeconds;
}

/** Throws for a time the data can't hold (see `isUtcSeconds`) */
export function formatTimestamp(time: UtcSeconds): string {
	if (!isUtcSeconds(time)) throw new RangeError(`Invalid timestamp ${time}`);
	const d = new Date(time * 1000);
	return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** Whether a number is a timestamp the file can hold (whole seconds within the supported years) */
export function isUtcSeconds(value: number): value is UtcSeconds {
	return Number.isInteger(value) && value >= MIN_TIME && value <= MAX_TIME;
}

export function nowUtcSeconds(): UtcSeconds {
	return Math.floor(Date.now() / 1000) as UtcSeconds;
}

/**
 * Today's date in the user's local timezone (what "today" means to the user). With `dayStart`
 * (minutes after midnight, a setting), a day lasts until that time the next morning: at 01:30
 * with a day start of 04:00, it is still yesterday.
 */
export function today(dayStart = 0): CivilDate {
	const d = new Date();
	d.setMinutes(d.getMinutes() - dayStart);
	return civilDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** The date `days` days later (or earlier, if negative). Throws outside the years 1000–9999. */
export function addDays(date: CivilDate, days: number): CivilDate {
	const { year, month, day } = dateParts(date);
	const d = new Date(Date.UTC(year, month - 1, day + days));
	return civilDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** The same day `months` months later (or earlier), clamped to the month's end (31.01. + 1 → 28./29.02.). */
export function addMonths(date: CivilDate, months: number): CivilDate {
	const { year, month, day } = dateParts(date);
	const index = year * 12 + (month - 1) + months;
	const y = Math.floor(index / 12);
	const m = index - y * 12 + 1;
	const last = m === 2 && isLeapYear(y) ? 29 : DAYS_IN_MONTH[m - 1]!;
	return civilDate(y, m, Math.min(day, last));
}

/** How dates are shown and typed (a user setting; the file always uses YYYY-MM-DD). */
export type DateStyle = 'DD.MM.YYYY' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD';
export const DATE_STYLES: readonly DateStyle[] = ['DD.MM.YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];

export function formatDateAs(date: CivilDate, style: DateStyle): string {
	const { year, month, day } = dateParts(date);
	const [d, m, y] = [pad(day), pad(month), String(year)];
	switch (style) {
		case 'DD.MM.YYYY':
			return `${d}.${m}.${y}`;
		case 'DD/MM/YYYY':
			return `${d}/${m}/${y}`;
		case 'MM/DD/YYYY':
			return `${m}/${d}/${y}`;
		case 'YYYY-MM-DD':
			return `${y}-${m}-${d}`;
	}
}

/**
 * Parses a typed date in the given style. Any of . , / - or space separate the parts (the comma:
 * the iPhone's number pad with a separator has only that in some regions), and parts may
 * be left out from the end of the date: "5" is the 5th of `reference`'s month, "5.3" the 5th of March
 * in `reference`'s year (for DD.MM.YYYY). Two-digit years are 20xx. A full "YYYY-MM-DD" is always
 * accepted. Returns null for anything else, including dates outside `MIN_YEAR`–`MAX_YEAR`.
 */
export function parseDateInput(text: string, style: DateStyle, reference: CivilDate): CivilDate | null {
	const parts = text.trim().replace(/[.,/\-\s]+$/, '').split(/[.,/\-\s]+/);
	if (parts.length > 3 || !parts.every((p) => /^\d{1,4}$/.test(p))) return null;
	let day: string | undefined, month: string | undefined, year: string | undefined;
	if (parts.length === 3 && parts[0]!.length === 4) [year, month, day] = parts;
	else if (style === 'YYYY-MM-DD') [day, month, year] = [...parts].reverse(); // "5" is the day, "3-5" month and day
	else if (style === 'MM/DD/YYYY') [month, day, year] = parts.length === 1 ? [undefined, parts[0]] : parts;
	else [day, month, year] = parts;
	const ref = dateParts(reference);
	const y = year === undefined ? ref.year : year.length <= 2 ? 2000 + Number(year) : year.length === 4 ? Number(year) : NaN;
	const m = month === undefined ? ref.month : Number(month);
	const d = Number(day);
	return isValidDate(y, m, d) ? makeDate(y, m, d) : null;
}

/** Days from `a` to `b` (negative if `b` is earlier) */
export function daysBetween(a: CivilDate, b: CivilDate): number {
	const utc = (d: CivilDate) => {
		const { year, month, day } = dateParts(d);
		return Date.UTC(year, month - 1, day);
	};
	return Math.round((utc(b) - utc(a)) / 86_400_000);
}

/** The day of the week: 1 = Monday … 7 = Sunday */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];

export function weekday(date: CivilDate): Weekday {
	const { year, month, day } = dateParts(date);
	return (((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1) as Weekday;
}

/** The first day of the week containing `date`, for weeks starting on `weekStart` */
export function startOfWeek(date: CivilDate, weekStart: Weekday): CivilDate {
	return addDays(date, -((weekday(date) - weekStart + 7) % 7));
}

export function startOfMonth(date: CivilDate): CivilDate {
	const { year, month } = dateParts(date);
	return makeDate(year, month, 1);
}
