/**
 * Reading and writing the data as text: the format of exported and backup files, and of the data
 * devices send each other when they sync.
 *
 * {
 * 	"version": 1,
 * 	"habits": [
 * 		{"id": "…", "name": "Read", "kind": "amount", "unit": "min", "goals": [{"from": "2026-11-24", "period": "day", "days": [1, 2, 3, 4, 5, 6, 7], "target": 30}], "color": "#3a86ff", "position": 1, "archived": null, "edited": "2026-11-24T20:15:00Z"}
 * 	],
 * 	"entries": [
 * 		{"habit": "…", "date": "2026-11-24", "value": 45, "edited": "2026-11-24T20:15:00Z"}
 * 	]
 * }
 *
 * One record per line, sorted, so the same data always gives the same text (also used to compare
 * data by hash when syncing) and files diff well. The parser accepts exactly what the edit
 * operations can produce (e.g. names already cleaned), so loading never changes data by itself.
 */
import { formatTimestamp, isCivilDate, MAX_YEAR, MIN_YEAR, parseTimestamp, WEEKDAYS, type CivilDate, type UtcSeconds, type Weekday } from './dates';
import { parseId, type Id } from './ids';
import {
	compareEntries,
	compareHabits,
	entryKey,
	isCleanText,
	isColor,
	isEntryValue,
	isPosition,
	isStorableText,
	isValidGoal,
	MAX_POSITION,
	MAX_VALUE,
	PERIOD_DAYS,
	type DatedGoal,
	type DisciplineData,
	type Entry,
	type Goal,
	type Habit,
	type HabitKind,
} from './model';

export const FORMAT_VERSION = 1;

export interface Issue {
	/** Location in the file, e.g. `entries[3].value` */
	readonly path: string;
	readonly message: string;
}

export type ParseResult =
	| { readonly ok: true; readonly data: DisciplineData; readonly warnings: readonly Issue[] }
	| { readonly ok: false; readonly errors: readonly Issue[]; readonly warnings: readonly Issue[] };

const HABIT_KEYS = ['id', 'name', 'kind', 'unit', 'goals', 'color', 'position', 'archived', 'edited'];
const GOAL_KEYS = ['from', 'period', 'days', 'target'];
const ENTRY_KEYS = ['habit', 'date', 'value', 'edited'];
const DATE_FORMAT = `date (expected YYYY-MM-DD, years ${MIN_YEAR}–${MAX_YEAR})`;
const TIMESTAMP_FORMAT = `timestamp (expected YYYY-MM-DDTHH:MM:SSZ, years ${MIN_YEAR}–${MAX_YEAR})`;

type JsonObject = { readonly [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function join(path: string, key: string): string {
	return path ? `${path}.${key}` : key;
}

class Parser {
	readonly errors: Issue[] = [];
	readonly warnings: Issue[] = [];

	error(path: string, message: string): null {
		this.errors.push({ path, message });
		return null;
	}

	object(value: unknown, path: string, knownKeys: readonly string[]): JsonObject | null {
		if (!isObject(value)) return this.error(path, 'Must be an object');
		for (const key of Object.keys(value)) {
			if (!knownKeys.includes(key)) this.warnings.push({ path: join(path, key), message: 'Unknown key, it will be dropped on save' });
		}
		return value;
	}

	string(object: JsonObject, key: string, path: string): string | null {
		const value = object[key];
		if (typeof value === 'string') {
			// half of a UTF-16 pair (only possible as an escape): not text, and can't be stored as UTF-8
			if (!isStorableText(value)) return this.error(join(path, key), 'Must not contain an invalid character (a lone surrogate escape)');
			return value;
		}
		return this.error(join(path, key), value === undefined ? 'Missing' : 'Must be a string');
	}

	/** A name or unit: as the app stores them (see `isCleanText`) */
	text(object: JsonObject, key: string, path: string): string | null {
		const text = this.string(object, key, path);
		if (text !== null && !isCleanText(text)) return this.error(join(path, key), 'Must not start or end with white space or contain NUL');
		return text;
	}

	number(object: JsonObject, key: string, path: string): number | null {
		const value = object[key];
		if (typeof value === 'number') return value;
		return this.error(join(path, key), value === undefined ? 'Missing' : 'Must be a number');
	}

	array(object: JsonObject, key: string, path: string): readonly unknown[] | null {
		const value = object[key];
		if (Array.isArray(value)) return value;
		return this.error(join(path, key), value === undefined ? 'Missing' : 'Must be an array');
	}

	field<T>(object: JsonObject, key: string, path: string, parse: (text: string) => T | null, what: string): T | null {
		const text = this.string(object, key, path);
		if (text === null) return null;
		return parse(text) ?? this.error(join(path, key), `Invalid ${what}: "${text}"`);
	}

	date(object: JsonObject, key: string, path: string): CivilDate | null {
		return this.field(object, key, path, (t) => (isCivilDate(t) ? t : null), DATE_FORMAT);
	}

	timestamp(object: JsonObject, key: string, path: string): UtcSeconds | null {
		return this.field(object, key, path, parseTimestamp, TIMESTAMP_FORMAT);
	}

	/** `kind` null: the habit's kind is invalid (reported already), so the goal can't be checked against it */
	goal(value: unknown, path: string, kind: HabitKind | null): DatedGoal | null {
		const object = this.object(value, path, GOAL_KEYS);
		if (!object) return null;
		const from = this.date(object, 'from', path);
		const period = this.string(object, 'period', path);
		const target = this.number(object, 'target', path);
		if (from === null || period === null || target === null) return null;
		let goal: Goal;
		if (period === 'day') {
			const days = this.array(object, 'days', path);
			if (days === null) return null;
			if (!days.every((d): d is Weekday => typeof d === 'number' && (WEEKDAYS as readonly number[]).includes(d))) return this.error(join(path, 'days'), 'Must be weekdays (1 = Monday … 7 = Sunday)');
			goal = { period, days, target };
		} else if (period === 'week' || period === 'month') {
			if ('days' in object) return this.error(join(path, 'days'), 'Only a daily goal has days');
			goal = { period, target };
		} else return this.error(join(path, 'period'), `Must be "day", "week" or "month", not "${period}"`);
		if (kind !== null && !isValidGoal(goal, kind)) {
			const expected =
				goal.period === 'day'
					? `weekdays ascending without repeats, and a target that is ${kind === 'check' ? '1' : 'positive with at most 3 decimals'}`
					: `a target that is ${kind === 'check' ? `a whole number of days from 1 to ${PERIOD_DAYS[goal.period]}` : 'positive with at most 3 decimals'}`;
			return this.error(path, `Invalid goal: expected ${expected}`);
		}
		return { from, ...goal };
	}

	goals(object: JsonObject, path: string, kind: HabitKind | null): DatedGoal[] | null {
		const values = this.array(object, 'goals', path);
		if (values === null) return null;
		if (values.length === 0) return this.error(join(path, 'goals'), 'Must have at least one goal');
		const goals = values.map((value, i) => this.goal(value, `${join(path, 'goals')}[${i}]`, kind));
		if (!goals.every((g) => g !== null)) return null;
		const unsorted = goals.findIndex((g, i) => i > 0 && g.from <= goals[i - 1]!.from);
		if (unsorted !== -1) return this.error(`${join(path, 'goals')}[${unsorted}].from`, 'Must be later than the goal before');
		return goals;
	}

	/** `seen`: the ids of all habits so far, with their kind if the habit is valid enough to know it */
	habit(value: unknown, path: string, seen: Map<Id, HabitKind | null>): Habit | null {
		const object = this.object(value, path, HABIT_KEYS);
		if (!object) return null;
		const id = this.field(object, 'id', path, parseId, 'id');
		const name = this.text(object, 'name', path);
		const kind = this.field(object, 'kind', path, (t): HabitKind | null => (t === 'check' || t === 'amount' ? t : null), 'kind (expected "check" or "amount")');
		const unit = this.text(object, 'unit', path);
		const goals = this.goals(object, path, kind);
		const color = this.field(object, 'color', path, (t) => (isColor(t) ? t : null), 'color (expected #rrggbb, lowercase)');
		const position = this.number(object, 'position', path);
		const archived = object['archived'] === null ? null : this.date(object, 'archived', path);
		const edited = this.timestamp(object, 'edited', path);
		if (name === '') this.error(join(path, 'name'), 'Must not be empty');
		if (kind === 'check' && unit) this.error(join(path, 'unit'), 'Must be empty for a check habit');
		if (position !== null && !isPosition(position)) this.error(join(path, 'position'), `Must be a number from -${MAX_POSITION} to ${MAX_POSITION} (not -0)`);
		if (id !== null) {
			if (seen.has(id)) return this.error(join(path, 'id'), `Duplicate habit id ${id}`);
			seen.set(id, kind);
		}
		if (id === null || !name || kind === null || unit === null || goals === null || color === null || position === null || !isPosition(position) || (archived === null && object['archived'] !== null) || edited === null) return null;
		if (kind === 'check' && unit) return null;
		return { id, name, kind, unit, goals, color, position, archived, edited };
	}

	/** Habits must be parsed before, so references can be checked */
	entry(value: unknown, path: string, habits: ReadonlyMap<Id, HabitKind | null>, keys: Set<string>): Entry | null {
		const object = this.object(value, path, ENTRY_KEYS);
		if (!object) return null;
		const habit = this.field(object, 'habit', path, parseId, 'id');
		const date = this.date(object, 'date', path);
		const entryValue = this.number(object, 'value', path);
		const edited = this.timestamp(object, 'edited', path);
		if (habit !== null && !habits.has(habit)) return this.error(join(path, 'habit'), `Unknown habit ${habit}`);
		if (entryValue !== null) {
			if (!isEntryValue(entryValue)) return this.error(join(path, 'value'), `Must be positive, at most ${MAX_VALUE}, with at most 3 decimals`);
			if (habits.get(habit!) === 'check' && entryValue !== 1) return this.error(join(path, 'value'), 'Must be 1 for a check habit');
		}
		if (habit === null || date === null || entryValue === null || edited === null) return null;
		const key = entryKey({ habit, date });
		if (keys.has(key)) return this.error(path, `Second entry for habit ${habit} on ${date}`);
		keys.add(key);
		return { habit, date, value: entryValue, edited };
	}
}

/** Parses file content. Never throws for bad input: all problems are reported with their location. */
export function parseDiscipline(content: string): ParseResult {
	let root: unknown;
	try {
		// (a byte order mark, as some Windows editors write)
		root = JSON.parse(content.replace(/^﻿/, ''));
	} catch (e) {
		return { ok: false, errors: [{ path: '', message: `Not valid JSON: ${(e as Error).message}` }], warnings: [] };
	}
	const p = new Parser();
	const failed = (): ParseResult => ({ ok: false, errors: p.errors, warnings: p.warnings });
	if (!isObject(root)) {
		p.error('', 'The file must contain a JSON object');
		return failed();
	}
	const version = p.number(root, 'version', '');
	if (version === null) return failed();
	if (version !== FORMAT_VERSION) {
		p.error(
			'version',
			Number.isInteger(version) && version > FORMAT_VERSION
				? `The file was written by a newer version of Discipline (format ${version}). Update the app (restart it) to open it.`
				: `Unsupported version ${version}, expected ${FORMAT_VERSION}`,
		);
		return failed();
	}
	p.object(root, '', ['version', 'habits', 'entries']);

	const seen = new Map<Id, HabitKind | null>();
	const habits = (p.array(root, 'habits', '') ?? []).map((value, i) => p.habit(value, `habits[${i}]`, seen));
	const keys = new Set<string>();
	const entries = (p.array(root, 'entries', '') ?? []).map((value, i) => p.entry(value, `entries[${i}]`, seen, keys));

	if (p.errors.length > 0) return failed();
	const valid = <T>(items: (T | null)[]): T[] => items.filter((item) => item !== null);
	return { ok: true, data: { habits: valid(habits).sort(compareHabits), entries: valid(entries).sort(compareEntries) }, warnings: p.warnings };
}

// ------------------------------------------------------------------------------------- writing

function goalToJson(g: DatedGoal) {
	return g.period === 'day' ? { from: g.from, period: g.period, days: g.days, target: g.target } : { from: g.from, period: g.period, target: g.target };
}

function habitToJson(h: Habit): string {
	return line({ id: h.id, name: h.name, kind: h.kind, unit: h.unit, goals: h.goals.map(goalToJson), color: h.color, position: h.position, archived: h.archived, edited: formatTimestamp(h.edited) });
}

function entryToJson(e: Entry): string {
	return line({ habit: e.habit, date: e.date, value: e.value, edited: formatTimestamp(e.edited) });
}

/** A record on one line, with a space after colons and commas for readability */
function line(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(line).join(', ')}]`;
	if (isObject(value)) return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${line(v)}`).join(', ')}}`;
	return JSON.stringify(value);
}

function list(lines: readonly string[]): string {
	return lines.length === 0 ? '[]' : `[\n${lines.map((l) => `\t\t${l}`).join(',\n')}\n\t]`;
}

/** Serializes the data (sorted, so equal data gives equal text), with a final newline. */
export function serializeDiscipline(data: DisciplineData): string {
	const habits = [...data.habits].sort(compareHabits).map(habitToJson);
	const entries = [...data.entries].sort(compareEntries).map(entryToJson);
	return `{\n\t"version": ${FORMAT_VERSION},\n\t"habits": ${list(habits)},\n\t"entries": ${list(entries)}\n}\n`;
}
