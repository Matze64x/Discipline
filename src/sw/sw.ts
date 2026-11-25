/**
 * The installed web app's service worker: keeps the whole app on the device (precached), so it
 * starts offline, and serves it from there. A new version installs only if the update policy
 * allows it (`update-policy.ts`): with automatic updates always, else only after the user tapped
 * "Update". Otherwise the browser would swap in a downloaded version at the next full start. A
 * refused version isn't even downloaded: the precache is filled only after the check.
 */
/// <reference lib="webworker" />
import { get } from 'idb-keyval';
import { cleanupOutdatedCaches, PrecacheController, PrecacheRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { mayInstall, POLICY_KEY, type UpdatePolicy } from '../lib/update-policy';

declare const self: ServiceWorkerGlobalScope;

const precache = new PrecacheController();
precache.addToCacheList(self.__WB_MANIFEST);

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const policy = await get<UpdatePolicy>(POLICY_KEY).catch(() => undefined);
			if (!mayInstall(policy, !self.registration.active, Date.now())) throw new Error('A new version waits until the user updates');
			await precache.install(event);
		})(),
	);
});
self.addEventListener('activate', (event) => event.waitUntil(precache.activate(event)));

registerRoute(new PrecacheRoute(precache));
// every page of the app is index.html (also offline)
registerRoute(new NavigationRoute(precache.createHandlerBoundToURL('index.html')));
cleanupOutdatedCaches();

// "Update" (or an automatic update): the waiting version takes over, then the page reloads
self.addEventListener('message', (event) => {
	if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});
