/**
 * Updates of the installed web app, against published builds (with their service worker): the
 * update server (update-server.mjs) serves the "next" build once it's published, as GitHub Pages
 * would. One server per project; the tests here run one after the other (they switch it).
 */
import { expect, test, type Page } from '@playwright/test';
import { openSettings, waitForApp } from './app';

test.describe.configure({ mode: 'serial' });

let server = '';
let PUBLISHED = '';
test.beforeEach(async ({ request }, testInfo) => {
	server = `http://127.0.0.1:${testInfo.project.name === 'iphone' ? 5399 : 5398}`;
	PUBLISHED = `${server}/Discipline/`;
	await request.get(`${server}/publish/first`);
});

/** Opens the app as on every start after the first: served by its service worker */
async function openPublished(page: Page) {
	await page.goto(PUBLISHED);
	await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
	// (on the very first visit the page isn't controlled yet, and a new version would take over at once)
	await page.reload();
	await waitForApp(page);
	expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
}

/** From now on the server offers the next version */
const publishNext = async (page: Page) => void (await page.request.get(`${server}/publish/next`));

/** The version the app runs, as the settings show it */
async function runningVersion(page: Page): Promise<string> {
	const settings = await openSettings(page);
	const text = (await settings.getByText(/^Version /).textContent()) ?? '';
	await page.keyboard.press('Escape');
	return text.endsWith(' next') ? 'next' : 'first';
}

const updateNotice = (page: Page) => page.getByRole('status').filter({ hasText: 'New version available.' });

test('the settings show the version and check for updates', async ({ page }) => {
	await openPublished(page);
	const settings = await openSettings(page);
	await expect(settings).toContainText(/Version (\d{4}-\d{2}-\d{2} [0-9a-f]+|unknown)/);
	await settings.getByRole('button', { name: 'Check for updates' }).click();
	await expect(settings).toContainText('Up to date.');
});

test('manual updates: a new version waits until Update, then takes over', async ({ context }) => {
	let page = await context.newPage();
	await openPublished(page);
	const settings = await openSettings(page);
	await settings.getByText('Manual', { exact: true }).click();
	await publishNext(page);
	await settings.getByRole('button', { name: 'Check for updates' }).click();
	await expect(settings).toContainText('New version available.');
	await page.keyboard.press('Escape');
	await expect(updateNotice(page)).toBeVisible();

	// the browser looks for it too, several times (a restart would then use it), but the service
	// worker refuses it each time
	const held = await page.evaluate(async () => {
		const registration = await navigator.serviceWorker.ready;
		for (let i = 0; i < 3; i++) {
			await registration.update().catch(() => undefined);
			await new Promise((r) => setTimeout(r, 1000));
		}
		return registration.waiting === null && registration.installing === null;
	});
	expect(held).toBe(true);
	// closed and started again: still the version it had
	await page.close();
	page = await context.newPage();
	await page.goto(PUBLISHED);
	await waitForApp(page);
	expect(await runningVersion(page)).toBe('first');

	// Update: installs it, and the app reloads with it (with its settings)
	await page.evaluate(() => Object.assign(window, { beforeUpdate: true }));
	await updateNotice(page).getByRole('button', { name: 'Update' }).click();
	await expect.poll(() => page.evaluate(() => 'beforeUpdate' in window), { timeout: 30_000 }).toBe(false);
	await waitForApp(page);
	expect(await runningVersion(page)).toBe('next');
	await expect(updateNotice(page)).toHaveCount(0);
	await expect((await openSettings(page)).getByLabel('Manual', { exact: true })).toBeChecked();
});

test('automatic: a new version installs in the background and takes over when the app is hidden', async ({ page }) => {
	await openPublished(page);
	await publishNext(page);
	const settings = await openSettings(page);
	await settings.getByRole('button', { name: 'Check for updates' }).click();
	await page.keyboard.press('Escape');
	// downloaded and waiting, while the app is in use; no notice
	await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).waiting !== null), { timeout: 30_000 }).toBe(true);
	await expect(updateNotice(page)).toHaveCount(0);
	expect(await runningVersion(page)).toBe('first');

	const hide = () =>
		page.evaluate(() => {
			Object.assign(window, { beforeUpdate: true });
			Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
			document.dispatchEvent(new Event('visibilitychange'));
		});
	// not while something is being edited: a dialog is open
	await page.keyboard.press('n');
	await expect(page.getByRole('dialog', { name: 'New habit' })).toBeVisible();
	await hide();
	await page.waitForTimeout(1500);
	expect(await page.evaluate(() => 'beforeUpdate' in window)).toBe(true);
	await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }));
	await page.keyboard.press('Escape');

	// the app goes to the background: it switches
	await hide();
	await expect.poll(() => page.evaluate(() => 'beforeUpdate' in window), { timeout: 30_000 }).toBe(false);
	await waitForApp(page);
	expect(await runningVersion(page)).toBe('next');
});
