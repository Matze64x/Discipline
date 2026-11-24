import { describe, expect, it } from 'vitest';
import {
	addHabit,
	daysLeft,
	EMPTY_DATA,
	entriesBetween,
	entriesByHabit,
	isActiveOn,
	progressOn,
	setArchived,
	setEntry,
	toggleCheck,
	updateHabit,
	type CivilDate,
	type DisciplineData,
	type HabitDraft,
	type Id,
	type UtcSeconds,
} from '../../src/core';
import { randomData } from './random-data';

const T = 1_800_000_000 as UtcSeconds;
const day = (s: string) => s as CivilDate;

const READ: HabitDraft = { name: 'Read', kind: 'amount', unit: 'min', color: '#3a86ff', start: day('2026-11-02'), goal: { period: 'day', days: [1, 2, 3, 4, 5], target: 30 } };
const RUN: HabitDraft = { name: 'Run', kind: 'check', unit: '', color: '#ff006e', start: day('2026-11-02'), goal: { period: 'week', target: 3 } };

function make(draft: HabitDraft): { data: DisciplineData; id: Id } {
	return addHabit(EMPTY_DATA, draft, T);
}

describe('progress', () => {
	it('a daily amount goal, only on the chosen weekdays', () => {
		let { data, id } = make(READ);
		data = setEntry(data, id, day('2026-11-23'), 20, T);
		const habit = () => data.habits[0]!;
		// Monday 23.11.: 20 of 30
		expect(progressOn(data, habit(), day('2026-11-23'), 1)).toMatchObject({ due: true, done: 20, target: 30, met: false, from: '2026-11-23', to: '2026-11-23' });
		data = setEntry(data, id, day('2026-11-23'), 30.5, T);
		expect(progressOn(data, habit(), day('2026-11-23'), 1)).toMatchObject({ done: 30.5, met: true });
		// Saturday: not due
		expect(progressOn(data, habit(), day('2026-11-28'), 1)).toMatchObject({ due: false, done: 0 });
	});

	it('a weekly check goal counts the days of the week, by the week start', () => {
		let { data, id } = make(RUN);
		for (const d of ['2026-11-22', '2026-11-23', '2026-11-25']) data = toggleCheck(data, id, day(d), T);
		const habit = data.habits[0]!;
		// weeks from Monday: 23.–29.11. has two
		expect(progressOn(data, habit, day('2026-11-27'), 1)).toMatchObject({ from: '2026-11-23', to: '2026-11-29', done: 2, target: 3, met: false, due: true });
		// weeks from Sunday: 22.–28.11. has three
		expect(progressOn(data, habit, day('2026-11-27'), 7)).toMatchObject({ from: '2026-11-22', to: '2026-11-28', done: 3, met: true });
	});

	it('a monthly check target is capped at the days of the month', () => {
		const { data } = make({ ...RUN, start: day('2026-01-01'), goal: { period: 'month', target: 31 } });
		expect(progressOn(data, data.habits[0]!, day('2026-02-10'), 1)).toMatchObject({ from: '2026-02-01', to: '2026-02-28', target: 28 });
		expect(progressOn(data, data.habits[0]!, day('2026-03-10'), 1)).toMatchObject({ target: 31 });
	});

	it('sums amounts without float noise', () => {
		let { data, id } = make({ ...READ, goal: { period: 'week', target: 1 } });
		data = setEntry(setEntry(data, id, day('2026-11-23'), 0.1, T), id, day('2026-11-24'), 0.2, T);
		expect(progressOn(data, data.habits[0]!, day('2026-11-24'), 1)!.done).toBe(0.3);
	});

	it('uses the goal in effect on the day', () => {
		let { data, id } = make(READ);
		data = updateHabit(data, id, { ...READ, goal: { period: 'day', days: [1, 2, 3, 4, 5], target: 45 } }, day('2026-11-24'), T);
		expect(progressOn(data, data.habits[0]!, day('2026-11-23'), 1)!.target).toBe(30);
		expect(progressOn(data, data.habits[0]!, day('2026-11-24'), 1)!.target).toBe(45);
	});

	it('nothing before the start or from the archive day on', () => {
		let { data, id } = make(READ);
		data = setArchived(data, id, day('2026-11-25'), T);
		const habit = data.habits[0]!;
		expect(isActiveOn(habit, day('2026-11-01'))).toBe(false);
		expect(isActiveOn(habit, day('2026-11-02'))).toBe(true);
		expect(isActiveOn(habit, day('2026-11-24'))).toBe(true);
		expect(isActiveOn(habit, day('2026-11-25'))).toBe(false);
		expect(progressOn(data, habit, day('2026-11-25'), 1)).toBeNull();
	});

	it('days left in the period', () => {
		const { data } = make(RUN);
		expect(daysLeft(progressOn(data, data.habits[0]!, day('2026-11-27'), 1)!, day('2026-11-27'))).toBe(3);
	});
});

describe('entries by habit', () => {
	it('matches a plain filter, for any range', () => {
		for (let seed = 1; seed <= 50; seed++) {
			const data = randomData(seed);
			const byHabit = entriesByHabit(data);
			expect(entriesByHabit(data)).toBe(byHabit);
			for (const h of data.habits) {
				const all = data.entries.filter((e) => e.habit === h.id);
				expect(byHabit.get(h.id) ?? []).toEqual(all);
				const [from, to] = [day('2025-06-01'), day('2026-03-31')];
				expect(entriesBetween(all, from, to)).toEqual(all.filter((e) => e.date >= from && e.date <= to));
			}
		}
	});
});
