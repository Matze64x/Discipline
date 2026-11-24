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
