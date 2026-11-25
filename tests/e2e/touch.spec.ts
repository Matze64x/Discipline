/** The phone: everything by taps (iPhone project only). */
import { expect, test, type Page } from '@playwright/test';

test.skip(({ hasTouch }) => !hasTouch, 'touch only');

const dayList = (page: Page) => page.getByRole('listbox', { name: 'Habits of the day' });
const dayRow = (page: Page, name: string) => dayList(page).getByRole('option').filter({ has: page.locator('.name').getByText(name, { exact: false }).filter({ hasText: new RegExp(`^${name}( \\((not )?done\\))?$`) }) });
const habitList = (page: Page) => page.getByRole('listbox', { name: 'Habits' });

async function addHabit(page: Page, name: string, amount = false) {
	await page.getByRole('button', { name: 'New' }).tap();
	const dialog = page.getByRole('dialog', { name: 'New habit' });
	await dialog.getByLabel('Name').fill(name);
	if (amount) {
		await dialog.getByText('Amount', { exact: true }).tap();
		await dialog.getByLabel('Goal', { exact: true }).fill('30');
	}
	await dialog.getByRole('button', { name: 'Save' }).tap();
	await expect(dialog).toBeHidden();
}

test('add habits, check off and enter amounts by taps', async ({ page }) => {
	await page.clock.setFixedTime(new Date(2026, 10, 23, 20, 0));
	await page.goto('/');
	await page.getByRole('button', { name: 'Add a habit' }).tap();
	const first = page.getByRole('dialog', { name: 'New habit' });
	await first.getByLabel('Name').fill('Meditate');
	await first.getByRole('button', { name: 'Save' }).tap();
	await addHabit(page, 'Read', true);

	await page.getByRole('button', { name: 'Today' }).tap();
	// a tap on the row checks it off; again: unchecks; a tap on the mark does the same
	await dayRow(page, 'Meditate').getByText('Meditate').tap();
	await expect(dayRow(page, 'Meditate')).toContainText('(done)');
	await dayRow(page, 'Meditate').getByText('Meditate').tap();
	await expect(dayRow(page, 'Meditate')).toContainText('(not done)');
	await dayRow(page, 'Meditate').locator('.mark').tap();
	await expect(dayRow(page, 'Meditate')).toContainText('(done)');

	await dayRow(page, 'Read').getByText('Read').tap();
	let amount = page.getByRole('dialog', { name: /Read/ });
	await amount.getByLabel('Amount').fill('12,5');
	await amount.getByRole('button', { name: 'Save' }).tap();
	await expect(dayRow(page, 'Read')).toContainText('12.5 / 30');
	// 0 clears it
	await dayRow(page, 'Read').locator('.mark').tap();
	amount = page.getByRole('dialog', { name: /Read/ });
	await amount.getByLabel('Amount').fill('0');
	await amount.getByRole('button', { name: 'Save' }).tap();
	await expect(dayRow(page, 'Read')).toContainText('0 / 30');

	// the buttons: +1, add an amount, complete
	await dayRow(page, 'Read').getByRole('button', { name: 'Add 1' }).tap();
	await expect(dayRow(page, 'Read')).toContainText('1 / 30');
	await dayRow(page, 'Read').getByRole('button', { name: 'Add an amount' }).tap();
	amount = page.getByRole('dialog', { name: /Read/ });
	await amount.getByLabel('Add').fill('4');
	await amount.getByRole('button', { name: 'Save' }).tap();
	await expect(dayRow(page, 'Read')).toContainText('5 / 30');
	await dayRow(page, 'Read').getByRole('button', { name: 'Complete' }).tap();
	await expect(dayRow(page, 'Read')).toContainText('30 / 30');

	// the day before (before they started), and back
	await page.getByRole('button', { name: 'The week before' }).tap();
	await expect(dayList(page)).toContainText('Nothing due.');
	await page.locator('main').getByRole('button', { name: 'Today', exact: true }).tap();
	await expect(dayRow(page, 'Meditate')).toContainText('(done)');
});

test('edit, reorder, archive and delete (with undo) by taps', async ({ page }) => {
	await page.clock.setFixedTime(new Date(2026, 10, 23, 20, 0));
	await page.goto('/');
	await page.getByRole('button', { name: 'Habits', exact: true }).tap();
	for (const name of ['A', 'B', 'C']) await addHabit(page, name);
	const names = () => habitList(page).locator('.name').allTextContents();

	// a tap opens the editor; its arrows move the habit
	await habitList(page).getByText('A', { exact: true }).tap();
	const dialog = page.getByRole('dialog', { name: 'Edit habit' });
	await expect(dialog.getByRole('button', { name: 'Move up' })).toBeDisabled();
	await dialog.getByRole('button', { name: 'Move down' }).tap();
	await expect.poll(names).toEqual(['B', 'A', 'C']);
	await dialog.getByLabel('Name').fill('Alpha');
	await dialog.getByRole('button', { name: 'Save' }).tap();
	await expect.poll(names).toEqual(['B', 'Alpha', 'C']);

	await habitList(page).getByText('C', { exact: true }).tap();
	await dialog.getByRole('button', { name: 'Archive' }).tap();
	await expect(habitList(page).getByRole('option').filter({ has: page.locator('.name').getByText('C', { exact: true }) })).toContainText('Archived');

	await habitList(page).getByText('B', { exact: true }).tap();
	await dialog.getByRole('button', { name: 'Delete' }).tap();
	await expect.poll(names).toEqual(['Alpha', 'C']);
	await page.getByRole('button', { name: /^Undo/ }).tap();
	await expect.poll(names).toEqual(['B', 'Alpha', 'C']);
});
