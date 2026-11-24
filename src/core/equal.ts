/** Structural equality of plain data (objects, arrays, primitives). */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const keysA = Object.keys(a);
	if (keysA.length !== Object.keys(b).length) return false;
	return keysA.every((key) => Object.hasOwn(b, key) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** A string that is equal for structurally equal plain data, independent of key insertion order. */
export function canonicalString(value: unknown): string {
	return JSON.stringify(value, (_, v: unknown) =>
		v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
	);
}
