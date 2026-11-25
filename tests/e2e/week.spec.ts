/** The week view: a grid of habits and days, by keyboard, mouse and touch. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { waitForApp } from './app';

/** Today is Wednesday, 25.11.2026, 20:00; weeks start on Monday */
async function open(page: Page) {
	await page.clock.setFixedTime(new Date(2026, 10, 25, 20, 0));
	await page.goto('/');
	await waitForApp(page);
}

async function addHabit(page: Page, name: string, fill?: (dialog: Locator) => Promise<void>) {
	await page.getByRole('button', { name: 'Habits', exact: true }).click();
	await page.getByRole('button', { name: 'New', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'New habit' });
	await dialog.getByLabel('Name').fill(name);
	await dialog.getByLabel('Starts').fill('02.11.2026');
	await fill?.(dialog);
	await dialog.getByRole('button', { name: 'Save' }).click();
	await expect(dialog).toBeHidden();
}

const grid = (page: Page) => page.getByRole('grid', { name: 'Week' });
const row = (page: Page, name: string) => grid(page).getByRole('row').filter({ has: page.getByRole('rowheader').getByText(name, { exact: true }) });
/** A habit's day, by weekday and date as its label says, e.g. ('Read', 'Mon 23.11.2026') */
const cell = (page: Page, name: string, day: string) => row(page, name).getByRole('gridcell', { name: new RegExp(`^${name}, ${day}:`) });

async function setup(page: Page) {
	await open(page);
	await addHabit(page, 'Meditate');
	await addHabit(page, 'Read', async (dialog) => {
		await dialog.getByText('Amount', { exact: true }).click();
		await dialog.getByLabel('Goal', { exact: true }).fill('30');
		await dialog.getByLabel('Unit').fill('min');
	});
	await page.getByRole('button', { name: 'Week', exact: true }).click();
}

test.describe('keyboard and mouse', () => {
	test.skip(({ hasTouch }) => hasTouch === true, 'touch: below');

	test('fill in the week by keyboard, and go back a week', async ({ page }) => {
		await setup(page);
		await expect(grid(page)).toBeFocused();
		await expect(page.getByRole('heading', { name: /This week/ })).toContainText('23.11.2026 – 29.11.2026');
		// today (Wed) of the first habit is selected: check it off, then Mon and Tue
		await page.keyboard.press(' ');
		await expect(cell(page, 'Meditate', 'Wed 25.11.2026')).toHaveAccessibleName(/: done$/);
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('Enter');
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press(' ');
		await expect(row(page, 'Meditate')).toContainText('3 of 7 days');
		// days ahead can't be selected or entered: the selection stays on today
		await page.keyboard.press('End');
		await page.keyboard.press('ArrowRight');
		await expect(cell(page, 'Meditate', 'Wed 25.11.2026')).toHaveAttribute('aria-selected', 'true');
		await expect(cell(page, 'Meditate', 'Thu 26.11.2026')).toHaveAccessibleName(/still to come$/);
		await page.keyboard.press(' ');
		await page.keyboard.press(' ');
		await expect(row(page, 'Meditate')).toContainText('3 of 7 days');

		// an amount: typed, then +1 and completed
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('2');
		const amount = page.getByRole('dialog', { name: /Read/ });
		await page.keyboard.type('0');
		await page.keyboard.press('Enter');
		await expect(amount).toBeHidden();
		await expect(cell(page, 'Read', 'Wed 25.11.2026')).toHaveAccessibleName(/: 20 min$/);
		await page.keyboard.press('+');
		await expect(cell(page, 'Read', 'Wed 25.11.2026')).toHaveAccessibleName(/: 21 min$/);
		await page.keyboard.press('c');
		await expect(cell(page, 'Read', 'Wed 25.11.2026')).toHaveAccessibleName(/: 30 min$/);
		await expect(row(page, 'Read')).toContainText('1 of 7 days');

		// past the week's start: the week before (same habit)
		await page.keyboard.press('Home');
		await page.keyboard.press('ArrowLeft');
		await expect(page.getByRole('heading', { name: /Last week/ })).toContainText('16.11.2026 – 22.11.2026');
		await page.keyboard.press(' ');
		await expect(cell(page, 'Read', 'Sun 22.11.2026')).toHaveAccessibleName(/: nothing$/);
		await expect(page.getByRole('dialog', { name: /Read/ })).toBeVisible();
		await page.keyboard.press('Escape');
		await page.keyboard.press('PageUp');
		await expect(page.getByRole('heading', { name: '09.11.2026 – 15.11.2026' })).toBeVisible();
		await page.keyboard.press('t');
		await expect(page.getByRole('heading', { name: /This week/ })).toBeVisible();
		// Delete clears; Ctrl+Z brings it back
		await page.keyboard.press('Delete');
		await expect(cell(page, 'Read', 'Wed 25.11.2026')).toHaveAccessibleName(/: nothing$/);
		await page.keyboard.press('Control+z');
		await expect(cell(page, 'Read', 'Wed 25.11.2026')).toHaveAccessibleName(/: 30 min$/);
	});

	test('a click on a day checks it off; the keys keep acting on the grid', async ({ page }) => {
		await setup(page);
		await cell(page, 'Meditate', 'Mon 23.11.2026').click();
		await expect(cell(page, 'Meditate', 'Mon 23.11.2026')).toHaveAccessibleName(/: done$/);
		await expect(grid(page)).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press(' ');
		await expect(cell(page, 'Meditate', 'Tue 24.11.2026')).toHaveAccessibleName(/: done$/);
		await page.getByRole('button', { name: 'The week before' }).click();
		await expect(page.getByRole('heading', { name: /Last week/ })).toBeVisible();
		await expect(grid(page)).toBeFocused();
	});

	test('weekly and monthly goals say how the week went; an empty week keeps the focus', async ({ page }) => {
		await open(page);
		await addHabit(page, 'Run', async (dialog) => {
			await dialog.getByText('Weekly', { exact: true }).click();
			await dialog.getByLabel('Days per week').fill('3');
		});
		await addHabit(page, 'Hike', async (dialog) => {
			await dialog.getByText('Amount', { exact: true }).click();
			await dialog.getByLabel('Goal', { exact: true }).fill('100');
			await dialog.getByLabel('Unit').fill('km');
			await dialog.getByText('Monthly', { exact: true }).click();
		});
		await page.getByRole('button', { name: 'Week', exact: true }).click();
		await cell(page, 'Run', 'Mon 23.11.2026').click();
		await cell(page, 'Hike', 'Tue 24.11.2026').click();
		await page.getByRole('dialog', { name: /Hike/ }).getByLabel('Amount').fill('12.5');
		await page.keyboard.press('Enter');
		await expect(row(page, 'Run')).toContainText('1 of 3 this week');
		// (a monthly goal: what this week brought, not the month so far)
		await expect(row(page, 'Hike')).toContainText('12.5 km this week');
		// the week before they started: nothing to show, and the keys still work
		for (let i = 0; i < 4; i++) await page.keyboard.press('PageUp');
		await expect(grid(page)).toContainText('No habits this week.');
		await expect(grid(page)).toBeFocused();
		await page.keyboard.press('t');
		await expect(page.getByRole('heading', { name: /This week/ })).toBeVisible();
	});

	test('an archived habit shows until its last day', async ({ page }) => {
		await setup(page);
		await page.getByRole('button', { name: 'Habits', exact: true }).click();
		const habits = page.getByRole('listbox', { name: 'Habits', exact: true });
		await habits.getByText('Meditate', { exact: true }).click();
		await page.keyboard.press('a');
		await expect(habits).toContainText('Archived');
		await page.getByRole('button', { name: 'Week', exact: true }).click();
		// archived from tomorrow: still in this week; today still counts
		await expect(cell(page, 'Meditate', 'Wed 25.11.2026')).toHaveAccessibleName(/: not done$/);
		await expect(row(page, 'Meditate')).toContainText('0 of 3 days');
	});

	test('the week follows the week start setting', async ({ page }) => {
		await setup(page);
		await page.getByRole('button', { name: 'Settings' }).click();
		await page.getByRole('dialog', { name: 'Settings' }).getByLabel('Week starts on').selectOption('Sunday');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('heading', { name: /This week/ })).toContainText('22.11.2026 – 28.11.2026');
		await expect(grid(page).getByRole('columnheader').nth(1)).toContainText('Sun');
	});
});

test('touch: a tap checks off a day or opens its amount', async ({ page, hasTouch }) => {
	test.skip(!hasTouch, 'touch only');
	await setup(page);
	await cell(page, 'Meditate', 'Tue 24.11.2026').tap();
	await expect(cell(page, 'Meditate', 'Tue 24.11.2026')).toHaveAccessibleName(/: done$/);
	await cell(page, 'Read', 'Mon 23.11.2026').tap();
	const amount = page.getByRole('dialog', { name: /Read/ });
	await amount.getByLabel('Amount').fill('45');
	await amount.getByRole('button', { name: 'Save' }).tap();
	await expect(cell(page, 'Read', 'Mon 23.11.2026')).toHaveAccessibleName(/: 45 min$/);
	await page.getByRole('button', { name: 'The week before' }).tap();
	await expect(page.getByRole('heading', { name: /Last week/ })).toBeVisible();
});
