import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	addDays,
	addMonths,
	civilDate,
	DATE_STYLES,
	formatDateAs,
	MAX_YEAR,
	MIN_YEAR,
	type UtcSeconds,
	today,
	parseDateInput,
	type CivilDate,
	compareIds,
	formatTimestamp,
	isCivilDate,
	newId,
	parseId,
	parseTimestamp,
	startOfMonth,
	startOfWeek,
	weekday,
	type Id,
} from '../../src/core';

describe('dates', () => {
	it('accepts real dates in the supported years', () => {
		for (const text of ['2024-02-29', '2000-02-29', '1900-01-01', '2200-12-31']) expect(isCivilDate(text), text).toBe(true);
	});

	// the data's years are 1900–2200
	it.each(['2023-02-29', '1900-02-29', '2100-02-29', '2026-04-31', '2026-01-00', '2026-1-1', '2026-13-01', '1899-12-31', '2201-01-01', '2400-02-29', '29.02.2024', '2026-01-01 '])('rejects date %j', (text) => {
		expect(isCivilDate(text)).toBe(false);
	});

	it('civil dates compare chronologically as strings', () => {
		expect(civilDate(2025, 12, 31) < civilDate(2026, 1, 1)).toBe(true);
		expect(civilDate(2026, 1, 9) < civilDate(2026, 1, 10)).toBe(true);
	});

	it('parses timestamps as UTC', () => {
		expect(parseTimestamp('1970-01-01T00:00:00Z')).toBe(0);
		expect(parseTimestamp('2026-11-18T18:30:00Z')).toBe(Date.UTC(2026, 10, 18, 18, 30, 0) / 1000);
		expect(parseTimestamp('1969-12-31T23:59:59Z')).toBe(-1);
	});

	it('round-trips timestamps', () => {
		for (const text of ['1970-01-01T00:00:00Z', '2024-02-29T23:59:59Z', '1900-01-01T00:00:00Z', '2200-12-31T23:59:59Z']) {
			expect(formatTimestamp(parseTimestamp(text)!)).toBe(text);
		}
	});

	it.each(['2026-11-18T24:00:00Z', '2026-11-18T18:30Z', '2026-11-18 18:30:00Z', '2026-11-18T18:30:00', '2026-11-18T18:30:00.000Z', '2026-02-30T00:00:00Z', '1899-12-31T23:59:59Z', '2201-01-01T00:00:00Z'])('rejects timestamp %j', (text) => {
		expect(parseTimestamp(text)).toBeNull();
	});

	it('knows weekdays and period starts', () => {
		const d = (text: string) => text as CivilDate;
		expect(weekday(d('2026-11-23'))).toBe(1); // a Monday
		expect(weekday(d('2026-11-29'))).toBe(7);
		expect(startOfWeek(d('2026-11-29'), 1)).toBe('2026-11-23');
		expect(startOfWeek(d('2026-11-29'), 7)).toBe('2026-11-29');
		expect(startOfWeek(d('2026-11-28'), 7)).toBe('2026-11-22');
		expect(startOfWeek(d('2026-11-23'), 1)).toBe('2026-11-23');
		expect(startOfMonth(d('2024-02-29'))).toBe('2024-02-01');
	});
});

describe('ids', () => {
	it('accepts canonical uint64 values', () => {
		expect(parseId('0')).toBe('0');
		expect(parseId('18446744073709551615')).toBe('18446744073709551615');
	});

	it.each(['18446744073709551616', '-1', '007', '', '1.0', ' 1', '1e3'])('rejects %j', (text) => {
		expect(parseId(text)).toBeNull();
	});

	it('compares numerically', () => {
		const ids = ['10', '9', '18446744073709551615', '100', '0'] as Id[];
		expect([...ids].sort(compareIds)).toEqual(['0', '9', '10', '100', '18446744073709551615']);
	});

	it('generates unique non-zero ids', () => {
		const taken = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			const id = newId(taken);
			expect(parseId(id)).toBe(id);
			expect(id).not.toBe('0');
			taken.add(id);
		}
		expect(taken.size).toBe(1000);
	});
});

describe('date arithmetic', () => {
	const d = (text: string) => text as CivilDate;
	it('adds days across months and years', () => {
		expect(addDays(d('2026-12-31'), 1)).toBe('2027-01-01');
		expect(addDays(d('2024-03-01'), -1)).toBe('2024-02-29');
	});
	it('adds months, clamped to the end of the month', () => {
		expect(addMonths(d('2026-01-31'), 1)).toBe('2026-02-28');
		expect(addMonths(d('2024-01-31'), 1)).toBe('2024-02-29');
		expect(addMonths(d('2026-01-15'), -1)).toBe('2025-12-15');
	});
	it('calculates beyond the data years, so periods around any valid day work', () => {
		expect(addDays(d(`${MAX_YEAR}-12-31`), 1)).toBe('2201-01-01');
		expect(startOfWeek(d(`${MIN_YEAR}-01-01`), 7)).toBe('1899-12-31'); // (a Monday)
		expect(addDays(startOfWeek(d(`${MAX_YEAR}-12-31`), 1), 6)).toBe('2201-01-04');
		expect(addMonths(d(`${MIN_YEAR}-01-31`), -1)).toBe('1899-12-31');
		expect(() => addDays(d('9999-12-31'), 1)).toThrow(RangeError);
	});
	it('refuses to write a time the data can’t hold', () => {
		expect(() => formatTimestamp((Date.UTC(MAX_YEAR + 1, 0, 1) / 1000) as UtcSeconds)).toThrow(RangeError);
		expect(() => formatTimestamp(1.5 as UtcSeconds)).toThrow(RangeError);
	});
});

describe('today', () => {
	afterEach(() => vi.useRealTimers());
	it('starts a new day at the chosen time', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 10, 24, 1, 30));
		expect(today()).toBe('2026-11-24');
		expect(today(4 * 60)).toBe('2026-11-23');
		vi.setSystemTime(new Date(2026, 10, 24, 4, 0));
		expect(today(4 * 60)).toBe('2026-11-24');
		// the first of the month and the year
		vi.setSystemTime(new Date(2027, 0, 1, 0, 15));
		expect(today(30)).toBe('2026-12-31');
	});
});

describe('typed dates', () => {
	const ref = '2026-11-20' as CivilDate;
	it('formats in every style', () => {
		const date = '2026-03-05' as CivilDate;
		expect(DATE_STYLES.map((s) => formatDateAs(date, s))).toEqual(['05.03.2026', '05/03/2026', '03/05/2026', '2026-03-05']);
	});
	it('round-trips every style', () => {
		for (const style of DATE_STYLES) expect(parseDateInput(formatDateAs('2001-02-03' as CivilDate, style), style, ref)).toBe('2001-02-03');
	});
	it('fills in left-out parts from the reference date', () => {
		expect(parseDateInput('5', 'DD.MM.YYYY', ref)).toBe('2026-11-05');
		expect(parseDateInput('5.3.', 'DD.MM.YYYY', ref)).toBe('2026-03-05');
		// the separator the phone's number pad has in some regions
		expect(parseDateInput('5,3,26', 'DD.MM.YYYY', ref)).toBe('2026-03-05');
		expect(parseDateInput('5,3', 'DD.MM.YYYY', ref)).toBe('2026-03-05');
		expect(parseDateInput('5.3.25', 'DD.MM.YYYY', ref)).toBe('2025-03-05');
		expect(parseDateInput('3/5', 'MM/DD/YYYY', ref)).toBe('2026-03-05');
		expect(parseDateInput('5', 'MM/DD/YYYY', ref)).toBe('2026-11-05');
		expect(parseDateInput('3-5', 'YYYY-MM-DD', ref)).toBe('2026-03-05');
	});
	it('always accepts a full ISO date', () => {
		expect(parseDateInput('2025-03-05', 'MM/DD/YYYY', ref)).toBe('2025-03-05');
	});
	it('rejects invalid input', () => {
		for (const text of ['', 'today', '31.2.2026', '1.13.2026', '1.1.300', '1.1.1899', '1.1.2201', '1.1.2026.1', '5;3'])
			expect(parseDateInput(text, 'DD.MM.YYYY', ref), text).toBeNull();
	});
});
