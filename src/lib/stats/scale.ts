/** Axis scales for the charts */

/** Round grid steps (1, 2, 2.5, 5 × a power of ten) up to at least `max` (3 or 4 steps) */
export function niceTicks(max: number): number[] {
	if (!(max > 0)) return [0, 1];
	const raw = max / 3;
	const power = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map((f) => f * power).find((s) => s >= raw)!;
	const ticks: number[] = [];
	for (let t = 0; t < max + step; t += step) ticks.push(Math.round(t * 1000) / 1000);
	return ticks;
}
