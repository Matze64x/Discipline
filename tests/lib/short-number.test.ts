import { describe, expect, it } from 'vitest';
import { formatShort } from '../../src/lib/short-number';

describe('formatShort', () => {
	it.each([
		[0, '0'],
		[0.001, '0.001'],
		[0.25, '0.25'],
		[7, '7'],
		[9.999, '9.99'],
		[12.5, '12.5'],
		[99.95, '99.9'],
		[99.99, '99.9'],
		[600, '600'],
		[999.5, '999'],
		[1000, '1k'],
		[1250, '1.2k'],
		[1950, '1.9k'],
		[9999.5, '9.9k'],
		[9950, '9.9k'],
		[15400, '15k'],
		[999_999, '999k'],
		[2_500_000, '2.5M'],
		[1e9, '1000M'],
	])('%s → %s (never more than it is)', (value, short) => {
		// (in the locale's decimal separator)
		expect(formatShort(value).replace(',', '.')).toBe(short);
	});
});
