/**
 * Messages shown floating at the bottom of the screen (they don't shift the page):
 * - info ("Deleted …", "Imported."): one at a time, a new one replaces it; it goes away by itself
 * - errors: stay until dismissed (several at once, the same text only once), so none is missed
 * Inside a dialog, show problems in the dialog instead: the dialog covers these.
 */

export interface Notice {
	readonly id: number;
	readonly text: string;
	readonly error: boolean;
	/** Offer to undo the last change (only while it's still the last one) */
	readonly undo: boolean;
}

/** How long an info message stays */
export const INFO_MS = 6000;

class Notices {
	list = $state.raw<readonly Notice[]>([]);
	#nextId = 1;
	#timer: ReturnType<typeof setTimeout> | undefined;

	info(text: string, undo = false): void {
		const notice = { id: this.#nextId++, text, error: false, undo };
		this.list = [...this.list.filter((n) => n.error), notice];
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.dismiss(notice.id), INFO_MS);
	}

	error(text: string): void {
		if (this.list.some((n) => n.error && n.text === text)) return;
		this.list = [...this.list, { id: this.#nextId++, text, error: true, undo: false }];
	}

	/** Removes the info message (e.g. an action finished without anything to say) */
	clearInfo(): void {
		this.list = this.list.filter((n) => n.error);
	}

	dismiss(id: number): void {
		this.list = this.list.filter((n) => n.id !== id);
	}
}

export const notices = new Notices();

/** Shows an error that stays until dismissed (e.g. for `attempt`) */
export const showError = (text: string): void => notices.error(text);
