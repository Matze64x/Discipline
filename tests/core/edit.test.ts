import { describe, expect, it } from 'vitest';
import {
	addHabit,
	addToEntry,
	remainingOf,
	cleanText,
	compareEntries,
	compareHabits,
	deleteHabit,
	EditError,
	EMPTY_DATA,
	entryOn,
	goalOn,
	moveHabit,
	parseDiscipline,
	parseValueInput,
	roundValue,
	serializeDiscipline,
	setArchived,
	setEntry,
	setPreferences,
	toDraft,
	toggleCheck,
	updateHabit,
	type CivilDate,
	type DisciplineData,
	type Habit,
	type HabitDraft,
	type Id,
	type UtcSeconds,
} from '../../src/core';
import { generator, randomData, randomEdit } from './random-data';

const T1 = 1_800_000_000 as UtcSeconds;
const T2 = 1_800_000_100 as UtcSeconds;
const day = (text: string) => text as CivilDate;
const TODAY = day('2026-11-24');

const READ: HabitDraft = { name: ' Read ', kind: 'amount', unit: 'min', goal: { period: 'day', days: [1, 2, 3, 4, 5, 6, 7], target: 30 }, color: '#3A86FF', start: day('2026-11-01') };
const RUN: HabitDraft = { name: 'Run', kind: 'check', unit: '', goal: { period: 'week', target: 3 }, color: '#ff006e', start: day('2026-11-01') };

/** The data must stay valid: it survives a round trip through the file format unchanged */
function expectValid(data: DisciplineData): void {
	const result = parseDiscipline(serializeDiscipline(data));
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	expect(result.data).toEqual(data);
	expect([...data.habits].sort(compareHabits)).toEqual(data.habits);
	expect([...data.entries].sort(compareEntries)).toEqual(data.entries);
}

function withHabits(): { data: DisciplineData; read: Id; run: Id } {
	const a = addHabit(EMPTY_DATA, READ, T1);
	const b = addHabit(a.data, RUN, T1);
	return { data: b.data, read: a.id, run: b.id };
}

const habit = (data: DisciplineData, id: Id): Habit => data.habits.find((h) => h.id === id)!;

describe('habits', () => {
	it('adds habits at the end, cleaned up', () => {
		const { data, read, run } = withHabits();
		expect(data.habits.map((h) => h.id)).toEqual([read, run]);
		expect(data.habits[0]).toMatchObject({ name: 'Read', color: '#3a86ff', position: 1, archived: null, edited: T1, goals: [{ from: '2026-11-01', period: 'day', target: 30 }] });
		expect(data.habits[1]).toMatchObject({ position: 2 });
		expect(toDraft(data.habits[0]!)).toEqual({ ...READ, name: 'Read', color: '#3a86ff' });
		expectValid(data);
	});

	it('drops the unit of a check habit', () => {
		expect(addHabit(EMPTY_DATA, { ...RUN, unit: 'x' }, T1).data.habits[0]!.unit).toBe('');
	});

	it.each([
		['an empty name', { ...READ, name: ' \n\u0000' }],
		['a bad goal', { ...RUN, goal: { period: 'week', target: 8 } }],
		['a bad target', { ...READ, goal: { period: 'day', days: [1], target: 0 } }],
		['a bad color', { ...READ, color: 'red' }],
		['a bad start', { ...READ, start: day('2026-02-30') }],
		['a start outside the years', { ...READ, start: day('1899-12-31') }],
	] as [string, HabitDraft][])('refuses %s', (_, draft) => {
		expect(() => addHabit(EMPTY_DATA, draft, T1)).toThrow(EditError);
	});

	it('refuses invalid times', () => {
		for (const now of [1.5, Date.now(), -1e12, NaN]) expect(() => addHabit(EMPTY_DATA, READ, now as UtcSeconds), String(now)).toThrow(EditError);
	});

	it('updates a habit, and only stamps real changes', () => {
		const { data, read } = withHabits();
		expect(updateHabit(data, read, READ, TODAY, T2)).toBe(data);
		expect(updateHabit(data, read, toDraft(habit(data, read)), TODAY, T2, habit(data, read))).toBe(data);
		const renamed = updateHabit(data, read, { ...READ, name: 'Read books' }, TODAY, T2, habit(data, read));
		expect(renamed.habits[0]).toMatchObject({ name: 'Read books', edited: T2 });
		expect(renamed.habits[1]).toBe(data.habits[1]);
		expectValid(renamed);
	});

	it('refuses to overwrite a change made meanwhile', () => {
		const { data, read } = withHabits();
		const before = data.habits[0]!;
		const changed = updateHabit(data, read, { ...READ, name: 'Elsewhere' }, TODAY, T2);
		expect(() => updateHabit(changed, read, { ...READ, name: 'Mine' }, TODAY, T2, before)).toThrow(/changed meanwhile/);
	});

	it('never stamps a change earlier than the version it changes', () => {
		const { data, read } = withHabits();
		const renamed = updateHabit(data, read, { ...READ, name: 'Later' }, TODAY, (T1 - 500) as UtcSeconds);
		expect(habit(renamed, read).edited).toBe(T1 + 1);
		const set = setEntry(data, read, TODAY, 5, T2);
		expect(setEntry(set, read, TODAY, 6, T1).entries[0]!.edited).toBe(T2 + 1);
	});

	it('keeps earlier goals when the goal changes', () => {
		const { data, read } = withHabits();
		const more = updateHabit(data, read, { ...READ, goal: { period: 'day', days: [1, 2, 3, 4, 5, 6, 7], target: 45 } }, TODAY, T2);
		expect(habit(more, read).goals.map((g) => [g.from, g.target])).toEqual([
			['2026-11-01', 30],
			['2026-11-24', 45],
		]);
		expect(goalOn(habit(more, read), day('2026-11-23'))!.target).toBe(30);
		expect(goalOn(habit(more, read), TODAY)!.target).toBe(45);
		expect(goalOn(habit(more, read), day('2026-10-31'))).toBeUndefined();
		// changed again the same day: replaces today's goal
		const again = updateHabit(more, read, { ...READ, goal: { period: 'week', target: 200 } }, TODAY, T2);
		expect(habit(again, read).goals.map((g) => [g.from, g.period])).toEqual([
			['2026-11-01', 'day'],
			['2026-11-24', 'week'],
		]);
		// and back: today's change disappears
		expect(habit(updateHabit(again, read, READ, TODAY, T2), read).goals).toEqual(habit(data, read).goals);
		// from the start: replaces all
		expect(habit(updateHabit(more, read, { ...READ, goal: { period: 'month', target: 900 } }, day('2026-10-01'), T2), read).goals).toEqual([{ from: '2026-11-01', period: 'month', target: 900 }]);
		expectValid(again);
	});

	it('moves the start, keeping the goal in effect then', () => {
		const { data, read } = withHabits();
		const more = updateHabit(data, read, { ...READ, goal: { period: 'day', days: [1], target: 45 } }, TODAY, T2);
		const later = updateHabit(more, read, { ...READ, start: day('2026-11-28'), goal: { period: 'day', days: [1], target: 45 } }, TODAY, T2);
		expect(habit(later, read).goals).toEqual([{ from: '2026-11-28', period: 'day', days: [1], target: 45 }]);
		const middle = updateHabit(more, read, { ...READ, start: day('2026-11-10'), goal: { period: 'day', days: [1], target: 45 } }, TODAY, T2);
		expect(habit(middle, read).goals.map((g) => [g.from, g.target])).toEqual([
			['2026-11-10', 30],
			['2026-11-24', 45],
		]);
		const earlier = updateHabit(more, read, { ...READ, start: day('2026-10-01'), goal: { period: 'day', days: [1], target: 45 } }, TODAY, T2);
		expect(habit(earlier, read).goals.map((g) => g.from)).toEqual(['2026-10-01', '2026-11-24']);
	});

	it('turns a check habit into an amount habit, but not back once amounts are entered', () => {
		const { data, run, read } = withHabits();
		const done = toggleCheck(data, run, day('2026-11-02'), T1);
		const amount = updateHabit(done, run, { ...RUN, kind: 'amount', unit: 'km', goal: { period: 'week', target: 20 } }, TODAY, T2);
		expect(habit(amount, run).goals).toEqual([{ from: '2026-11-01', period: 'week', target: 20 }]);
		expect(amount.entries).toEqual(done.entries);
		expectValid(amount);
		// all values are 1: fine to go back
		expectValid(updateHabit(amount, run, RUN, TODAY, T2));
		const typed = setEntry(data, read, day('2026-11-02'), 45, T1);
		expect(() => updateHabit(typed, read, { ...RUN }, TODAY, T2)).toThrow(/can’t become a yes\/no habit/);
	});

	it('archives from a day and makes active again', () => {
		const { data, read } = withHabits();
		const archived = setArchived(data, read, TODAY, T2);
		expect(archived.habits[0]).toMatchObject({ archived: TODAY, edited: T2 });
		expect(setArchived(archived, read, TODAY, T2)).toBe(archived);
		expect(setArchived(archived, read, null, T2).habits[0]!.archived).toBeNull();
		expect(() => setArchived(data, read, day('nonsense'), T2)).toThrow(EditError);
	});

	it('deletes a habit with its entries', () => {
		const { data, read, run } = withHabits();
		const filled = setEntry(toggleCheck(data, run, day('2026-11-02'), T1), read, day('2026-11-02'), 10, T1);
		const deleted = deleteHabit(filled, read);
		expect(deleted.habits.map((h) => h.id)).toEqual([run]);
		expect(deleted.entries.map((e) => e.habit)).toEqual([run]);
		expectValid(deleted);
	});

	it('throws for unknown habits', () => {
		const { data } = withHabits();
		expect(() => deleteHabit(data, '1' as Id)).toThrow(EditError);
		expect(() => setEntry(data, '1' as Id, day('2026-11-02'), 1, T1)).toThrow(EditError);
	});
});

describe('moving habits', () => {
	function habits(...positions: number[]): DisciplineData {
		let data = EMPTY_DATA;
		for (let i = 0; i < positions.length; i++) data = addHabit(data, { ...RUN, name: String.fromCharCode(65 + i) }, T1).data;
		// (positions set directly, e.g. to make ties as two devices adding a habit each would)
		const named = (name: string) => data.habits.find((h) => h.name === name)!;
		return { ...data, habits: positions.map((p, i) => ({ ...named(String.fromCharCode(65 + i)), position: p })).sort(compareHabits) };
	}
	const names = (data: DisciplineData) => data.habits.map((h) => h.name).join('');
	const id = (data: DisciplineData, name: string) => data.habits.find((h) => h.name === name)!.id;

	it('moves only the moved habit', () => {
		const data = habits(1, 2, 3);
		const moved = moveHabit(data, id(data, 'C'), id(data, 'A'), T2);
		expect(names(moved)).toBe('CAB');
		expect(moved.habits.filter((h) => h.edited === T2).map((h) => h.name)).toEqual(['C']);
		expect(names(moveHabit(data, id(data, 'A'), id(data, 'C'), T2))).toBe('BAC');
		expect(names(moveHabit(data, id(data, 'A'), null, T2))).toBe('BCA');
		expect(moveHabit(data, id(data, 'B'), id(data, 'C'), T2)).toBe(data);
		expect(moveHabit(data, id(data, 'C'), null, T2)).toBe(data);
		expectValid(moved);
	});

	it('renumbers ties, stamping only habits whose position changes', () => {
		const data = habits(1, 2, 3, 3);
		// C and D tie, so their order depends on their ids: move A between them
		const [first, last] = [data.habits[2]!.name, data.habits[3]!.name];
		const moved = moveHabit(data, id(data, 'A'), id(data, last), T2);
		expect(names(moved)).toBe(`B${first}A${last}`);
		expect(moved.habits.map((h) => h.position)).toEqual([1, 2, 3, 4]);
		expect(moved.habits.filter((h) => h.edited === T2).map((h) => h.name).sort()).toEqual(['A', 'B', 'C', 'D']);
		const fewer = habits(1, 2, 4, 4);
		const tied = fewer.habits[3]!;
		expect(moveHabit(fewer, tied.id, fewer.habits[2]!.id, T2).habits.filter((h) => h.edited === T2).map((h) => h.name)).toEqual([tied.name]); // (room at 3: no renumbering)
	});

	it('renumbers when there is no room left', () => {
		let data = habits(1, 2, 3);
		// keep moving the last habit between the first two
		for (let i = 0; i < 80; i++) {
			data = moveHabit(data, data.habits.at(-1)!.id, data.habits[1]!.id, T2);
			expectValid(data);
		}
		expect(data.habits.some((h) => h.position === 1)).toBe(true);
	});

	it('stays within the position limits', () => {
		const data = habits(-1e9, 1e9);
		expect(names(moveHabit(data, id(data, 'B'), id(data, 'A'), T2))).toBe('BA');
		expectValid(moveHabit(data, id(data, 'B'), id(data, 'A'), T2));
		const added = addHabit(data, RUN, T2).data;
		expect(added.habits.at(-1)!.name).toBe('Run');
		expectValid(added);
	});

	it('refuses invalid moves', () => {
		const data = habits(1, 2);
		expect(() => moveHabit(data, id(data, 'A'), id(data, 'A'), T2)).toThrow(EditError);
		expect(() => moveHabit(data, id(data, 'A'), '1' as Id, T2)).toThrow(EditError);
	});
});

describe('entries', () => {
	it('toggles a check habit', () => {
		const { data, run } = withHabits();
		const done = toggleCheck(data, run, day('2026-11-02'), T1);
		expect(entryOn(done, run, day('2026-11-02'))).toEqual({ habit: run, date: '2026-11-02', value: 1, edited: T1 });
		expect(toggleCheck(done, run, day('2026-11-02'), T2).entries).toEqual([]);
	});

	it('sets, changes and clears amounts, and only stamps real changes', () => {
		const { data, read } = withHabits();
		const set = setEntry(data, read, day('2026-11-02'), 30, T1);
		expect(setEntry(set, read, day('2026-11-02'), 30, T2)).toBe(set);
		const changed = setEntry(set, read, day('2026-11-02'), 45.5, T2);
		expect(changed.entries).toEqual([{ habit: read, date: '2026-11-02', value: 45.5, edited: T2 }]);
		expect(setEntry(changed, read, day('2026-11-02'), null, T2).entries).toEqual([]);
		expect(setEntry(data, read, day('2026-11-02'), null, T2)).toBe(data);
	});

	it('refuses invalid values and days', () => {
		const { data, read, run } = withHabits();
		for (const value of [0, -1, 0.0001, Infinity, NaN, 1e9 + 1]) expect(() => setEntry(data, read, day('2026-11-02'), value, T1), String(value)).toThrow(EditError);
		expect(() => setEntry(data, run, day('2026-11-02'), 2, T1)).toThrow(EditError);
		for (const date of ['garbage', '2026-02-30', '2201-01-01']) expect(() => setEntry(data, run, day(date), 1, T1), date).toThrow(EditError);
	});

	it('adds to an amount, starting from nothing', () => {
		const { data, read, run } = withHabits();
		const once = addToEntry(data, read, day('2026-11-02'), 1, T1);
		expect(entryOn(once, read, day('2026-11-02'))?.value).toBe(1);
		const twice = addToEntry(once, read, day('2026-11-02'), 0.2, T2);
		expect(entryOn(twice, read, day('2026-11-02'))).toEqual({ habit: read, date: '2026-11-02', value: 1.2, edited: T2 });
		expect(entryOn(addToEntry(setEntry(data, read, day('2026-11-02'), 0.1, T1), read, day('2026-11-02'), 0.2, T2), read, day('2026-11-02'))?.value).toBe(0.3);
		for (const amount of [0, -1, NaN]) expect(() => addToEntry(once, read, day('2026-11-02'), amount, T2), String(amount)).toThrow(EditError);
		expect(() => addToEntry(setEntry(data, read, day('2026-11-02'), 1e9, T1), read, day('2026-11-02'), 1, T2)).toThrow('more than an entry can hold');
		expect(() => addToEntry(data, run, day('2026-11-02'), 1, T1)).toThrow(EditError);
	});

	it('tells what is missing to meet a goal', () => {
		expect(remainingOf({ done: 20, target: 30 })).toBe(10);
		expect(remainingOf({ done: 0.1, target: 0.3 })).toBe(0.2);
		expect(remainingOf({ done: 40, target: 30 })).toBe(0);
	});

	it('rounds typed amounts to what an entry holds', () => {
		expect(roundValue(1.0005)).toBe(1.001);
		expect(roundValue(0.1 + 0.2)).toBe(0.3);
	});
});

describe('preferences', () => {
	it('change day and week start, stamped; no change is a no-op', () => {
		const { data } = withHabits();
		expect(data.preferences).toEqual({ dayStart: 0, weekStart: 1, edited: null });
		const changed = setPreferences(data, { dayStart: 240 }, T1);
		expect(changed.preferences).toEqual({ dayStart: 240, weekStart: 1, edited: T1 });
		expect(setPreferences(changed, { dayStart: 240, weekStart: 1 }, T2)).toBe(changed);
		expect(setPreferences(changed, { weekStart: 7 }, T2).preferences).toEqual({ dayStart: 240, weekStart: 7, edited: T2 });
		// a clock behind the last change still moves `edited` on
		expect(setPreferences(changed, { weekStart: 7 }, (T1 - 100) as UtcSeconds).preferences.edited).toBe(T1 + 1);
	});

	it('refuses values that can’t be chosen', () => {
		const { data } = withHabits();
		for (const dayStart of [-30, 45, 390, NaN]) expect(() => setPreferences(data, { dayStart }, T1), String(dayStart)).toThrow(EditError);
		expect(() => setPreferences(data, { weekStart: 3 as never }, T1)).toThrow(EditError);
	});
});

describe('random edits', () => {
	it('keep the data valid after every step, and repeating a step changes nothing', () => {
		for (let seed = 1; seed <= 60; seed++) {
			randomEdit(randomData(seed), seed + 1000, 30, (data) => expectValid(data));
		}
	});

	it('an unchanged draft changes nothing', () => {
		for (let seed = 1; seed <= 60; seed++) {
			const data = randomData(seed);
			for (const h of data.habits) expect(updateHabit(data, h.id, toDraft(h), generator(seed).date(), T2, h)).toBe(data);
		}
	});
});

describe('cleanText', () => {
	it('repairs text the file can’t hold', () => {
		expect(cleanText(' a\ud800b\0 ')).toBe('a�b');
		expect(cleanText('🧘')).toBe('🧘');
	});
});

describe('typed amounts', () => {
	it('accept a dot or a comma', () => {
		expect(parseValueInput('30')).toBe(30);
		expect(parseValueInput(' 2,5 ')).toBe(2.5);
		expect(parseValueInput('2.5')).toBe(2.5);
		expect(parseValueInput('.5')).toBe(0.5);
		expect(parseValueInput('3.')).toBe(3);
		expect(parseValueInput('1.0005')).toBe(1.001);
	});
	it('refuse anything else', () => {
		for (const text of ['', '0', '0,0001', '-1', '1,000.5', '1.2.3', 'abc', '1e3', '2000000000']) expect(parseValueInput(text), text).toBeNull();
	});
});
