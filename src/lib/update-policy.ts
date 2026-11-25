/**
 * When the installed web app may take a new version: shared by the page (`updates.svelte.ts`)
 * and the service worker (`src/sw/sw.ts`), which reads it from IndexedDB before installing one.
 */

/** IndexedDB key (idb-keyval's default store, shared with CashGuard on github.io: prefixed) */
export const POLICY_KEY = 'discipline-update-policy-v1';

/**
 * If the app hasn't stored its policy for this long, a new version installs anyway: a version
 * whose page can't start (or whose Update button is broken) must not block its own fix for good.
 */
export const STALE_POLICY_MS = 3 * 24 * 60 * 60 * 1000;

export interface UpdatePolicy {
	/** Automatic updates: a new version installs in the background */
	readonly auto: boolean;
	/** The user asked for the update (tapped "Update"): installing it is allowed */
	readonly approved: boolean;
	/** When the app last started and stored this (ms since 1970) */
	readonly stored: number;
}

/**
 * Whether a new service worker (a new version of the app) may install. The first install always
 * may (the app must work offline from the start); so may one when no policy was stored (never set,
 * or unreadable), or none for a while (see `STALE_POLICY_MS`).
 */
export function mayInstall(policy: UpdatePolicy | undefined, firstInstall: boolean, now: number): boolean {
	if (firstInstall || policy === undefined || policy.auto || policy.approved) return true;
	return typeof policy.stored !== 'number' || now - policy.stored > STALE_POLICY_MS;
}
