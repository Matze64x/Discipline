import { describe, expect, it } from 'vitest';
import { addHabit, EMPTY_DATA, setEntry, summarizeChanges, toggleCheck, totalChanges, updateHabit, type CivilDate, type UtcSeconds } from '../../src/core';

const T = 1_800_000_000 as UtcSeconds;
const day = (s: string) => s as CivilDate;

describe('change summaries', () => {
	it('count added, changed and deleted records per kind', () => {
		const draft = { name: 'Read', kind: 'amount', unit: 'min', color: '#3a86ff', start: day('2026-11-01'), goal: { period: 'week', target: 100 } } as const;
		const a = addHabit(EMPTY_DATA, draft, T);
		const before = setEntry(setEntry(a.data, a.id, day('2026-11-02'), 10, T), a.id, day('2026-11-03'), 20, T);
		const b = addHabit(before, { ...draft, name: 'Run', kind: 'check', unit: '', goal: { period: 'week', target: 3 } }, T);
		let after = updateHabit(b.data, a.id, { ...draft, name: 'Read books' }, day('2026-11-24'), T);
		after = setEntry(after, a.id, day('2026-11-02'), 15, T);
		after = setEntry(after, a.id, day('2026-11-03'), null, T);
		after = toggleCheck(after, b.id, day('2026-11-04'), T);
		const summary = summarizeChanges(before, after);
		expect(summary).toEqual({ habits: { added: 1, changed: 1, deleted: 0 }, entries: { added: 1, changed: 1, deleted: 1 } });
		expect(totalChanges(summary)).toBe(5);
		expect(totalChanges(summarizeChanges(after, after))).toBe(0);
		expect(summarizeChanges(null, before).entries.added).toBe(2);
	});
});
