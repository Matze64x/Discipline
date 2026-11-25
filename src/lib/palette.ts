/**
 * Default colors for new habits ("#rrggbb"), distinguishable in light and dark mode: a new habit
 * gets the first one that isn't used yet. (Placeholders until the color scheme is decided.)
 */
export const HABIT_COLORS: readonly string[] = [
	'#3a86ff', // blue
	'#ff006e', // pink
	'#06d6a0', // green
	'#fb8500', // orange
	'#8338ec', // purple
	'#00b4d8', // cyan
	'#e63946', // red
	'#ffbe0b', // yellow
	'#2a9d8f', // teal
	'#8d99ae', // grey
];

/** The first default color no habit uses yet (else the first one) */
export function unusedColor(used: Iterable<string>): string {
	const taken = new Set(used);
	return HABIT_COLORS.find((c) => !taken.has(c)) ?? HABIT_COLORS[0]!;
}

/** Black or white, whichever reads better on a color ("#rrggbb"; by its relative luminance) */
export function textOn(color: string): string {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = parseInt(color.slice(i, i + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.179 ? '#000000' : '#ffffff';
}

/** CSS variables that make a habit's color the accent (its dialogs and stats page) */
export function accentStyle(color: string): string {
	return [
		`--accent: ${color}`,
		`--accent-text: ${textOn(color)}`,
		`--accent-soft: color-mix(in srgb, ${color} 15%, transparent)`,
		`--accent-soft-on-surface: color-mix(in srgb, ${color} 15%, var(--surface))`,
	].join('; ');
}
