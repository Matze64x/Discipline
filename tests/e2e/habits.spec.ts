/** Habits and the day view, operated by keyboard (the desktop way) and mouse. */
import { expect, test, type Locator, type Page } from '@playwright/test';

test.skip(({ hasTouch }) => hasTouch === true, 'keyboard and mouse (touch: touch.spec.ts)');

/** Today is Monday, 23.11.2026, 20:00 (the data persists across reloads) */
async function open(page: Page, date = new Date(2026, 10, 23, 20, 0)) {
	await page.clock.setFixedTime(date);
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
}

async function keys(page: Page, ...sequence: string[]) {
	for (const key of sequence) await page.keyboard.press(key);
}

/** Adds a habit through the editor; `fill` sets the fields beyond the name */
async function addHabit(page: Page, name: string, fill?: (dialog: Locator) => Promise<void>) {
	await keys(page, 'g', 'h', 'n');
	const dialog = page.getByRole('dialog', { name: 'New habit' });
	await dialog.getByLabel('Name').fill(name);
	await fill?.(dialog);
	await dialog.getByLabel('Name').press('Enter');
	await expect(dialog).toBeHidden();
}

const dayList = (page: Page) => page.getByRole('listbox', { name: 'Habits of the day' });
const habitList = (page: Page) => page.getByRole('listbox', { name: 'Habits' });
const dayRow = (page: Page, name: string) => dayList(page).getByRole('option').filter({ has: page.locator('.name').getByText(name, { exact: false }).filter({ hasText: new RegExp(`^${name}( \\((not )?done\\))?$`) }) });

test('add habits, check off and enter amounts by keyboard', async ({ page }) => {
	await open(page);
	await expect(page.getByRole('listbox', { name: 'Habits of the day' }).getByText('No habits yet.')).toBeVisible();

	await addHabit(page, 'Meditate');
	await addHabit(page, 'Read', async (dialog) => {
		await dialog.getByText('Amount', { exact: true }).click();
		await dialog.getByLabel('Unit').fill('min');
		await dialog.getByLabel('Goal', { exact: true }).fill('30');
	});
	await addHabit(page, 'Run', async (dialog) => {
		await dialog.getByText('Weekly', { exact: true }).click();
		await dialog.getByLabel('Days per week').fill('3');
	});
	await expect(habitList(page)).toContainText('Meditate');
	await expect(habitList(page)).toContainText('30 min every day');
	await expect(habitList(page)).toContainText('3 times a week');

	// back to today: the list has the focus, the first habit is selected
	await keys(page, 'g', 't');
	await expect(dayList(page)).toBeFocused();
	await keys(page, ' ');
	await expect(dayRow(page, 'Meditate')).toContainText('(done)');

	// typing a number on an amount habit enters it
	await keys(page, 'ArrowDown', '2');
	const amount = page.getByRole('dialog', { name: /Read/ });
	await expect(amount.getByLabel('Amount')).toHaveValue('2');
	await page.keyboard.type('5');
	await keys(page, 'Enter');
	await expect(dayRow(page, 'Read')).toContainText('25 / 30 min');

	await keys(page, 'ArrowDown', 'Enter');
	await expect(dayRow(page, 'Run')).toContainText('1 of 3 this week');

	// the day before: the habits started today
	await keys(page, 'ArrowLeft');
	await expect(page.getByRole('heading', { name: /Yesterday/ })).toBeVisible();
	await expect(dayList(page)).toContainText('Nothing due.');
	await keys(page, 't');
	await expect(page.getByRole('heading', { name: /Today/ })).toBeVisible();

	// undo the last check-off, and Delete clears an amount
	await keys(page, 'Control+z');
	await expect(dayRow(page, 'Run')).toContainText('0 of 3 this week');
	await keys(page, 'ArrowUp', 'Delete');
	await expect(dayRow(page, 'Read')).toContainText('0 / 30 min');

	// e edits the selected habit
	await keys(page, 'e');
	await expect(page.getByRole('dialog', { name: 'Edit habit' }).getByLabel('Name')).toHaveValue('Read');
	await keys(page, 'Escape');

	// all of it survives a reload, and the list has the focus right away
	await page.reload();
	await expect(dayRow(page, 'Meditate')).toContainText('(done)');
	await expect(dayList(page)).toBeFocused();
	await keys(page, 'ArrowDown', ' ');
	await expect(page.getByRole('dialog', { name: /Read/ })).toBeVisible();
});

test('after a click on a mark or a day button, the keys still act on the list', async ({ page }) => {
	await open(page);
	await addHabit(page, 'A');
	await addHabit(page, 'B');
	await keys(page, 'g', 't');
	await dayRow(page, 'A').locator('.mark').click();
	await expect(dayRow(page, 'A')).toContainText('(done)');
	await keys(page, 'j', ' ');
	await expect(dayRow(page, 'B')).toContainText('(done)');
	await expect(dayRow(page, 'A')).toContainText('(done)');

	await page.getByRole('button', { name: 'The day before' }).click();
	await expect(page.getByRole('heading', { name: /Yesterday/ })).toBeVisible();
	await keys(page, ' ');
	// (Space went to the list, not to the button: still yesterday)
	await expect(page.getByRole('heading', { name: /Yesterday/ })).toBeVisible();
});

test('amounts: +1, add an amount and complete, by keys and clicks', async ({ page }) => {
	await open(page);
	await addHabit(page, 'Read', async (dialog) => {
		await dialog.getByText('Amount', { exact: true }).click();
		await dialog.getByLabel('Goal', { exact: true }).fill('30');
		await dialog.getByLabel('Unit').fill('min');
	});
	await keys(page, 'g', 't', '+', '+');
	await expect(dayRow(page, 'Read')).toContainText('2 / 30 min');
	await keys(page, 'a');
	const dialog = page.getByRole('dialog', { name: /Read/ });
	await expect(dialog).toContainText('Now: 2 min');
	await dialog.getByLabel('Add').fill('10,5');
	await keys(page, 'Enter');
	await expect(dialog).toBeHidden();
	await expect(dayRow(page, 'Read')).toContainText('12.5 / 30 min');
	await keys(page, 'c');
	await expect(dayRow(page, 'Read')).toContainText('30 / 30 min');
	// met: complete adds nothing more
	await expect(dayRow(page, 'Read').getByRole('button', { name: 'Complete' })).toBeDisabled();
	await keys(page, 'c');
	await dayRow(page, 'Read').getByRole('button', { name: 'Add 1' }).click();
	await expect(dayRow(page, 'Read')).toContainText('31 / 30 min');
	await keys(page, 'Control+z', 'Control+z');
	await expect(dayRow(page, 'Read')).toContainText('12.5 / 30 min');
	// the list kept the focus through the clicks
	await expect(dayList(page)).toBeFocused();
});

test('a new goal counts from today; earlier days keep theirs, and say so', async ({ page }) => {
	await open(page, new Date(2026, 10, 16, 20, 0));
	await addHabit(page, 'Read', async (dialog) => {
		await dialog.getByText('Amount', { exact: true }).click();
		await dialog.getByLabel('Goal', { exact: true }).fill('30');
	});
	await addHabit(page, 'Run', async (dialog) => {
		await dialog.getByText('Weekly', { exact: true }).click();
		await dialog.getByLabel('Days per week').fill('3');
	});
	// a week later, the goal goes up
	await open(page);
	await keys(page, 'g', 'h');
	await habitList(page).focus();
	await keys(page, 'Home', 'Enter');
	const dialog = page.getByRole('dialog', { name: 'Edit habit' });
	await dialog.getByLabel('Goal', { exact: true }).fill('45');
	await expect(dialog).toContainText('The new goal counts from today on.');
	await dialog.getByLabel('Goal', { exact: true }).press('Enter');
	await expect(dialog).toBeHidden();
	await keys(page, 'g', 't');
	await expect(dayRow(page, 'Read')).toContainText('0 / 45');
	await expect(dayRow(page, 'Run')).toContainText('0 of 3 this week');
	await keys(page, 'ArrowLeft');
	await expect(dayRow(page, 'Read')).toContainText('0 / 30');
	await expect(dayRow(page, 'Run')).toContainText('0 of 3 that week');
});

test('reorder, archive and delete (with undo)', async ({ page }) => {
	await open(page);
	for (const name of ['A', 'B', 'C']) await addHabit(page, name);
	const names = () => habitList(page).locator('.name').allTextContents();
	await habitList(page).focus();
	await keys(page, 'Home', 'Alt+ArrowDown');
	await expect.poll(names).toEqual(['B', 'A', 'C']);
	await keys(page, 'Alt+ArrowDown');
	await expect.poll(names).toEqual(['B', 'C', 'A']);
	await keys(page, 'Alt+ArrowUp');
	await expect.poll(names).toEqual(['B', 'A', 'C']);

	// archived: listed last; still counts today, not from tomorrow on
	await keys(page, 'a');
	await expect.poll(names).toEqual(['B', 'C', 'A']);
	await expect(habitList(page).getByRole('option').filter({ has: page.locator('.name').getByText('A', { exact: true }) })).toContainText('Archived');
	await keys(page, 'g', 't');
	await expect(dayRow(page, 'A')).toBeVisible();
	await open(page, new Date(2026, 10, 24, 20, 0));
	await expect(dayList(page).getByRole('option')).toHaveCount(2);
	await expect(dayRow(page, 'A')).toHaveCount(0);

	await keys(page, 'g', 'h');
	await habitList(page).focus();
	await keys(page, 'Home', 'Delete');
	await expect.poll(names).toEqual(['C', 'A']);
	await page.getByRole('button', { name: /^Undo/ }).click();
	await expect.poll(names).toEqual(['B', 'C', 'A']);
});

test('the editor checks what is entered', async ({ page }) => {
	await open(page);
	await keys(page, 'g', 'h', 'n');
	const dialog = page.getByRole('dialog', { name: 'New habit' });
	await dialog.getByLabel('Name').fill('Run');
	await dialog.getByText('Weekly', { exact: true }).click();
	await dialog.getByLabel('Days per week').fill('8');
	await dialog.getByRole('button', { name: 'Save' }).click();
	await expect(dialog.getByRole('alert')).toHaveText('Enter a whole number of days, at most 7.');
	await dialog.getByText('Daily', { exact: true }).click();
	for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) await dialog.getByRole('button', { name: day }).click();
	await dialog.getByRole('button', { name: 'Save' }).click();
	await expect(dialog.getByRole('alert')).toHaveText('Choose at least one weekday.');
});

test('the shortcut help lists the day keys', async ({ page }) => {
	await open(page);
	await addHabit(page, 'A');
	await keys(page, 'g', 't', '?');
	const help = page.getByRole('dialog');
	await expect(help).toContainText('0–9');
	await expect(help).toContainText('Type an amount');
	await expect(help).toContainText('Check off');
	await expect(help).toContainText('Complete');
});
