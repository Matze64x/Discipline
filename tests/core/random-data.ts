/** Deterministic random Discipline data for property, merge and round-trip tests. */
import {
	addDays,
	addHabit,
	cleanText,
	compareEntries,
	compareHabits,
	deleteHabit,
	EditError,
	MAX_POSITION,
	MAX_VALUE,
	MAX_YEAR,
	MIN_YEAR,
	moveHabit,
	PERIOD_DAYS,
	setArchived,
	setEntry,
	toDraft,
	updateHabit,
	WEEKDAYS,
	type CivilDate,
	type DatedGoal,
	type DisciplineData,
	type Entry,
	type Goal,
	type Habit,
	type HabitKind,
	type Id,
	type UtcSeconds,
	type Weekday,
} from '../../src/core';

/** mulberry32: small seeded PRNG, good enough for test data. */
export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Text pieces that stress escaping and UTF-8. Lone surrogates aren't representable in UTF-8 and NUL
// is dropped by `cleanText`: the app never stores either.
const PIECES = ['Read', 'Run', 'a', ' ', '"', '\\', '/', '\n', '\t', '\u0001', '\u001f', '\u007f', 'Müsli', '寿司', 'Ελληνικά', '🧘', '👨‍👩‍👧', ' ', '&<>', '{}', ':', ','];

export const FIRST_DAY = `${MIN_YEAR}-01-01` as CivilDate;
export const LAST_DAY = `${MAX_YEAR}-12-31` as CivilDate;

/** Random building blocks drawing from one PRNG */
export function generator(seed: number) {
	const rnd = seededRandom(seed);
	const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
	const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
	const chance = (p: number): boolean => rnd() < p;
	/** Text as the app stores it (see `cleanText`) */
	const text = (): string => cleanText(Array.from({ length: int(0, 5) }, () => pick(PIECES)).join(''));
	const name = (): string => {
		for (;;) {
			const t = text();
			if (t !== '') return t;
		}
	};
	const usedIds = new Set<string>();
	// mostly random 64-bit values like in the app, mixed with small and maximal ones
	const id = (): Id => {
		for (;;) {
			const kind = int(0, 3);
			const value = kind === 0 ? BigInt(int(1, 2 ** 20)) : kind === 1 ? (1n << 64n) - BigInt(int(1, 2 ** 20)) : (BigInt(int(0, 2 ** 31)) << 32n) + BigInt(int(1, 2 ** 32 - 1));
			const s = value.toString();
			if (!usedIds.has(s)) {
				usedIds.add(s);
				return s as Id;
			}
		}
	};
	// mostly around now, sometimes at the ends of the supported range
	const date = (): CivilDate => (chance(0.05) ? pick([FIRST_DAY, LAST_DAY, '2024-02-29' as CivilDate]) : addDays('2026-01-01' as CivilDate, int(-800, 800)));
	const time = (): UtcSeconds => (chance(0.05) ? pick([Date.UTC(MIN_YEAR, 0, 1) / 1000, Date.UTC(MAX_YEAR, 11, 31, 23, 59, 59) / 1000, 0]) : 1_780_000_000 + int(-50_000_000, 50_000_000)) as UtcSeconds;
	const amount = (): number => pick([() => int(1, 120), () => int(1, 99_999) / 1000, () => MAX_VALUE, () => 0.001, () => int(1, 500) / 10])();
	const goal = (kind: HabitKind): Goal => {
		const period = pick(['day', 'day', 'week', 'month'] as const);
		if (period === 'day') {
			const days = chance(0.5) ? [...WEEKDAYS] : WEEKDAYS.filter(() => chance(0.5));
			return { period, days: days.length > 0 ? days : [pick(WEEKDAYS) as Weekday], target: kind === 'check' ? 1 : amount() };
		}
		return { period, target: kind === 'check' ? int(1, PERIOD_DAYS[period]) : amount() };
	};
	/** 1–3 goals over time, the first from `start` */
	const goals = (kind: HabitKind, start: CivilDate): DatedGoal[] => {
		const result: DatedGoal[] = [{ from: start, ...goal(kind) }];
		for (let n = int(0, 2); n > 0; n--) {
			const last = result.at(-1)!.from;
			if (last >= addDays(LAST_DAY, -200)) break;
			result.push({ from: addDays(last, int(1, 200)), ...goal(kind) });
		}
		return result;
	};
	const habit = (position: number): Habit => {
		const kind = pick(['check', 'amount'] as const);
		return {
			id: id(),
			name: name(),
			kind,
			unit: kind === 'amount' && chance(0.7) ? text() : '',
			goals: goals(kind, date()),
			color: `#${int(0, 0xffffff).toString(16).padStart(6, '0')}`,
			position,
			archived: chance(0.2) ? date() : null,
			edited: time(),
		};
	};
	const entry = (h: Habit, date: CivilDate): Entry => ({ habit: h.id, date, value: h.kind === 'check' ? 1 : amount(), edited: time() });
	return { rnd, int, pick, chance, text, name, id, date, time, amount, goal, goals, habit, entry };
}

/** A random valid document: some habits with entries on random days around now */
export function randomData(seed: number, size = 1): DisciplineData {
	const g = generator(seed);
	const habits = Array.from({ length: g.int(0, 6 * size) }, () => g.habit(g.pick([g.int(-5, 20), g.int(-100, 100) / 7, 1e-9 * g.int(1, 9), MAX_POSITION, -MAX_POSITION, 0])));
	const entries = new Map<string, Entry>();
	for (const h of habits) {
		for (let n = g.int(0, 40 * size); n > 0; n--) {
			const e = g.entry(h, g.date());
			entries.set(`${e.habit}/${e.date}`, e);
		}
	}
	return { habits: habits.sort(compareHabits), entries: [...entries.values()].sort(compareEntries) };
}

/**
 * A random sequence of edits, as the app makes them (through `edit.ts`), so the result is valid.
 * Edits often hit existing entries and habits, so two edits of the same base overlap. `check` is
 * called with the data after each edit.
 */
export function randomEdit(data: DisciplineData, seed: number, count = 8, check?: (data: DisciplineData, action: string) => void, dense = false): DisciplineData {
	const g = generator(seed);
	// dense: a few days and timestamps only, so two edits of the same base often collide and tie
	const now = (1_790_000_000 + (dense ? g.int(0, 2) : g.int(0, 1_000_000))) as UtcSeconds;
	const day = () => (dense ? addDays('2026-11-20' as CivilDate, g.int(0, 3)) : g.date());
	for (let i = 0; i < count; i++) {
		const habit = data.habits.length > 0 ? g.pick(data.habits) : undefined;
		const action = habit ? g.int(0, 9) : 0;
		let name = 'add';
		try {
			if (action === 0 || !habit) {
				const h = g.habit(0);
				// (names as typed: the edit cleans them)
				data = addHabit(data, { ...toDraft(h), name: g.chance(0.2) ? ` ${h.name}\u0000 ` : h.name }, now).data;
			} else if (action <= 5) {
				name = 'setEntry';
				const existing = data.entries.filter((e) => e.habit === habit.id);
				const date = existing.length > 0 && g.chance(0.6) ? g.pick(existing).date : day();
				const value = g.chance(0.3) ? null : habit.kind === 'check' ? 1 : g.amount();
				data = setEntry(data, habit.id, date, value, now);
			} else if (action === 6) {
				name = 'update';
				const kind = g.chance(0.8) ? habit.kind : g.pick(['check', 'amount'] as const);
				const old = toDraft(habit);
				const draft = {
					...old,
					name: g.chance(0.5) ? g.name() : old.name,
					kind,
					unit: kind === 'amount' ? old.unit : '',
					goal: kind === habit.kind && g.chance(0.5) ? old.goal : g.goal(kind),
					start: g.chance(0.2) ? g.date() : old.start,
				};
				data = updateHabit(data, habit.id, draft, day(), now);
			} else if (action === 7) {
				name = 'archive';
				data = setArchived(data, habit.id, habit.archived ? null : day(), now);
			} else if (action === 8) {
				name = 'move';
				const before = g.chance(0.2) ? null : g.pick(data.habits).id;
				if (before !== habit.id) data = moveHabit(data, habit.id, before, now);
			} else if (g.chance(0.3)) {
				name = 'delete';
				data = deleteHabit(data, habit.id);
			}
		} catch (e) {
			// refused edits (e.g. amount -> check with amounts entered) are fine: the app refuses them too
			if (!(e instanceof EditError)) throw e;
		}
		check?.(data, name);
	}
	return data;
}
