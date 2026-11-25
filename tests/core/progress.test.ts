import { describe, expect, it } from 'vitest';
import {
	addHabit,
	daysLeft,
	dayMarks,
	dayShare,
	timeShare,
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

const READ: HabitDraft = { name: 'Read', kind: 'amount', unit: 'min', color: '#3a86ff', start: day('2026-11-02'), goal: { period: 'day', days: [1, 2, 3, 4, 5], aim: 'build', target: 30 } };
const RUN: HabitDraft = { name: 'Run', kind: 'check', unit: '', color: '#ff006e', start: day('2026-11-02'), goal: { period: 'week', aim: 'build', target: 3 } };

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
		const { data } = make({ ...RUN, start: day('2026-01-01'), goal: { period: 'month', aim: 'build', target: 31 } });
		expect(progressOn(data, data.habits[0]!, day('2026-02-10'), 1)).toMatchObject({ from: '2026-02-01', to: '2026-02-28', target: 28 });
		expect(progressOn(data, data.habits[0]!, day('2026-03-10'), 1)).toMatchObject({ target: 31 });
	});

	it('sums amounts without float noise', () => {
		let { data, id } = make({ ...READ, goal: { period: 'week', aim: 'build', target: 1 } });
		data = setEntry(setEntry(data, id, day('2026-11-23'), 0.1, T), id, day('2026-11-24'), 0.2, T);
		expect(progressOn(data, data.habits[0]!, day('2026-11-24'), 1)!.done).toBe(0.3);
	});

	it('uses the goal in effect on the day', () => {
		let { data, id } = make(READ);
		data = updateHabit(data, id, { ...READ, goal: { period: 'day', days: [1, 2, 3, 4, 5], aim: 'build', target: 45 } }, day('2026-11-24'), T);
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

describe('the week at a glance', () => {
	it('marks a daily goal’s days: done, missed, not due, still open', () => {
		// READ: 30 min on Mon–Fri, from Mon 2026-11-02
		let { data, id } = make(READ);
		data = setEntry(data, id, day('2026-11-02'), 30, T);
		data = setEntry(data, id, day('2026-11-03'), 10, T);
		const habit = data.habits[0]!;
		const week = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'].map(day);
		// (Sun before the start; Mon met; Tue not enough; Wed is today; Sat not due)
		expect(dayMarks(data, habit, week, day('2026-11-04'))).toEqual(['off', 'done', 'missed', 'open', 'open', 'open', 'off']);
		const archived = setArchived(data, id, day('2026-11-03'), T);
		expect(dayMarks(archived, archived.habits[0]!, week, day('2026-11-04'))).toEqual(['off', 'done', 'off', 'off', 'off', 'off', 'off']);
	});

	it('a day under a weekly goal (before a change to a daily one) is off, not missed', () => {
		let { data, id } = make({ ...RUN, kind: 'check' });
		// weekly until Wed, daily (every day) from Wed 2026-11-04 on
		data = updateHabit(data, id, { ...RUN, goal: { period: 'day', days: [1, 2, 3, 4, 5, 6, 7], aim: 'build', target: 1 } }, day('2026-11-04'), T);
		data = toggleCheck(data, id, day('2026-11-05'), T);
		const week = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'].map(day);
		expect(dayMarks(data, data.habits[0]!, week, day('2026-11-07'))).toEqual(['off', 'off', 'missed', 'done', 'missed', 'open', 'open']);
	});

	it('tells how far a period has run', () => {
		const week = { from: day('2026-11-02'), to: day('2026-11-08') };
		expect(timeShare(week, day('2026-11-01'))).toBe(0);
		expect(timeShare(week, day('2026-11-02'))).toBeCloseTo(1 / 7);
		expect(timeShare(week, day('2026-11-08'))).toBe(1);
		expect(timeShare(week, day('2026-12-01'))).toBe(1);
	});

	it('counts the daily goals met on a day', () => {
		let { data, id } = make(READ);
		const run = addHabit(data, RUN, T);
		data = setEntry(run.data, id, day('2026-11-02'), 30, T);
		data = toggleCheck(data, run.id, day('2026-11-02'), T);
		// (RUN's goal is weekly: not counted)
		expect(dayShare(data, day('2026-11-02'), day('2026-11-20'))).toEqual({ met: 1, due: 1 });
		expect(dayShare(data, day('2026-11-03'), day('2026-11-20'))).toEqual({ met: 0, due: 1 });
		expect(dayShare(data, day('2026-11-07'), day('2026-11-20'))).toEqual({ met: 0, due: 0 });
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

describe('limits', () => {
	const COFFEE: HabitDraft = { name: 'Coffee', kind: 'amount', unit: 'cups', color: '#3a86ff', start: day('2026-11-02'), goal: { period: 'day', days: [1, 2, 3, 4, 5, 6, 7], aim: 'limit', target: 2 } };
	const SMOKE: HabitDraft = { name: 'Smoke', kind: 'check', unit: '', color: '#3a86ff', start: day('2026-11-02'), goal: { period: 'day', days: [1, 2, 3, 4, 5, 6, 7], aim: 'limit', target: 0 } };

	it('met while at most the target; nothing entered is a kept day', () => {
		let { data, id } = make(COFFEE);
		const h = () => data.habits[0]!;
		expect(progressOn(data, h(), day('2026-11-03'), 1)).toMatchObject({ done: 0, target: 2, met: true });
		data = setEntry(data, id, day('2026-11-03'), 2, T);
		expect(progressOn(data, h(), day('2026-11-03'), 1)!.met).toBe(true);
		data = setEntry(data, id, day('2026-11-03'), 3, T);
		expect(progressOn(data, h(), day('2026-11-03'), 1)!.met).toBe(false);
	});

	it('days: kept once over, broken at once; today stays open while kept', () => {
		let { data, id } = make(SMOKE);
		data = toggleCheck(data, id, day('2026-11-03'), T);
		data = toggleCheck(data, id, day('2026-11-05'), T);
		const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map(day);
		expect(dayMarks(data, data.habits[0]!, days, day('2026-11-05'))).toEqual(['done', 'missed', 'done', 'missed', 'open']);
		expect(dayMarks(data, data.habits[0]!, days, day('2026-11-04'))).toEqual(['done', 'missed', 'open', 'missed', 'open']);
	});

	it('a monthly yes/no limit isn’t capped like a goal to build', () => {
		const { data } = make({ ...SMOKE, goal: { period: 'month', aim: 'limit', target: 31 } });
		expect(progressOn(data, data.habits[0]!, day('2026-11-10'), 1)).toMatchObject({ target: 31, met: true });
	});

	it('the day ring: a limit kept today doesn’t count yet, a broken one does', () => {
		let { data, id } = make(SMOKE);
		const today = day('2026-11-05');
		expect(dayShare(data, today, today)).toEqual({ met: 0, due: 0 });
		expect(dayShare(data, day('2026-11-04'), today)).toEqual({ met: 1, due: 1 });
		data = toggleCheck(data, id, today, T);
		expect(dayShare(data, today, today)).toEqual({ met: 0, due: 1 });
	});
});
