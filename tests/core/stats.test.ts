import { describe, expect, it } from 'vitest';
import {
	addDays,
	addHabit,
	amountBuckets,
	dayCell,
	EMPTY_DATA,
	periodResults,
	rateOf,
	setArchived,
	setEntry,
	toggleCheck,
	updateHabit,
	weekdayShares,
	weekShares,
	type CivilDate,
	type DisciplineData,
	type HabitDraft,
	type Id,
	type UtcSeconds,
} from '../../src/core';
import { randomData } from './random-data';

const T = 1_800_000_000 as UtcSeconds;
const day = (s: string) => s as CivilDate;

// Mon 2.11.2026
const MEDITATE: HabitDraft = { name: 'Meditate', kind: 'check', unit: '', color: '#3a86ff', start: day('2026-11-02'), goal: { period: 'day', days: [1, 2, 3, 4, 5, 6, 7], target: 1 } };
const READ: HabitDraft = { name: 'Read', kind: 'amount', unit: 'min', color: '#3a86ff', start: day('2026-11-02'), goal: { period: 'day', days: [1, 2, 3, 4, 5], target: 30 } };
const RUN: HabitDraft = { name: 'Run', kind: 'amount', unit: 'km', color: '#ff006e', start: day('2026-11-02'), goal: { period: 'week', target: 21 } };

function make(draft: HabitDraft): { data: DisciplineData; id: Id } {
	return addHabit(EMPTY_DATA, draft, T);
}
function checks(data: DisciplineData, id: Id, days: string[]): DisciplineData {
	for (const d of days) data = toggleCheck(data, id, day(d), T);
	return data;
}

describe('periodResults', () => {
	it('daily goals: past days count, today only once met, days not due never', () => {
		let { data, id } = make(READ);
		data = setEntry(data, id, day('2026-11-02'), 30, T);
		data = setEntry(data, id, day('2026-11-03'), 10, T);
		// Sat 7. and Sun 8. aren't due; today (Mon 9.) is open
		const results = periodResults(data, data.habits[0]!, day('2026-10-01'), day('2026-11-30'), 1, day('2026-11-09'));
		expect(results.map((r) => [r.from, r.met])).toEqual([
			['2026-11-02', true],
			['2026-11-03', false],
			['2026-11-04', false],
			['2026-11-05', false],
			['2026-11-06', false],
		]);
		data = setEntry(data, id, day('2026-11-09'), 45, T);
		expect(rateOf(periodResults(data, data.habits[0]!, day('2026-10-01'), day('2026-11-30'), 1, day('2026-11-09')))).toEqual({ met: 2, counted: 6 });
	});

	it('weekly goals: one result per week, the current one only once met', () => {
		let { data, id } = make(RUN);
		data = setEntry(data, id, day('2026-11-03'), 21, T);
		data = setEntry(data, id, day('2026-11-10'), 5, T);
		const habit = () => data.habits[0]!;
		const results = periodResults(data, habit(), day('2026-11-01'), day('2026-11-30'), 1, day('2026-11-18'));
		expect(results).toEqual([
			{ from: '2026-11-02', to: '2026-11-08', done: 21, target: 21, met: true },
			{ from: '2026-11-09', to: '2026-11-15', done: 5, target: 21, met: false },
		]);
		data = setEntry(data, id, day('2026-11-17'), 30, T);
		expect(periodResults(data, habit(), day('2026-11-01'), day('2026-11-30'), 1, day('2026-11-18'))).toHaveLength(3);
	});

	it('a changed goal keeps the past and counts its own periods from its day on', () => {
		let { data, id } = make(MEDITATE);
		data = checks(data, id, ['2026-11-02', '2026-11-03']);
		// from Wed 4.11. on: twice a week
		data = updateHabit(data, id, { ...MEDITATE, goal: { period: 'week', target: 2 } }, day('2026-11-04'), T);
		data = checks(data, id, ['2026-11-10', '2026-11-12']);
		const results = periodResults(data, data.habits[0]!, day('2026-11-01'), day('2026-11-30'), 1, day('2026-11-20'));
		expect(results.map((r) => [r.from, r.to, r.met])).toEqual([
			// the new goal takes the whole week it started in: Mon and Tue count only there
			['2026-11-02', '2026-11-08', true],
			['2026-11-09', '2026-11-15', true],
		]);
	});

	it('archived within a week: that week counts only if it was met', () => {
		let { data, id } = make({ ...MEDITATE, goal: { period: 'week', target: 3 } });
		data = checks(data, id, ['2026-11-02', '2026-11-03', '2026-11-09', '2026-11-10', '2026-11-11']);
		data = setArchived(data, id, day('2026-11-06'), T);
		expect(periodResults(data, data.habits[0]!, day('2026-11-01'), day('2026-11-30'), 1, day('2026-11-20'))).toEqual([]);
		data = setArchived(data, id, day('2026-11-12'), T);
		expect(periodResults(data, data.habits[0]!, day('2026-11-01'), day('2026-11-30'), 1, day('2026-11-20')).map((r) => [r.from, r.met])).toEqual([
			['2026-11-02', false],
			['2026-11-09', true],
		]);
	});

	it('monthly goals, and weeks from Sunday', () => {
		let { data, id } = make({ ...MEDITATE, start: day('2026-01-01'), goal: { period: 'month', target: 31 } });
		for (let d = 1; d <= 28; d++) data = toggleCheck(data, id, day(`2026-02-${String(d).padStart(2, '0')}`), T);
		const results = periodResults(data, data.habits[0]!, day('2026-01-01'), day('2026-03-31'), 7, day('2026-03-15'));
		// February asks for its 28 days at most
		expect(results.map((r) => [r.from, r.target, r.met])).toEqual([
			['2026-01-01', 31, false],
			['2026-02-01', 28, true],
		]);
		const run = make(RUN);
		const sunday = setEntry(run.data, run.id, day('2026-11-08'), 21, T);
		// Sun 8.11. starts a week; the habit's first week (from Sun 1.) is over and missed
		expect(periodResults(sunday, sunday.habits[0]!, day('2026-11-01'), day('2026-11-30'), 7, day('2026-11-10')).map((r) => [r.from, r.met])).toEqual([
			['2026-11-01', false],
			['2026-11-08', true],
		]);
		expect(weekShares(sunday, [day('2026-11-01'), day('2026-11-08')], 7, day('2026-11-10'))).toEqual([
			{ met: 0, counted: 1 },
			{ met: 1, counted: 1 },
		]);
	});

	it('nothing before the start or from the archive day on', () => {
		let { data, id } = make(MEDITATE);
		data = setArchived(data, id, day('2026-11-05'), T);
		const results = periodResults(data, data.habits[0]!, day('2026-10-01'), day('2026-11-30'), 1, day('2026-11-20'));
		expect(results.map((r) => r.from)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
	});
});

describe('weekShares', () => {
	it('counts each period in the week it ends in', () => {
		let { data, id } = make(MEDITATE);
		data = checks(data, id, ['2026-11-02', '2026-11-10']);
		const run = addHabit(data, RUN, T);
		data = setEntry(run.data, run.id, day('2026-11-04'), 25, T);
		const shares = weekShares(data, [day('2026-11-02'), day('2026-11-09')], 1, day('2026-11-11'));
		// week 1: 1 of 7 days + the run; week 2: 1 of 2 days (Wed is open), the run is still open
		expect(shares).toEqual([
			{ met: 2, counted: 8 },
			{ met: 1, counted: 2 },
		]);
	});
});

describe('dayCell', () => {
	it('daily goals: met, missed, open, not due; amounts filled by their share', () => {
		let { data, id } = make(READ);
		data = setEntry(data, id, day('2026-11-02'), 15, T);
		data = setEntry(data, id, day('2026-11-07'), 10, T);
		const h = () => data.habits[0]!;
		const today = day('2026-11-09');
		expect(dayCell(data, h(), day('2026-11-02'), today)).toEqual({ state: 'missed', value: 15, fill: 0.5 });
		expect(dayCell(data, h(), day('2026-11-03'), today)).toEqual({ state: 'missed', value: 0, fill: 0 });
		expect(dayCell(data, h(), day('2026-11-07'), today)).toEqual({ state: 'notDue', value: 10, fill: 1 / 3 });
		expect(dayCell(data, h(), today, today)).toEqual({ state: 'open', value: 0, fill: 0 });
		expect(dayCell(data, h(), day('2026-11-10'), today).state).toBe('inactive');
		expect(dayCell(data, h(), day('2026-11-01'), today).state).toBe('inactive');
		data = setEntry(data, id, today, 40, T);
		expect(dayCell(data, h(), today, today)).toEqual({ state: 'met', value: 40, fill: 1 });
	});

	it('monthly goals: a day’s share of the month', () => {
		let { data, id } = make({ ...RUN, goal: { period: 'month', target: 60 } });
		data = setEntry(data, id, day('2026-11-03'), 1, T);
		expect(dayCell(data, data.habits[0]!, day('2026-11-03'), day('2026-11-20'))).toEqual({ state: 'free', value: 1, fill: 0.5 });
	});

	it('weekly goals: free days, filled against a day’s share of the target', () => {
		let { data, id } = make(RUN);
		data = setEntry(data, id, day('2026-11-03'), 1.5, T);
		data = setEntry(data, id, day('2026-11-04'), 10, T);
		expect(dayCell(data, data.habits[0]!, day('2026-11-03'), day('2026-11-20'))).toEqual({ state: 'free', value: 1.5, fill: 0.5 });
		expect(dayCell(data, data.habits[0]!, day('2026-11-04'), day('2026-11-20')).fill).toBe(1);
		expect(dayCell(data, data.habits[0]!, day('2026-11-05'), day('2026-11-20'))).toEqual({ state: 'free', value: 0, fill: 0 });
	});
});

describe('weekdayShares', () => {
	it('counts due days per weekday, today only once done', () => {
		let { data, id } = make({ ...MEDITATE, goal: { period: 'day', days: [1, 3], target: 1 } });
		data = checks(data, id, ['2026-11-02', '2026-11-09', '2026-11-11']);
		const shares = weekdayShares(data, data.habits[0]!, day('2026-11-01'), day('2026-11-30'), day('2026-11-16'));
		// Mondays 2., 9. done, 16. (today) open; Wednesdays 4. missed, 11. done
		expect(shares[1]).toEqual({ done: 2, days: 2 });
		expect(shares[3]).toEqual({ done: 1, days: 2 });
		expect(shares[2]).toEqual({ done: 0, days: 0 });
	});
});

describe('amountBuckets', () => {
	it('sums the amounts and what the goals ask for in each bucket', () => {
		let { data, id } = make(READ);
		data = setEntry(data, id, day('2026-11-02'), 30, T);
		data = setEntry(data, id, day('2026-11-08'), 12.5, T);
		const week = (from: string, to: string) => ({ from: day(from), to: day(to) });
		// the first bucket starts before the habit: only its days count
		expect(amountBuckets(data, data.habits[0]!, [week('2026-10-26', '2026-11-08'), week('2026-11-09', '2026-11-15')], 1)).toEqual([
			{ from: '2026-10-26', to: '2026-11-08', total: 42.5, target: 150 },
			{ from: '2026-11-09', to: '2026-11-15', total: 0, target: 150 },
		]);
		const run = make(RUN);
		const firstWeek = amountBuckets(run.data, run.data.habits[0]!, [{ from: day('2026-11-02'), to: day('2026-11-08') }], 1);
		expect(firstWeek[0]!.target).toBe(21);
	});

	it('a week of a weekly goal asks what the rates ask: the whole target, from the goal owning it', () => {
		// started on a Wednesday: the first week still asks for 21
		let { data, id } = make({ ...RUN, start: day('2026-11-04') });
		data = updateHabit(data, id, { ...RUN, start: day('2026-11-04'), goal: { period: 'week', target: 35 } }, day('2026-11-12'), T);
		const weeks = [day('2026-11-02'), day('2026-11-09')].map((w) => ({ from: w, to: addDays(w, 6) }));
		expect(amountBuckets(data, data.habits[0]!, weeks, 1).map((b) => b.target)).toEqual([21, 35]);
		// daily days and weeks mixed in a month: the days' shares
		const month = amountBuckets(data, data.habits[0]!, [{ from: day('2026-11-01'), to: day('2026-11-30') }], 1)[0]!;
		expect(month.target).toBe(Math.round(((21 * 8) / 7 + (35 * 19) / 7) * 1000) / 1000);
	});
});

describe('on random data', () => {
	it('never throws, and rates stay within their counts', () => {
		for (let seed = 1; seed <= 30; seed++) {
			const data = randomData(seed);
			for (const habit of data.habits) {
				const results = periodResults(data, habit, day('2000-01-01'), day('2100-12-31'), 1, day('2060-06-15'));
				const { met, counted } = rateOf(results);
				expect(met).toBeLessThanOrEqual(counted);
				for (let i = 1; i < results.length; i++) if (!(results[i]!.from > results[i - 1]!.to)) throw new Error(JSON.stringify([habit.goals, habit.archived, results[i - 1], results[i]]));
				for (const r of results) {
					// nothing open counts unless met, nothing after the archive day unless met
					if (r.to >= '2060-06-15' || (habit.archived !== null && r.to >= habit.archived)) expect(r.met).toBe(true);
					if (habit.archived !== null) expect(r.from < habit.archived).toBe(true);
				}
			}
		}
	});
});

describe('goal changes within a period', () => {
	it('the new goal takes the whole week, the old one’s part of it doesn’t count', () => {
		let { data, id } = make({ ...MEDITATE, goal: { period: 'week', target: 3 } });
		data = checks(data, id, ['2026-11-02', '2026-11-03', '2026-11-04']);
		// from Wed 4.11. on: 4 a week, then from Mon 16. daily
		data = updateHabit(data, id, { ...MEDITATE, goal: { period: 'week', target: 4 } }, day('2026-11-04'), T);
		data = updateHabit(data, id, MEDITATE, day('2026-11-18'), T);
		const results = periodResults(data, data.habits[0]!, day('2026-11-01'), day('2026-11-30'), 1, day('2026-11-20'));
		expect(results.map((r) => [r.from, r.target, r.met])).toEqual([
			['2026-11-02', 4, false],
			['2026-11-09', 4, false],
			// the week of 16. is the daily goal's from Wednesday
			['2026-11-18', 1, false],
			['2026-11-19', 1, false],
		]);
	});
});
