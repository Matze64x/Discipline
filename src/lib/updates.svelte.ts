/**
 * Updates of the installed web app (a phone's home screen app, or a browser's). The app runs from
 * the copy its service worker (src/sw/sw.ts) keeps on the device; GitHub Pages is only asked for
 * new versions:
 * - `version.json` (not cached) tells whether a newer version is out (`available`);
 * - with automatic updates, the service worker installs it in the background, and it takes over
 *   when the app goes to the background with no dialog open (else at the next start), never while
 *   it's in use;
 * - else the service worker refuses to install it until the user taps "Update" (`apply`), which
 *   installs it, waits until all changes are saved and reloads.
 * The service worker's state is watched directly (not through workbox-window's events, which stop
 * after a few refused installs). The desktop app ships its files itself: nothing to do there, and
 * in the dev server neither.
 */
import { set } from 'idb-keyval';
import { isDesktop } from './desktop';
import { settings } from './settings.svelte';
import { POLICY_KEY, type UpdatePolicy } from './update-policy';

/** How often to ask for a new version while the app is open (also when it comes back to the front) */
const CHECK_EVERY_MS = 60 * 60 * 1000;
/** How long "Update" waits for the new version to download and install */
const INSTALL_TIMEOUT_MS = 60_000;

export const APP_VERSION = __APP_VERSION__;

/** Resolves with the registration's waiting worker once there is one (null after `timeout` ms) */
function waitingWorker(registration: ServiceWorkerRegistration, timeout: number): Promise<ServiceWorker | null> {
	return new Promise((resolve) => {
		const done = (worker: ServiceWorker | null) => {
			clearTimeout(timer);
			clearInterval(poll);
			registration.removeEventListener('updatefound', onFound);
			resolve(worker);
		};
		const check = () => registration.waiting && done(registration.waiting);
		const onFound = () => registration.installing?.addEventListener('statechange', check);
		registration.addEventListener('updatefound', onFound);
		registration.installing?.addEventListener('statechange', check);
		// (also catches a worker that installed before we listened)
		const poll = setInterval(check, 500);
		const timer = setTimeout(() => done(null), timeout);
		check();
	});
}

class Updates {
	/** The installed web app, with a service worker: updates are handled here */
	supported = $state(false);
	/** A newer version is out (or already downloaded) */
	available = $state(false);
	/** Checking or updating right now */
	busy = $state(false);
	/** When the last successful check finished (ms), or null */
	checked = $state<number | null>(null);
	failure = $state<string | null>(null);

	#registration: ServiceWorkerRegistration | undefined;
	#settled: () => Promise<void> = async () => {};

	/** Registers the service worker and starts checking. `settled` waits until all changes are saved. */
	async start(settled: () => Promise<void>): Promise<() => void> {
		if (isDesktop || !import.meta.env.PROD || !('serviceWorker' in navigator)) return () => {};
		this.#settled = settled;
		this.supported = true;
		// a home screen app's storage is kept anyway; for a browser tab, ask to keep it too
		void navigator.storage?.persist?.().catch(() => false);
		await this.#savePolicy(false);
		const { registerSW } = await import('virtual:pwa-register');
		registerSW({
			immediate: true,
			onRegisteredSW: (_url, registration) => {
				this.#registration = registration;
				if (registration?.waiting) this.available = true;
				void this.check();
			},
			onNeedRefresh: () => (this.available = true),
		});
		const onVisibility = () => {
			if (document.visibilityState === 'hidden') {
				// out of sight: a good moment for an automatic update, unless something is being edited
				if (settings.updates === 'auto' && this.#registration?.waiting && !document.querySelector('dialog[open]')) void this.#switch();
			} else if (this.checked === null || Date.now() - this.checked > CHECK_EVERY_MS) {
				void this.check();
			}
		};
		document.addEventListener('visibilitychange', onVisibility);
		const timer = setInterval(() => document.visibilityState === 'visible' && void this.check(), CHECK_EVERY_MS);
		return () => {
			document.removeEventListener('visibilitychange', onVisibility);
			clearInterval(timer);
		};
	}

	/** Asks for a new version. Returns whether one is available. */
	async check(): Promise<boolean> {
		if (!this.supported || this.busy) return this.available;
		this.busy = true;
		this.failure = null;
		try {
			const response = await fetch(`${import.meta.env.BASE_URL}version.json`, { cache: 'no-store' });
			if (!response.ok) throw new Error(`the server answered ${response.status}`);
			const { version } = (await response.json()) as { version?: unknown };
			this.available = Boolean(this.#registration?.waiting) || (typeof version === 'string' && version !== APP_VERSION);
			// (automatic: lets the service worker download it now; else it refuses anyway)
			if (this.available && settings.updates === 'auto') await this.#registration?.update();
			this.checked = Date.now();
		} catch (e) {
			// offline or the server is unreachable: fine, the app keeps running as it is
			this.checked = null;
			this.failure = navigator.onLine ? `Can’t check for updates: ${e instanceof Error ? e.message : String(e)}` : 'Offline: can’t check for updates.';
		} finally {
			this.busy = false;
		}
		return this.available;
	}

	/** Installs the new version (if it isn't yet) and switches to it: the app reloads */
	async apply(): Promise<void> {
		const registration = this.#registration;
		if (!this.supported || this.busy || !registration) return;
		this.busy = true;
		this.failure = null;
		try {
			if (!registration.waiting) {
				await this.#savePolicy(true);
				await registration.update();
				if (!(await waitingWorker(registration, INSTALL_TIMEOUT_MS))) throw new Error('the new version didn’t arrive. Try again later.');
			}
			if (!(await this.#switch())) throw new Error('no new version to switch to.');
		} catch (e) {
			this.failure = `Can’t update: ${e instanceof Error ? e.message : String(e)}`;
			this.busy = false;
		}
	}

	/** Changes the update setting */
	async setAutomatic(auto: boolean): Promise<void> {
		settings.updates = auto ? 'auto' : 'ask';
		await this.#savePolicy(false);
		if (auto && this.available) await this.#registration?.update();
	}

	/** Lets the waiting version take over; the page reloads then. False if there is none. */
	async #switch(): Promise<boolean> {
		// (a reload must not cut off a change being saved)
		await this.#settled();
		const waiting = this.#registration?.waiting;
		if (!waiting) return false;
		// reload once it's fully active (WebKit reports the new controller while it's still activating,
		// and a reload then can still get the old version)
		const activated = new Promise<void>((resolve) => {
			const check = () => waiting.state === 'activated' && resolve();
			waiting.addEventListener('statechange', check);
			check();
		});
		const controlling = new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
		void Promise.all([activated, controlling]).then(() => window.location.reload());
		waiting.postMessage({ type: 'SKIP_WAITING' });
		return true;
	}

	/** What the service worker reads before installing a new version */
	async #savePolicy(approved: boolean): Promise<void> {
		const policy: UpdatePolicy = { auto: settings.updates === 'auto', approved, stored: Date.now() };
		await set(POLICY_KEY, policy).catch(() => undefined);
	}
}

export const updates = new Updates();
