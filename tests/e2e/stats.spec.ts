import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { fileAction, waitForApp } from './app';

const FIXTURE = fileURLToPath(new URL('../fixtures/example.json', import.meta.url));

test.beforeEach(async ({ page }) => {
	// Wednesday
	await page.clock.setFixedTime(new Date('2026-11-25T12:00:00'));
	await page.goto('/');
	await waitForApp(page);
	const chooser = page.waitForEvent('filechooser');
	await fileAction(page, 'Import');
	await (await chooser).setFiles(FIXTURE);
	await page.getByRole('dialog', { name: 'Import “example.json”' }).getByRole('button', { name: 'Import' }).click();
	await expect(page.getByRole('dialog')).toBeHidden();
	await page.getByRole('button', { name: 'Stats', exact: true }).click();
});

test('the overview: goals met this week, each habit’s recent rate', async ({ page }) => {
	// Read missed Mon and Tue (today is still open), Run's week isn't over
	await expect(page.getByText('of the goals met this week (0 of 2)')).toBeVisible();
	const list = page.getByRole('listbox', { name: 'Habit stats' });
	// Read met 30 min on 1 of the 29 days before today
	await expect(list.getByRole('option').filter({ hasText: 'Read' })).toContainText('3 % · last 30 days');
	// Run: 8 weeks since its start, none with 3 days
	await expect(list.getByRole('option').filter({ hasText: 'Run' })).toContainText('0 % · last 12 weeks');
	await expect(list.getByRole('option').filter({ hasText: 'Stretch' })).toContainText('Archived');
});

test('a habit’s details: tiles, calendar, chart; back with the button or Escape', async ({ page }) => {
	const list = page.getByRole('listbox', { name: 'Habit stats' });
	await list.getByRole('option').filter({ hasText: 'Read' }).click();
	await expect(page.getByRole('heading', { name: 'Read' })).toBeVisible();
	// since 1.10.: 55 days, 1 met; 2 days with entries, 67.5 min in all
	await expect(page.getByText('2 %', { exact: true })).toBeVisible();
	await expect(page.getByText('67.5 min', { exact: true })).toBeVisible();
	await page.locator('[data-date="2026-11-21"]').click();
	await expect(page.getByText(/^Sat .*: 42\.5 min$/)).toBeVisible();
	await expect(page.getByRole('img', { name: /^Totals per week: goal met in 0 of 8 weeks, / })).toBeVisible();
	// screen readers get each month's gist (today is still open)
	await expect(page.getByRole('img', { name: 'November 2026: met on 1 of 24 days' })).toBeAttached();

	// the range: 3 months back from November is still the start in October
	await page.getByRole('button', { name: '3 months' }).click();
	await expect(page.getByText('2 %', { exact: true })).toBeVisible();

	await page.getByRole('button', { name: '‹ Stats' }).click();
	await expect(list).toBeVisible();
	await list.getByRole('option').filter({ hasText: 'Run' }).click();
	await expect(page.getByRole('img', { name: /^Done by weekday: Mon: 0 of \d+ done; / })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(list).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Run' })).toBeHidden();

	// a tab comes back fresh: the list, not the habit opened last
	await list.getByRole('option').filter({ hasText: 'Run' }).click();
	await expect(page.getByRole('heading', { name: 'Run' })).toBeVisible();
	await page.getByRole('button', { name: 'Today', exact: true }).click();
	await page.getByRole('button', { name: 'Stats', exact: true }).click();
	await expect(list).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Run' })).toBeHidden();
});
