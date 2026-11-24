/**
 * Today's date, kept current: views stay mounted for as long as the app is open, so anything that
 * depends on "today" reads it from here to follow a new day. A day starts at the user's chosen
 * time (`settings.dayStart`), so after midnight it can still be yesterday.
 */
import { today } from '../core';
import { settings } from './settings.svelte';

class Clock {
	/** Bumped to recompute `today`; it only changes (and wakes dependents) when the day does */
	#tick = $state(0);
	readonly today = $derived.by(() => {
		void this.#tick;
		return today(settings.dayStart);
	});

	constructor() {
		const tick = () => this.#tick++;
		setInterval(tick, 30_000);
		// a phone resumes a paused app without running its timers first: check right away, so a
		// check-off in the morning doesn't land on yesterday
		if (typeof window !== 'undefined') {
			document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && tick());
			window.addEventListener('pageshow', tick);
			window.addEventListener('focus', tick);
		}
	}
}

export const clock = new Clock();
