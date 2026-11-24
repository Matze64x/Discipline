/**
 * Per-device preferences (not part of the data file). Kept in localStorage, which can be
 * unavailable (private windows, blocked storage): then the defaults apply and changes last until
 * the page is closed. Other tabs pick up changes through the `storage` event.
 */
import { DATE_STYLES, type DateStyle } from '../core';

/** The days a week can start on: Monday or Sunday */
export type WeekStart = 1 | 7;

const KEY = 'discipline-settings-v1';

interface Values {
	dateStyle: DateStyle;
	/** When a new day starts, in minutes after midnight (e.g. 240: until 04:00 it's still yesterday) */
	dayStart: number;
	/** The first day of the week (for weekly goals and week views): Monday or Sunday */
	weekStart: WeekStart;
	/** Desktop app: the file the data is backed up to, or null for none */
	backupPath: string | null;
}

const DEFAULTS: Values = { dateStyle: 'DD.MM.YYYY', dayStart: 0, weekStart: 1, backupPath: null };

/** Day starts the user can choose: midnight to 06:00, in half hours */
export const DAY_STARTS: readonly number[] = Array.from({ length: 13 }, (_, i) => i * 30);

function load(): Values {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Values>;
		return {
			dateStyle: DATE_STYLES.includes(raw.dateStyle as DateStyle) ? raw.dateStyle! : DEFAULTS.dateStyle,
			dayStart: DAY_STARTS.includes(raw.dayStart as number) ? raw.dayStart! : DEFAULTS.dayStart,
			weekStart: raw.weekStart === 7 ? 7 : 1,
			backupPath: typeof raw.backupPath === 'string' && raw.backupPath !== '' ? raw.backupPath : null,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

class Settings {
	#values = $state.raw<Values>(load());

	constructor() {
		if (typeof window !== 'undefined') window.addEventListener('storage', (e) => e.key === KEY && (this.#values = load()));
	}

	get dateStyle(): DateStyle {
		return this.#values.dateStyle;
	}
	set dateStyle(dateStyle: DateStyle) {
		this.#set({ dateStyle });
	}

	get dayStart(): number {
		return this.#values.dayStart;
	}
	set dayStart(dayStart: number) {
		this.#set({ dayStart });
	}

	get weekStart(): WeekStart {
		return this.#values.weekStart;
	}
	set weekStart(weekStart: WeekStart) {
		this.#set({ weekStart });
	}

	get backupPath(): string | null {
		return this.#values.backupPath;
	}
	set backupPath(backupPath: string | null) {
		this.#set({ backupPath });
	}

	#set(changes: Partial<Values>) {
		this.#values = { ...this.#values, ...changes };
		try {
			localStorage.setItem(KEY, JSON.stringify(this.#values));
		} catch {
			// not stored; still applies until the page is closed
		}
	}
}

export const settings = new Settings();
