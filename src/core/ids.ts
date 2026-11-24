import type { Brand } from './brand';

/**
 * An unsigned 64-bit identifier in canonical decimal form (no sign, no leading zeros).
 * IDs exceed the precision of JS numbers, and are never calculated with, so they stay strings.
 */
export type Id = Brand<string, 'Id'>;

const UINT64_MAX = (1n << 64n) - 1n;
const ID_PATTERN = /^(0|[1-9]\d*)$/;

export function parseId(text: string): Id | null {
	if (!ID_PATTERN.test(text) || text.length > 20) return null;
	if (BigInt(text) > UINT64_MAX) return null;
	return text as Id;
}

/** Numeric comparison (as uint64), without converting to a number. */
export function compareIds(a: Id, b: Id): number {
	if (a.length !== b.length) return a.length - b.length;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** A random non-zero id, uniformly distributed over uint64, that is not in `taken`. */
export function newId(taken: ReadonlySet<string> = new Set()): Id {
	const buffer = new BigUint64Array(1);
	for (;;) {
		crypto.getRandomValues(buffer);
		const value = buffer[0]!;
		const id = value.toString() as Id;
		if (value !== 0n && !taken.has(id)) return id;
	}
}
