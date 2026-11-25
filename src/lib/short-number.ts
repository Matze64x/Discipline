/** Numbers written short, for small spaces (Today's round mark). */

// like `formatValue` (display.ts): no grouping, latin digits, the locale's decimal separator
const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3, useGrouping: false, numberingSystem: 'latn' });
/** Rounded down: a short number never claims more than was done ("10k" for 9950 would look met) */
const down = (value: number, decimals: number) => numbers.format(Math.floor(value * 10 ** decimals + 1e-9) / 10 ** decimals);

/** A number in about 4 characters: "7", "12.5", "600", "1.2k", "15k", "2.5M"; never more than it is, and never "0" for something */
export function formatShort(value: number): string {
	if (value >= 1e6) return `${down(value / 1e6, value >= 1e7 ? 0 : 1)}M`;
	if (value >= 1e4) return `${down(value / 1000, 0)}k`;
	if (value >= 1000) return `${down(value / 1000, 1)}k`;
	if (value >= 100) return down(value, 0);
	if (value >= 10) return down(value, 1);
	if (value > 0 && value < 0.01) return down(value, 3);
	return down(value, 2);
}
