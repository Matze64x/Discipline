import { describe, expect, it } from 'vitest';
import {
	addHabit,
	compareEntries,
	compareHabits,
	deleteHabit,
	entryKey,
	EMPTY_DATA,
	merge,
	moveHabit,
	parseDiscipline,
	planImport,
	serializeDiscipline,
	setArchived,
	setEntry,
	setPreferences,
	toggleCheck,
	updateHabit,
	type CivilDate,
	type DisciplineData,
	type HabitDraft,
	type Id,
	type UtcSeconds,
} from '../../src/core';
import { randomData, randomEdit } from './random-data';

const [T0, T1, T2] = [1_800_000_000, 1_800_000_100, 1_800_000_200] as UtcSeconds[] as [UtcSeconds, UtcSeconds, UtcSeconds];
const day = (text: string) => text as CivilDate;
const D1 = day('2026-11-23');
const D2 = day('2026-11-24');

const READ: HabitDraft = { name: 'Read', kind: 'amount', unit: 'min', goal: { period: 'day', days: [1, 2, 3, 4, 5, 6, 7], target: 30 }, color: '#3a86ff', start: day('2026-11-01') };
const RUN: HabitDraft = { name: 'Run', kind: 'check', unit: '', goal: { period: 'week', target: 3 }, color: '#ff006e', start: day('2026-11-01') };

/** A base with two habits and an entry each */
function setup() {
	const a = addHabit(EMPTY_DATA, READ, T0);
	const b = addHabit(a.data, RUN, T0);
	const base = toggleCheck(setEntry(b.data, a.id, D1, 30, T0), b.id, D1, T0);
	return { base, read: a.id, run: b.id };
}

function expectValid(data: DisciplineData): void {
	const result = parseDiscipline(serializeDiscipline(data));
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	expect(result.data).toEqual(data);
	expect([...data.habits].sort(compareHabits)).toEqual(data.habits);
	expect([...data.entries].sort(compareEntries)).toEqual(data.entries);
}

function conflictReasons(result: ReturnType<typeof merge>): string[] {
	return [...result.conflicts.habits.map((c) => `habit ${c.reason}`), ...result.conflicts.entries.map((c) => `entry ${c.reason}`)];
}

describe('merge scenarios', () => {
	it('takes one-sided changes from both sides', () => {
		const { base, read, run } = setup();
		const ours = setEntry(base, read, D2, 45, T1);
		const theirs = toggleCheck(base, run, D2, T1);
		const result = merge(base, ours, theirs);
		expect(new Set(result.data.entries.map(entryKey))).toEqual(new Set([`${read}/${D1}`, `${run}/${D1}`, `${read}/${D2}`, `${run}/${D2}`]));
		expect(result.data.entries).toHaveLength(4);
		expect(conflictReasons(result)).toEqual([]);
		expectValid(result.data);
	});

	it('carries deletions over', () => {
		const { base, read, run } = setup();
		const ours = toggleCheck(base, run, D1, T1);
		const theirs = setEntry(base, read, D1, null, T1);
		expect(merge(base, ours, theirs).data.entries).toEqual([]);
	});

	it('the later edit wins when both changed an entry', () => {
		const { base, read } = setup();
		const ours = setEntry(base, read, D1, 40, T2);
		const theirs = setEntry(base, read, D1, 50, T1);
		const result = merge(base, ours, theirs);
		expect(result.data.entries.find((e) => e.habit === read)!.value).toBe(40);
		expect(conflictReasons(result)).toEqual(['entry changed-on-both-sides']);
		expect(merge(base, theirs, ours).data).toEqual(result.data);
	});

	it('both adding the same entry differently: the later wins', () => {
		const { base, read } = setup();
		const result = merge(base, setEntry(base, read, D2, 10, T1), setEntry(base, read, D2, 20, T2));
		expect(result.data.entries.find((e) => e.date === D2)!.value).toBe(20);
	});

	it('keeps an entry changed on one side and deleted on the other', () => {
		const { base, read } = setup();
		const result = merge(base, setEntry(base, read, D1, 60, T1), setEntry(base, read, D1, null, T2));
		expect(result.data.entries.find((e) => e.habit === read)!.value).toBe(60);
		expect(conflictReasons(result)).toEqual(['entry deleted-and-changed']);
	});

	it('merges a rename, a move and archiving of the same habit without a conflict', () => {
		const { base, read, run } = setup();
		const ours = updateHabit(base, read, { ...READ, name: 'Read books' }, D2, T1);
		const theirs = setArchived(moveHabit(base, read, null, T2), read, D2, T2);
		const result = merge(base, ours, theirs);
		expect(result.data.habits.map((h) => h.id)).toEqual([run, read]);
		expect(result.data.habits[1]).toMatchObject({ name: 'Read books', archived: D2, edited: T2 + 1 }); // (stamped twice at T2: moved, then archived)
		expect(conflictReasons(result)).toEqual([]);
		expect(merge(base, theirs, ours).data).toEqual(result.data);
	});

	it('a rename and a unit change on different sides both survive; two renames: the later wins', () => {
		const { base, read } = setup();
		const both = merge(base, updateHabit(base, read, { ...READ, name: 'Mine' }, D2, T2), updateHabit(base, read, { ...READ, unit: 'pages' }, D2, T1));
		expect(both.data.habits[0]).toMatchObject({ name: 'Mine', unit: 'pages' });
		expect(conflictReasons(both)).toEqual([]);
		const renamed = merge(base, updateHabit(base, read, { ...READ, name: 'Mine' }, D2, T2), updateHabit(base, read, { ...READ, name: 'Theirs' }, D2, T1));
		expect(renamed.data.habits[0]!.name).toBe('Mine');
		expect(conflictReasons(renamed)).toEqual(['habit changed-on-both-sides']);
	});

	it('deleting a habit removes its entries on the other side too', () => {
		const { base, read } = setup();
		const result = merge(base, deleteHabit(base, read), base);
		expect(result.data.habits.map((h) => h.name)).toEqual(['Run']);
		expect(result.data.entries.every((e) => e.habit !== read)).toBe(true);
	});

	it('restores a deleted habit the other side entered something for', () => {
		const { base, read } = setup();
		const ours = deleteHabit(base, read);
		const theirs = setEntry(base, read, D2, 15, T1);
		const result = merge(base, ours, theirs);
		expect(result.data.habits.map((h) => h.name)).toEqual(['Read', 'Run']);
		// with its whole history, not just the new entry
		expect(result.data.entries.filter((e) => e.habit === read).map((e) => e.date)).toEqual([D1, D2]);
		expect(conflictReasons(result)).toEqual(['habit deleted-habit-in-use']);
		expectValid(result.data);
	});

	it('a habit renamed on one side and deleted on the other keeps its entries', () => {
		const { base, run } = setup();
		const result = merge(base, deleteHabit(base, run), updateHabit(base, run, { ...RUN, name: 'Jog' }, D2, T1));
		expect(result.data.habits.find((h) => h.id === run)!.name).toBe('Jog');
		expect(result.data.entries.filter((e) => e.habit === run).map((e) => e.date)).toEqual([D1]);
		expect(conflictReasons(result)).toEqual(['habit deleted-and-changed']);
		expectValid(result.data);
	});

	it('checking off the same day on both sides is no conflict', () => {
		const { base, run } = setup();
		const result = merge(base, toggleCheck(base, run, D2, T1), toggleCheck(base, run, D2, T2));
		expect(conflictReasons(result)).toEqual([]);
		expect(result.data.entries.find((e) => e.date === D2)!.edited).toBe(T2);
	});

	it('merges each part of a habit on its own, deciding only the parts both changed', () => {
		const { base, read, run } = setup();
		// ours renames (later); theirs renames too, changes the goal and moves it to the end
		const ours = updateHabit(base, read, { ...READ, name: 'Mine' }, D2, T2);
		const goal = { period: 'week', target: 200 } as const;
		const theirs = moveHabit(updateHabit(base, read, { ...READ, name: 'Theirs', goal }, D2, T1), read, null, T1);
		const result = merge(base, ours, theirs);
		const kept = result.data.habits.find((h) => h.id === read)!;
		expect(kept.name).toBe('Mine');
		expect(kept.goals.at(-1)).toMatchObject(goal);
		expect(result.data.habits.map((h) => h.id)).toEqual([run, read]);
		expect(conflictReasons(result)).toEqual(['habit changed-on-both-sides']);
		expect(merge(base, theirs, ours).data).toEqual(result.data);
	});

	it('the same change on both sides is no conflict', () => {
		const { base, read } = setup();
		const result = merge(base, updateHabit(base, read, { ...READ, name: 'Same' }, D2, T1), updateHabit(base, read, { ...READ, name: 'Same' }, D2, T2));
		expect(result.data.habits[0]).toMatchObject({ name: 'Same', edited: T2 });
		expect(conflictReasons(result)).toEqual([]);
	});

	it('an archive day kept through the amounts fix-up survives merging again', () => {
		const { base, read } = setup();
		const empty = setEntry(base, read, D1, null, T0);
		const pc = setArchived(setEntry(empty, read, D1, 25, T1), read, D2, T1);
		const phone = updateHabit(empty, read, { ...RUN, name: 'Read' }, D2, T2);
		const m = merge(empty, pc, phone).data;
		expect(m.habits.find((h) => h.id === read)).toMatchObject({ kind: 'amount', archived: D2 });
		expect(merge(empty, m, phone).data).toEqual(m);
		expect(merge(empty, phone, m).data).toEqual(m);
	});

	it('archived on both sides from different days: from the earlier one, no conflict', () => {
		const { base, read } = setup();
		const result = merge(base, setArchived(base, read, D2, T1), setArchived(base, read, D1, T2));
		expect(result.data.habits[0]!.archived).toBe(D1);
		expect(conflictReasons(result)).toEqual([]);
	});

	it('a check habit that got amounts on the other side becomes an amount habit', () => {
		const { base, read } = setup();
		const empty = setEntry(base, read, D1, null, T0);
		const ours = updateHabit(empty, read, { ...RUN, name: 'Read' }, D2, T1);
		const theirs = setEntry(empty, read, D2, 25, T2);
		const result = merge(empty, ours, theirs);
		// with the amount version's unit and goals, and the check side's rename
		expect(result.data.habits.find((h) => h.id === read)).toMatchObject({ kind: 'amount', unit: 'min', goals: [{ period: 'day', target: 30 }] });
		expect(conflictReasons(result)).toEqual(['habit amounts-for-check-habit']);
		expectValid(result.data);
		// stable: merging the result again with either side changes nothing
		expect(merge(empty, result.data, ours).data).toEqual(result.data);
		expect(merge(empty, theirs, result.data).data).toEqual(result.data);
	});

	it('without a base, combines both and deletes nothing', () => {
		const { base, read } = setup();
		const ours = deleteHabit(base, read);
		const result = merge(null, ours, base);
		expect(result.data).toEqual(base);
	});

	it('reports the versions of a conflict', () => {
		const { base, read } = setup();
		const ours = setEntry(base, read, D1, 40, T2);
		const theirs = setEntry(base, read, D1, 50, T1);
		const [conflict] = merge(base, ours, theirs).conflicts.entries;
		expect(conflict).toMatchObject({ key: `${read}/${D1}`, base: { value: 30 }, ours: { value: 40 }, theirs: { value: 50 }, kept: { value: 40 } });
	});
});

describe('merging the preferences', () => {
	it('takes a change from either side, field by field', () => {
		const { base } = setup();
		const ours = setPreferences(base, { dayStart: 240 }, T1);
		const theirs = setPreferences(base, { weekStart: 7 }, T2);
		for (const [a, b] of [[ours, theirs], [theirs, ours]] as const) {
			expect(merge(base, a, b).data.preferences).toEqual({ dayStart: 240, weekStart: 7, edited: T2 });
		}
		expect(merge(base, ours, base).data.preferences).toEqual(ours.preferences);
		expect(merge(base, base, ours).data.preferences).toEqual(ours.preferences);
	});

	it('changed on both sides: the later change wins, from either side', () => {
		const { base } = setup();
		const ours = setPreferences(base, { dayStart: 240 }, T2);
		const theirs = setPreferences(base, { dayStart: 60 }, T1);
		expect(merge(base, ours, theirs).data.preferences.dayStart).toBe(240);
		expect(merge(base, theirs, ours).data.preferences.dayStart).toBe(240);
	});

	it('an import keeps the newer preferences; a file without changes keeps ours', () => {
		const { base } = setup();
		const changed = setPreferences(base, { weekStart: 7 }, T1);
		expect(merge(null, base, changed).data.preferences.weekStart).toBe(7);
		expect(merge(null, changed, base).data.preferences.weekStart).toBe(7);
		expect(merge(null, changed, EMPTY_DATA).data.preferences).toEqual(changed.preferences);
		// set back to the default later: an older file doesn't bring the old value back
		const back = setPreferences(changed, { weekStart: 1 }, T2);
		expect(merge(null, back, changed).data.preferences).toEqual(back.preferences);
		expect(merge(null, changed, back).data.preferences).toEqual(back.preferences);
	});
});

describe('import', () => {
	it('adds and merges, never deletes', () => {
		const { base, read } = setup();
		const working = deleteHabit(base, read);
		const plan = planImport(working, setEntry(base, read, D2, 5, T1));
		expect(plan.next.habits).toHaveLength(2);
		expect(plan.changes.habits).toEqual({ added: 1, changed: 0, deleted: 0 });
		expect(plan.changes.entries).toEqual({ added: 2, changed: 0, deleted: 0 });
		expect(plan.warnings).toEqual([]);
	});

	it('warns about an unrelated file', () => {
		const { base } = setup();
		const other = addHabit(EMPTY_DATA, READ, T0).data;
		expect(planImport(base, other).warnings).toEqual(['unrelated-file']);
		expect(planImport(EMPTY_DATA, other).warnings).toEqual([]);
	});
});

describe('merge properties (random documents and edits)', () => {
	// half of them dense: few days and close timestamps, so both sides often hit the same records
	const cases = Array.from({ length: 400 }, (_, i) => {
		const base = randomData(i + 1);
		const dense = i % 2 === 1;
		return { base, ours: randomEdit(base, 10_000 + i, 8, undefined, dense), theirs: randomEdit(base, 20_000 + i, 8, undefined, dense) };
	});

	it('merging the result again with either side changes nothing', () => {
		for (const { base, ours, theirs } of cases) {
			const m = merge(base, ours, theirs).data;
			expect(merge(base, m, theirs).data).toEqual(m);
			expect(merge(base, ours, m).data).toEqual(m);
			expect(merge(base, m, ours).data).toEqual(m);
		}
	});

	it('a habit disappears only if one side deleted it and the other left it as it was', () => {
		for (const { base, ours, theirs } of cases) {
			const kept = new Set(merge(base, ours, theirs).data.habits.map((h) => h.id));
			for (const h of [...ours.habits, ...theirs.habits]) {
				if (kept.has(h.id)) continue;
				const b = base.habits.find((x) => x.id === h.id);
				expect(b, h.id).toEqual(h);
			}
		}
	});

	it('a kept habit keeps the entries of a side that has it', () => {
		for (const { base, ours, theirs } of cases) {
			const result = merge(base, ours, theirs).data;
			const keys = new Set(result.entries.map(entryKey));
			for (const h of result.habits) {
				const [o, t] = [ours.habits.some((x) => x.id === h.id), theirs.habits.some((x) => x.id === h.id)];
				if (o === t) continue;
				for (const e of (o ? ours : theirs).entries) if (e.habit === h.id) expect(keys.has(entryKey(e)), entryKey(e)).toBe(true);
			}
		}
	});

	it('a habit part changed on one side only survives', () => {
		for (const { base, ours, theirs } of cases) {
			const result = merge(base, ours, theirs).data;
			for (const h of ours.habits) {
				const [b, t, r] = [base.habits.find((x) => x.id === h.id), theirs.habits.find((x) => x.id === h.id), result.habits.find((x) => x.id === h.id)];
				if (!b || !t || !r || r.kind !== t.kind && r.kind !== h.kind) continue;
				for (const [part, get] of Object.entries({ name: (x: typeof h) => x.name, color: (x: typeof h) => x.color, position: (x: typeof h) => x.position })) {
					if (get(h) !== get(b) && get(t) === get(b)) expect(get(r), part).toEqual(get(h));
				}
			}
		}
	});

	it('merging with an unchanged side is a no-op', () => {
		for (const { base, ours } of cases) {
			expect(merge(base, ours, base).data).toEqual(ours);
			expect(merge(base, base, ours).data).toEqual(ours);
			expect(merge(base, ours, ours).data).toEqual(ours);
			expect(merge(null, ours, ours).data).toEqual(ours);
		}
	});

	it('the result is always valid and sorted', () => {
		for (const { base, ours, theirs } of cases) expectValid(merge(base, ours, theirs).data);
		for (const { ours, theirs } of cases) expectValid(merge(null, ours, theirs).data);
	});

	it('the result does not depend on which side merges', () => {
		for (const { base, ours, theirs } of cases) expect(merge(base, theirs, ours).data).toEqual(merge(base, ours, theirs).data);
	});

	it('every one-sided change survives, unless a conflict names it', () => {
		for (const { base, ours, theirs } of cases) {
			const result = merge(base, ours, theirs);
			const named = new Set([...result.conflicts.habits.map((c) => c.key), ...result.conflicts.entries.map((c) => c.key)]);
			const resultEntries = new Map(result.data.entries.map((e) => [entryKey(e), e]));
			const baseEntries = new Map(base.entries.map((e) => [entryKey(e), e]));
			const theirsEntries = new Map(theirs.entries.map((e) => [entryKey(e), e]));
			for (const e of ours.entries) {
				const key = entryKey(e);
				const changedByUs = JSON.stringify(baseEntries.get(key)) !== JSON.stringify(e);
				const theirsUnchanged = JSON.stringify(baseEntries.get(key)) === JSON.stringify(theirsEntries.get(key));
				// (a habit deleted on the other side takes its unchanged entries along)
				if (changedByUs && theirsUnchanged && !named.has(key)) expect(resultEntries.get(key), key).toEqual(e);
			}
		}
	});

	it('nothing vanishes silently: a missing entry was deleted by one side, or its habit was', () => {
		for (const { base, ours, theirs } of cases) {
			const result = merge(base, ours, theirs);
			const inResult = new Set(result.data.entries.map(entryKey));
			const inBase = new Set(base.entries.map(entryKey));
			const [oursKeys, theirsKeys] = [new Set(ours.entries.map(entryKey)), new Set(theirs.entries.map(entryKey))];
			for (const key of new Set([...oursKeys, ...theirsKeys])) {
				if (inResult.has(key)) continue;
				// only an entry that existed before can disappear, by a deletion on the side that lacks it
				expect(inBase.has(key), key).toBe(true);
				expect(oursKeys.has(key) && theirsKeys.has(key), key).toBe(false);
			}
		}
	});

	it('finds conflicts in the random cases (the generator overlaps edits)', () => {
		const total = cases.reduce((n, { base, ours, theirs }) => n + conflictReasons(merge(base, ours, theirs)).length, 0);
		expect(total).toBeGreaterThan(20);
	});
});

describe('merge edge cases', () => {
	it('restores a deleted habit only from versions that have it', () => {
		const { base, run } = setup();
		const ours = deleteHabit(base, run);
		const theirs = toggleCheck(toggleCheck(base, run, D1, T1), run, D1, T2);
		const result = merge(base, ours, theirs);
		// re-checked on their side: a change, so the habit comes back
		expect(result.data.habits.some((h) => h.id === run)).toBe(true);
		expect(result.conflicts.habits.map((c) => c.reason)).toEqual(['deleted-habit-in-use']);
	});

	it('refuses inconsistent input', () => {
		expect(merge(EMPTY_DATA, EMPTY_DATA, EMPTY_DATA).data).toEqual(EMPTY_DATA);
		expect(() => merge(EMPTY_DATA, { ...EMPTY_DATA, habits: [], entries: [{ habit: '1' as Id, date: D1, value: 1, edited: T0 }] }, EMPTY_DATA)).toThrow(/inconsistent/);
	});
});
