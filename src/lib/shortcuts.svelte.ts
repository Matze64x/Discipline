import { untrack } from 'svelte';

/**
 * Keyboard shortcuts: one registry that handles the keys and feeds the shortcut help (`?`), so
 * the help always lists exactly what works.
 *
 * Key notation: `n`, `?`, `Delete`, `Mod+Enter` (Mod = Ctrl, or ⌘ on Apple devices), `Shift+…`,
 * `Alt+…`, and sequences like `g t` (press g, then t). While typing in a text field only shortcuts
 * marked `inFields` fire. Enter and Space on a focused button (link, checkbox, …) activate it, never
 * a shortcut. The other platform's modifier (Ctrl on Apple devices) is never a shortcut, and letters
 * ignore Caps Lock.
 */

export interface Shortcut {
	/** One or more alternative key combinations, e.g. ['j', 'ArrowDown'] */
	readonly keys: readonly string[];
	readonly description: string;
	/** How the keys are shown in the help, if not each of them (e.g. '0–9' for all digits) */
	readonly keysLabel?: string;
	/** Heading in the help, e.g. 'Habits' */
	readonly group: string;
	/** Also fire while the focus is in a text field */
	readonly inFields?: boolean;
	/** Applies while a dialog is open (otherwise only shortcuts of the page behind apply) */
	readonly inDialog?: boolean;
	/** Whether the shortcut belongs to what's shown (for the help); defaults to `when` */
	readonly visible?: () => boolean;
	/** Whether the shortcut currently applies (e.g. only while a list is shown) */
	readonly when?: () => boolean;
	/**
	 * Only while the focus is inside this element or on nothing in particular (e.g. Delete for a
	 * list's selection must not fire while a button elsewhere has the focus)
	 */
	readonly focusIn?: () => Element | undefined;
	/** Fires again while the key is held down (for moving around); otherwise only once */
	readonly repeat?: boolean;
	run(event: KeyboardEvent): void;
}

const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** How a key combination is shown to the user, e.g. 'Mod+Enter' -> 'Ctrl+Enter' (or '⌘ Enter'). */
export function displayKeys(keys: string): string {
	return keys
		.split(' ')
		.map((combo) =>
			combo
				.split('+')
				.map((part) => (part === 'Mod' ? (isApple ? '⌘' : 'Ctrl') : part === 'ArrowUp' ? '↑' : part === 'ArrowDown' ? '↓' : part === 'ArrowLeft' ? '←' : part === 'ArrowRight' ? '→' : part === ' ' ? 'Space' : part))
				.join(isApple ? ' ' : '+'),
		)
		.join(' then ');
}

/** The combination in key notation, or null if it can't be a shortcut. */
function comboOf(event: KeyboardEvent): string | null {
	if (isApple ? event.ctrlKey : event.metaKey) return null;
	const mod = isApple ? event.metaKey : event.ctrlKey;
	// with Caps Lock, `key` is 'N' for n: for letters only Shift decides the case
	const key = /^[a-z]$/i.test(event.key) ? (event.shiftKey ? event.key.toUpperCase() : event.key.toLowerCase()) : event.key;
	const printable = key.length === 1;
	const parts: string[] = [];
	if (mod) parts.push('Mod');
	if (event.altKey) parts.push('Alt');
	// for printable keys Shift is already part of the character ('?', 'N'), except together with Mod
	if (event.shiftKey && (!printable || mod)) parts.push('Shift');
	parts.push(printable && mod ? key.toLowerCase() : key);
	return parts.join('+');
}

/** Controls that Enter or Space activate themselves */
const ACTIVATABLE = 'button, a[href], summary, input[type=button], input[type=submit], input[type=reset], input[type=checkbox], input[type=radio], input[type=color], input[type=file]';

function isTextField(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
	return target instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(target.type);
}

class ShortcutRegistry {
	shortcuts = $state.raw<readonly Shortcut[]>([]);
	helpOpen = $state(false);
	/** Number of open dialogs; while any is open, only `inDialog` shortcuts apply */
	dialogs = $state(0);
	#pending: string | null = null;
	#pendingTimer: ReturnType<typeof setTimeout> | undefined;

	/** Registers shortcuts while a component is shown; returns the function that removes them. */
	// (called from components' effects: `untrack` keeps those effects from depending on the registry)
	add(list: readonly Shortcut[]): () => void {
		untrack(() => (this.shortcuts = [...this.shortcuts, ...list]));
		return () => untrack(() => (this.shortcuts = this.shortcuts.filter((s) => !list.includes(s))));
	}

	/** Marks a dialog as open; returns the function to call when it closes. */
	openDialog(): () => void {
		untrack(() => this.dialogs++);
		let closed = false;
		return () => {
			if (!closed) untrack(() => this.dialogs--);
			closed = true;
		};
	}

	/** The shortcuts that apply right now. */
	active(): Shortcut[] {
		return this.shortcuts.filter((s) => (this.dialogs === 0 || s.inDialog) && (s.when?.() ?? true));
	}

	/** Everything the help lists: what applies on the current page, ignoring open dialogs. */
	available(): Shortcut[] {
		return this.shortcuts.filter((s) => (s.visible ?? s.when)?.() ?? true);
	}

	handle = (event: KeyboardEvent): void => {
		if (event.defaultPrevented || event.isComposing) return;
		const combo = comboOf(event);
		if (combo === null) return;
		const target = event.target instanceof Element ? event.target : null;
		if ((combo === 'Enter' || combo === ' ') && target?.matches(ACTIVATABLE)) return;
		const inField = isTextField(target);
		const focusedNowhere = !target || target === document.body || target === document.documentElement;
		const typed = this.#pending ? `${this.#pending} ${combo}` : combo;
		const candidates = this.active().filter((s) => (!inField || s.inFields) && (!s.focusIn || focusedNowhere || !!s.focusIn()?.contains(target)));
		const match = candidates.find((s) => s.keys.includes(typed)) ?? (this.#pending ? candidates.find((s) => s.keys.includes(combo)) : undefined);
		this.#clearPending();
		if (match) {
			event.preventDefault();
			// holding a key down (e.g. Delete) must not repeat the action, except for moving around
			if (!event.repeat || match.repeat) match.run(event);
			return;
		}
		// the start of a sequence like `g t`
		if (!inField && candidates.some((s) => s.keys.some((k) => k.startsWith(`${combo} `)))) {
			event.preventDefault();
			this.#pending = combo;
			this.#pendingTimer = setTimeout(() => this.#clearPending(), 1500);
		}
	};

	#clearPending(): void {
		clearTimeout(this.#pendingTimer);
		this.#pending = null;
	}
}

export const shortcuts = new ShortcutRegistry();
