/**
 * Per-device preferences (not part of the data file; the day and week start are, see
 * `Preferences` in the core). Kept in localStorage, which can be
 * unavailable (private windows, blocked storage): then the defaults apply and changes last until
 * the page is closed. Other tabs pick up changes through the `storage` event.
 */
import { DATE_STYLES, DEFAULT_PREFERENCES, isDayStart, isWeekStart, type DateStyle, type Preferences } from '../core';

const KEY = 'discipline-settings-v1';

interface Values {
	dateStyle: DateStyle;
	/** Today: the whole month shown above the habits (else the week) */
	showMonth: boolean;
	/** Installed web app: new versions automatically, or only when the user taps "Update" */
	updates: 'auto' | 'ask';
	/** Desktop app: the file the data is backed up to, or null for none */
	backupPath: string | null;
}

const DEFAULTS: Values = { dateStyle: 'DD.MM.YYYY', showMonth: false, updates: 'auto', backupPath: null };

function load(): Values {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Values>;
		return {
			dateStyle: DATE_STYLES.includes(raw.dateStyle as DateStyle) ? raw.dateStyle! : DEFAULTS.dateStyle,
			showMonth: raw.showMonth === true,
			updates: raw.updates === 'ask' ? 'ask' : 'auto',
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

	get showMonth(): boolean {
		return this.#values.showMonth;
	}
	set showMonth(showMonth: boolean) {
		this.#set({ showMonth });
	}

	get updates(): 'auto' | 'ask' {
		return this.#values.updates;
	}
	set updates(updates: 'auto' | 'ask') {
		this.#set({ updates });
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
			// (keeps what isn't a value here any more, e.g. an old day start not yet moved into the data)
			const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
			localStorage.setItem(KEY, JSON.stringify({ ...stored, ...this.#values }));
		} catch {
			// not stored; still applies until the page is closed
		}
	}
}

export const settings = new Settings();

/**
 * The day and week start this device had while they were its own preferences (before they became
 * part of the data, 2026-11), if not the defaults; null otherwise. `forgetOldPreferences` drops them.
 */
export function oldPreferences(): Pick<Preferences, 'dayStart' | 'weekStart'> | null {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { dayStart?: unknown; weekStart?: unknown };
		const dayStart = isDayStart(raw.dayStart) ? raw.dayStart : DEFAULT_PREFERENCES.dayStart;
		const weekStart = isWeekStart(raw.weekStart) ? raw.weekStart : DEFAULT_PREFERENCES.weekStart;
		return dayStart === DEFAULT_PREFERENCES.dayStart && weekStart === DEFAULT_PREFERENCES.weekStart ? null : { dayStart, weekStart };
	} catch {
		return null;
	}
}

export function forgetOldPreferences(): void {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
		delete raw['dayStart'];
		delete raw['weekStart'];
		localStorage.setItem(KEY, JSON.stringify(raw));
	} catch {
		// nothing to forget
	}
}
