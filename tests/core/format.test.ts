import { describe, expect, it } from 'vitest';
import { EMPTY_DATA, FORMAT_VERSION, parseDiscipline, serializeDiscipline, type DisciplineData } from '../../src/core';
import { randomData } from './random-data';

const GOAL = { from: '2026-11-01', period: 'day', days: [1, 2, 3, 4, 5, 6, 7], aim: 'build', target: 30 };
const HABIT = { id: '42', name: 'Read', kind: 'amount', unit: 'min', goals: [GOAL], color: '#3a86ff', position: 1, archived: null, edited: '2026-11-24T20:15:00Z' };
const PREFERENCES = { dayStart: 240, weekStart: 7, edited: '2026-11-25T10:00:00Z' };
const ENTRY = { habit: '42', date: '2026-11-24', value: 45, edited: '2026-11-24T20:15:00Z' };
/** Goals: `GOAL` with changes (`undefined` drops a key) */
const goals = (...changes: object[]) => ({ goals: changes.map((c) => ({ ...GOAL, ...c })) });

function file(changes: { habits?: unknown[]; entries?: unknown[]; [key: string]: unknown } = {}): string {
	return JSON.stringify({ version: FORMAT_VERSION, preferences: PREFERENCES, habits: [HABIT], entries: [ENTRY], ...changes });
}

function errorsOf(text: string): string[] {
	const result = parseDiscipline(text);
	expect(result.ok).toBe(false);
	return result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`);
}

function parsed(text: string): DisciplineData {
	const result = parseDiscipline(text);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.data;
}

describe('format', () => {
	it('reads and writes a document', () => {
		const data = parsed(file());
		expect(data.habits[0]).toMatchObject({ id: '42', name: 'Read', goals: [{ from: '2026-11-01', period: 'day', aim: 'build', target: 30 }], archived: null, edited: Date.UTC(2026, 10, 24, 20, 15) / 1000 });
		expect(serializeDiscipline(data)).toBe(
			[
				'{',
				'\t"version": 3,',
				'\t"preferences": {"dayStart": 240, "weekStart": 7, "edited": "2026-11-25T10:00:00Z"},',
				'\t"habits": [',
				'\t\t{"id": "42", "name": "Read", "kind": "amount", "unit": "min", "goals": [{"from": "2026-11-01", "period": "day", "days": [1, 2, 3, 4, 5, 6, 7], "aim": "build", "target": 30}], "color": "#3a86ff", "position": 1, "archived": null, "edited": "2026-11-24T20:15:00Z"}',
				'\t],',
				'\t"entries": [',
				'\t\t{"habit": "42", "date": "2026-11-24", "value": 45, "edited": "2026-11-24T20:15:00Z"}',
				'\t]',
				'}',
				'',
			].join('\n'),
		);
	});

	it('reads version 1 (no preferences yet) with the default preferences', () => {
		const data = parsed(JSON.stringify({ version: 1, habits: [HABIT], entries: [ENTRY] }));
		expect(data.preferences).toEqual({ dayStart: 0, weekStart: 1, edited: null });
		expect(data.habits).toHaveLength(1);
		expect(parseDiscipline(JSON.stringify({ version: 1, preferences: PREFERENCES, habits: [], entries: [] })).warnings).toEqual([{ path: 'preferences', message: 'Unknown key, it will be dropped on save' }]);
	});

	it('reads version 2 (no aim yet): every goal builds', () => {
		const { aim: _, ...old } = GOAL;
		const data = parsed(JSON.stringify({ version: 2, preferences: PREFERENCES, habits: [{ ...HABIT, goals: [old] }], entries: [ENTRY] }));
		expect(data.habits[0]!.goals[0]!.aim).toBe('build');
		expect(errorsOf(file({ habits: [{ ...HABIT, goals: [old] }] }))).toEqual(['habits[0].goals[0].aim: Missing']);
	});

	it('reads limits, down to 0', () => {
		const data = parsed(
			file({
				habits: [
					{ ...HABIT, ...goals({ aim: 'limit', target: 0 }, { from: '2026-11-10', aim: 'limit', target: 2.5 }) },
					{ ...HABIT, id: '43', kind: 'check', unit: '', ...goals({ aim: 'limit', target: 0 }, { from: '2026-11-10', period: 'week', days: undefined, aim: 'limit', target: 0 }) },
				],
				entries: [],
			}),
		);
		expect(data.habits.map((h) => h.goals.map((g) => [g.aim, g.target]))).toEqual([
			[
				['limit', 0],
				['limit', 2.5],
			],
			[
				['limit', 0],
				['limit', 0],
			],
		]);
	});

	it('checks the preferences', () => {
		expect(errorsOf(file({ preferences: { ...PREFERENCES, dayStart: 45 } }))).toEqual(['preferences.dayStart: Must be one of 0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360 (minutes after midnight)']);
		expect(errorsOf(file({ preferences: { ...PREFERENCES, weekStart: 2 } }))).toEqual(['preferences.weekStart: Must be 1 (Monday) or 7 (Sunday)']);
		expect(errorsOf(file({ preferences: { ...PREFERENCES, edited: 'yesterday' } }))[0]).toMatch(/^preferences\.edited: Invalid timestamp/);
		expect(errorsOf(file({ preferences: undefined }))).toEqual(['preferences: Must be an object']);
		expect(parsed(file({ preferences: { dayStart: 0, weekStart: 1, edited: null } })).preferences.edited).toBeNull();
		// never changed, but not the defaults: no edit makes that
		expect(errorsOf(file({ preferences: { ...PREFERENCES, edited: null } }))[0]).toMatch(/^preferences\.edited: Must be a timestamp/);
		// (-0 written as text: JSON.stringify writes 0)
		expect(errorsOf(file().replace('"dayStart":240', '"dayStart":-0'))[0]).toMatch(/^preferences\.dayStart: Must be one of/);
	});

	it('writes empty data', () => {
		expect(serializeDiscipline(EMPTY_DATA)).toBe('{\n\t"version": 3,\n\t"preferences": {"dayStart": 0, "weekStart": 1, "edited": null},\n\t"habits": [],\n\t"entries": []\n}\n');
		expect(parsed(serializeDiscipline(EMPTY_DATA))).toEqual(EMPTY_DATA);
	});

	it('round-trips random documents exactly', () => {
		for (let seed = 1; seed <= 300; seed++) {
			const data = randomData(seed);
			const text = serializeDiscipline(data);
			const back = parsed(text);
			expect(back, `seed ${seed}`).toEqual(data);
			expect(serializeDiscipline(back)).toBe(text);
		}
	});

	it('writes the same text regardless of record order', () => {
		const data = randomData(7, 3);
		const shuffled = { ...data, habits: [...data.habits].reverse(), entries: [...data.entries].reverse() };
		expect(serializeDiscipline(shuffled)).toBe(serializeDiscipline(data));
	});

	it('keeps text that needs escaping', () => {
		const name = 'a "b" \\ \n\t\u0001  🧘 寿司';
		const data = parsed(file({ habits: [{ ...HABIT, name }] }));
		expect(data.habits[0]!.name).toBe(name);
		expect(parsed(serializeDiscipline(data)).habits[0]!.name).toBe(name);
		// one record per line: line breaks in text are escaped
		expect(serializeDiscipline(data).split('\n')).toHaveLength(11);
	});

	it('sorts what it reads', () => {
		const second = { ...HABIT, id: '7', position: 0.5 };
		const data = parsed(file({ habits: [HABIT, second], entries: [ENTRY, { ...ENTRY, date: '2026-11-01' }, { ...ENTRY, habit: '7' }] }));
		expect(data.habits.map((h) => h.id)).toEqual(['7', '42']);
		expect(data.entries.map((e) => `${e.date} ${e.habit}`)).toEqual(['2026-11-01 42', '2026-11-24 7', '2026-11-24 42']);
	});

	it('warns about unknown keys', () => {
		const result = parseDiscipline(file({ extra: 1, habits: [{ ...HABIT, note: 'x' }] }));
		expect(result.ok && result.warnings.map((w) => w.path)).toEqual(['extra', 'habits[0].note']);
	});

	it('names a newer format', () => {
		expect(errorsOf(file({ version: 4 }))[0]).toMatch(/newer version of Discipline/);
		expect(errorsOf(file({ version: 0 }))[0]).toMatch(/Unsupported version 0/);
		expect(errorsOf(file({ version: '1' }))).toEqual(['version: Must be a number']);
	});

	it.each([
		['not JSON', '{', /^: Not valid JSON/],
		['not an object', '[]', /^: The file must contain a JSON object/],
		['missing habits', JSON.stringify({ version: 1, entries: [] }), /^habits: Missing/],
		['bad id', file({ habits: [{ ...HABIT, id: '-1' }] }), /^habits\[0\]\.id: Invalid id/],
		['duplicate habit', file({ habits: [HABIT, HABIT] }), /^habits\[1\]\.id: Duplicate habit id 42/],
		['empty name', file({ habits: [{ ...HABIT, name: '' }] }), /^habits\[0\]\.name: Must not be empty/],
		['name with outer space', file({ habits: [{ ...HABIT, name: ' Read' }] }), /^habits\[0\]\.name: Must not start or end with white space/],
		['name with NUL', file({ habits: [{ ...HABIT, name: 'Re\u0000ad' }] }), /^habits\[0\]\.name: Must not start or end with white space or contain NUL/],
		['unit with outer space', file({ habits: [{ ...HABIT, unit: 'min ' }] }), /^habits\[0\]\.unit: Must not start/],
		['bad kind', file({ habits: [{ ...HABIT, kind: 'avoid' }] }), /^habits\[0\]\.kind: Invalid kind/],
		['unit on a check habit', file({ habits: [{ ...HABIT, kind: 'check', ...goals({ period: 'week', aim: 'build', target: 3, days: undefined }) }], entries: [] }), /^habits\[0\]\.unit: Must be empty/],
		['bad color', file({ habits: [{ ...HABIT, color: '#3A86FF' }] }), /^habits\[0\]\.color: Invalid color/],
		['infinite position', file().replace('"position":1', '"position":1e400'), /^habits\[0\]\.position: Must be a number from/],
		['huge position', file({ habits: [{ ...HABIT, position: 1e9 + 1 }] }), /^habits\[0\]\.position: Must be a number from/],
		['-0 position', file().replace('"position":1', '"position":-0'), /^habits\[0\]\.position: Must be a number from/],
		['bad archived day', file({ habits: [{ ...HABIT, archived: '2026-02-30' }] }), /^habits\[0\]\.archived: Invalid date/],
		['archived as a flag', file({ habits: [{ ...HABIT, archived: false }] }), /^habits\[0\]\.archived: Must be a string/],
		['bad timestamp', file({ habits: [{ ...HABIT, edited: '2026-11-24 20:15:00' }] }), /^habits\[0\]\.edited: Invalid timestamp/],
		['timestamp after the supported years', file({ habits: [{ ...HABIT, edited: '2201-01-01T00:00:00Z' }] }), /^habits\[0\]\.edited: Invalid timestamp/],
		['no goals', file({ habits: [{ ...HABIT, goals: [] }] }), /^habits\[0\]\.goals: Must have at least one goal/],
		['goals out of order', file({ habits: [{ ...HABIT, ...goals({}, { from: '2026-11-01' }) }] }), /^habits\[0\]\.goals\[1\]\.from: Must be later/],
		['goal without a day', file({ habits: [{ ...HABIT, ...goals({ from: undefined }) }] }), /^habits\[0\]\.goals\[0\]\.from: Missing/],
		['bad period', file({ habits: [{ ...HABIT, ...goals({ period: 'year', days: undefined }) }] }), /^habits\[0\]\.goals\[0\]\.period: Must be "day", "week" or "month"/],
		['days on a weekly goal', file({ habits: [{ ...HABIT, ...goals({ period: 'week' }) }] }), /^habits\[0\]\.goals\[0\]\.days: Only a daily goal has days/],
		['no weekdays', file({ habits: [{ ...HABIT, ...goals({ days: [] }) }] }), /^habits\[0\]\.goals\[0\]: Invalid goal/],
		['unsorted weekdays', file({ habits: [{ ...HABIT, ...goals({ days: [2, 1] }) }] }), /^habits\[0\]\.goals\[0\]: Invalid goal/],
		['weekday 0', file({ habits: [{ ...HABIT, ...goals({ days: [0] }) }] }), /^habits\[0\]\.goals\[0\]\.days: Must be weekdays/],
		['check target per day', file({ habits: [{ ...HABIT, kind: 'check', unit: '', ...goals({ target: 2 }) }], entries: [] }), /^habits\[0\]\.goals\[0\]: Invalid goal/],
		['check target per week', file({ habits: [{ ...HABIT, kind: 'check', unit: '', ...goals({ period: 'week', days: undefined, target: 8 }) }], entries: [] }), /^habits\[0\]\.goals\[0\]: Invalid goal/],
		['bad aim', file({ habits: [{ ...HABIT, ...goals({ aim: 'avoid' }) }] }), /^habits\[0\]\.goals\[0\]\.aim: Invalid aim/],
		['build target 0', file({ habits: [{ ...HABIT, ...goals({ target: 0 }) }] }), /^habits\[0\]\.goals\[0\]: Invalid goal/],
		['limit target -0', file({ habits: [{ ...HABIT, ...goals({ aim: 'limit', target: -0 }) }] }).replace('"target":0', '"target":-0'), /^habits\[0\]\.goals\[0\]: Invalid goal/],
		['daily check limit other than 0', file({ habits: [{ ...HABIT, kind: 'check', unit: '', ...goals({ aim: 'limit', target: 1 }) }], entries: [] }), /^habits\[0\]\.goals\[0\]: Invalid goal: expected .* target that is 0/],
		['target with 4 decimals', file({ habits: [{ ...HABIT, ...goals({ period: 'month', days: undefined, target: 0.0001 }) }] }), /^habits\[0\]\.goals\[0\]: Invalid goal/],
		['unknown habit', file({ entries: [{ ...ENTRY, habit: '43' }] }), /^entries\[0\]\.habit: Unknown habit 43/],
		['second entry on a day', file({ entries: [ENTRY, { ...ENTRY, value: 1 }] }), /^entries\[1\]: Second entry for habit 42 on 2026-11-24/],
		['zero value', file({ entries: [{ ...ENTRY, value: 0 }] }), /^entries\[0\]\.value: Must be positive/],
		['value too large', file({ entries: [{ ...ENTRY, value: 1e9 + 1 }] }), /^entries\[0\]\.value: Must be positive/],
		['value as text', file({ entries: [{ ...ENTRY, value: '45' }] }), /^entries\[0\]\.value: Must be a number/],
		['check value other than 1', file({ habits: [{ ...HABIT, kind: 'check', unit: '', ...goals({ period: 'week', days: undefined, target: 3 }) }], entries: [{ ...ENTRY, value: 2 }] }), /^entries\[0\]\.value: Must be 1/],
		['entry before the supported years', file({ entries: [{ ...ENTRY, date: '1899-12-31' }] }), /^entries\[0\]\.date: Invalid date/],
		['lone surrogate', file({ habits: [{ ...HABIT, name: 'a\ud800' }] }), /^habits\[0\]\.name: Must not contain an invalid character/],
	])('rejects %s', (_, text, expected) => {
		expect(errorsOf(text)[0]).toMatch(expected);
	});

	it('reports one error, not one per entry, for a broken habit', () => {
		expect(errorsOf(file({ habits: [{ ...HABIT, kind: 'avoid' }], entries: [ENTRY, { ...ENTRY, date: '2026-11-25' }] }))).toHaveLength(1);
		expect(errorsOf(file({ habits: [{ ...HABIT, ...goals({ days: undefined }) }] }))).toEqual(['habits[0].goals[0].days: Missing']);
	});

	it('reads a byte order mark, exponents and 1.0', () => {
		const data = parsed('﻿' + file({ entries: [{ ...ENTRY, value: 1.5e2 }] }).replace('"position":1', '"position":1.0'));
		expect(data.entries[0]!.value).toBe(150);
		expect(data.habits[0]!.position).toBe(1);
	});

	it('reads goals over time and an archive day', () => {
		const data = parsed(file({ habits: [{ ...HABIT, archived: '2026-12-01', ...goals({}, { from: '2026-11-15', period: 'week', days: undefined, target: 200 }) }] }));
		expect(data.habits[0]!.goals.map((g) => g.from)).toEqual(['2026-11-01', '2026-11-15']);
		expect(data.habits[0]!.archived).toBe('2026-12-01');
		expect(parsed(serializeDiscipline(data))).toEqual(data);
	});

	it('accepts the limits', () => {
		const data = parsed(
			file({
				habits: [
					{ ...HABIT, ...goals({ from: '1900-01-01', period: 'week', days: undefined, target: 1e9 }), position: -1e9, edited: '2200-12-31T23:59:59Z' },
					{ ...HABIT, id: '18446744073709551615', kind: 'check', unit: '', position: 1e9, ...goals({ period: 'month', days: undefined, target: 31 }) },
				],
				entries: [{ ...ENTRY, value: 0.001, date: '2200-12-31', edited: '1900-01-01T00:00:00Z' }, { ...ENTRY, habit: '18446744073709551615', value: 1 }],
			}),
		);
		expect(data.entries).toHaveLength(2);
		expect(parsed(serializeDiscipline(data))).toEqual(data);
	});
});

describe('fixtures', () => {
	it('are written exactly as the app writes them (e2e tests compare exports with them)', async () => {
		const { readdirSync, readFileSync } = await import('node:fs');
		const dir = new URL('../fixtures/', import.meta.url);
		const names = readdirSync(dir).filter((n) => n.endsWith('.json'));
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			const text = readFileSync(new URL(name, dir), 'utf8');
			expect(serializeDiscipline(parsed(text)), name).toBe(text);
		}
	});
});
