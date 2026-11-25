/** Habits that limit something ("at most"): made in the editor, slips entered on Today, judged in Stats. Taps only (runs on both). */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { waitForApp } from './app';

async function addHabit(page: Page, name: string, fill: (dialog: Locator) => Promise<void>, aim: 'Build' | 'Limit' = 'Limit') {
	await page.getByRole('button', { name: 'Habits', exact: true }).click();
	await page.getByRole('button', { name: 'New', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'New habit' });
	await dialog.getByLabel('Name').fill(name);
	await dialog.getByText(aim, { exact: true }).click();
	await fill(dialog);
	await dialog.getByRole('button', { name: 'Save' }).click();
	await expect(dialog).toBeHidden();
}

const row = (page: Page, name: string) => page.getByRole('listbox', { name: 'Habits of the day' }).getByRole('option').filter({ hasText: name });

test('limits: made in the editor, slips on Today, judged in Stats', async ({ page }) => {
	await page.clock.setFixedTime(new Date(2026, 10, 25, 20, 0));
	await page.goto('/');
	await waitForApp(page);

	await addHabit(page, 'Smoke', async () => {});
	await addHabit(page, 'Coffee', async (dialog) => {
		await dialog.getByText('Amount', { exact: true }).click();
		await dialog.getByLabel('At most', { exact: true }).fill('2');
		await dialog.getByLabel('Unit').fill('cups');
	});
	await addHabit(page, 'Snacks', async (dialog) => {
		await dialog.getByText('Weekly', { exact: true }).click();
		await dialog.getByLabel('Max days per week').fill('0');
	});
	// a goal to build that isn't met yet is no broken limit: never red
	await addHabit(
		page,
		'Run',
		async (dialog) => {
			await dialog.getByText('Weekly', { exact: true }).click();
			await dialog.getByLabel('Days per week').fill('3');
		},
		'Build',
	);
	const habits = page.getByRole('listbox', { name: 'Habits', exact: true });
	await expect(habits.getByRole('option').filter({ hasText: 'Smoke' })).toContainText('never');
	await expect(habits.getByRole('option').filter({ hasText: 'Coffee' })).toContainText('at most 2 cups every day');
	await expect(habits.getByRole('option').filter({ hasText: 'Snacks' })).toContainText('never');

	// Today: kept by doing nothing, so no complete button; a tap enters a slip
	await page.getByRole('button', { name: 'Today', exact: true }).click();
	await expect(row(page, 'Smoke')).toContainText('(kept)');
	await expect(row(page, 'Smoke').getByRole('button', { name: 'Complete' })).toHaveCount(0);
	await row(page, 'Smoke').locator('.mark').click();
	await expect(row(page, 'Smoke')).toContainText('(slipped)');

	await expect(row(page, 'Run').locator('.progress')).toHaveText('0 / 3');
	await expect(row(page, 'Run').locator('.progress')).not.toHaveClass(/over/);
	await expect(row(page, 'Run').locator('.bar')).not.toHaveClass(/over/);

	// within the limit, then over it
	const add1 = row(page, 'Coffee').getByRole('button', { name: 'Add 1' });
	await add1.click();
	await add1.click();
	await expect(row(page, 'Coffee').locator('.progress')).toHaveText('2 / max 2 cups');
	await expect(row(page, 'Coffee').locator('.progress')).not.toHaveClass(/over/);
	await add1.click();
	await expect(row(page, 'Coffee').locator('.progress')).toHaveClass(/over/);

	// Stats: today's broken limits count at once, a kept week only once it's over
	await page.getByRole('button', { name: 'Stats', exact: true }).click();
	const stats = page.getByRole('listbox', { name: 'Habit stats' });
	await expect(stats.getByRole('option').filter({ hasText: 'Smoke' })).toContainText('0 % · last 30 days');
	await expect(stats.getByRole('option').filter({ hasText: 'Coffee' })).toContainText('0 % · last 30 days');
	await expect(stats.getByRole('option').filter({ hasText: 'Snacks' })).toContainText('Nothing to count yet');
	await stats.getByRole('option').filter({ hasText: 'Smoke' }).click();
	await expect(page.getByText('limits kept')).toBeVisible();
	await expect(page.getByText('Slipped by weekday (%)')).toBeVisible();
});
