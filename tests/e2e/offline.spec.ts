/** The build exactly as published on GitHub Pages (below /Discipline/), see playwright.config.ts. */
import { expect, test } from '@playwright/test';
import { waitForApp, fileAction } from './app';
import { fileURLToPath } from 'node:url';

const PUBLISHED = 'http://localhost:5298/Discipline/';
const FIXTURE = fileURLToPath(new URL('../fixtures/example.json', import.meta.url));

test('the installed app works offline, with its data', async ({ page, context }) => {
	await page.goto(PUBLISHED);
	// the service worker takes over once it has cached the app
	await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

	await waitForApp(page);
	const chooser = page.waitForEvent('filechooser');
	await fileAction(page, 'Import');
	await (await chooser).setFiles(FIXTURE);
	await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
	await expect(page.getByRole('listbox', { name: 'Habits of the day' }).getByRole('option').filter({ hasText: 'Run' })).toBeVisible();

	await context.setOffline(true);
	// served by the service worker (Firefox's offline mode would also serve the HTTP cache)
	const response = await page.reload();
	expect(response?.fromServiceWorker()).toBe(true);
	await expect(page.getByRole('listbox', { name: 'Habits of the day' }).getByRole('option').filter({ hasText: 'Run' })).toBeVisible();
});

test('everything is served below the base path and the app can be installed', async ({ page, request }) => {
	await page.goto(PUBLISHED);
	const touchIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
	expect(touchIcon).toBe('/Discipline/apple-touch-icon.png');
	expect((await request.get(new URL(touchIcon!, PUBLISHED).href)).ok()).toBe(true);

	const manifestUrl = new URL((await page.locator('link[rel="manifest"]').getAttribute('href'))!, PUBLISHED).href;
	const manifest = await (await request.get(manifestUrl)).json();
	expect(manifest).toMatchObject({ name: 'Discipline', display: 'standalone' });
	// start_url and scope resolve to the app's folder on Pages
	expect(new URL(manifest.start_url, manifestUrl).href).toBe(PUBLISHED);
	expect(new URL(manifest.scope, manifestUrl).href).toBe(PUBLISHED);
	for (const icon of manifest.icons) expect((await request.get(new URL(icon.src, manifestUrl).href)).ok()).toBe(true);

	const registration = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope));
	expect(registration).toBe(PUBLISHED);
});
