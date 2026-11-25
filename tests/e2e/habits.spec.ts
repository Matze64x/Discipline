/** Habits and the day view, operated by keyboard (the desktop way) and mouse. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openSettings, waitForApp } from './app';

test.skip(({ hasTouch }) => hasTouch === true, 'keyboard and mouse (touch: touch.spec.ts)');

/** Today is Monday, 23.11.2026, 20:00 (the data persists across reloads) */
async function open(page: Page, date = new Date(2026, 10, 23, 20, 0)) {
	await page.clock.setFixedTime(date);
	await page.goto('/');
	await waitForApp(page);
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
/** The day the habits are shown for (picked above them) */
const shownDay = (page: Page) => page.getByRole('group', { name: 'Days' }).getByRole('button', { pressed: true });
const dayRow = (page: Page, name: string) => dayList(page).getByRole('option').filter({ has: page.locator('.name').getByText(name, { exact: false }).filter({ hasText: new RegExp(`^${name}( \\((not )?done\\))?( \\(its days shown above\\))?$`) }) });

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
	await expect(dayRow(page, 'Run')).toContainText('1 / 3');

	// the day before: the habits started today
	await keys(page, 'ArrowLeft');
	await expect(shownDay(page)).toHaveAccessibleName(/^Sun 22\.11\./);
	await expect(dayList(page)).toContainText('Nothing due.');
	await keys(page, 't');
	await expect(shownDay(page)).toHaveAccessibleName(/^Mon 23\.11\./);

	// undo the last check-off, and Delete clears an amount
	await keys(page, 'Control+z');
	await expect(dayRow(page, 'Run')).toContainText('0 / 3');
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

	await page.getByRole('button', { name: 'The week before' }).click();
	await expect(shownDay(page)).toHaveAccessibleName(/^Mon 16\.11\./);
	await keys(page, ' ');
	// (Space went to the list, not to the button: still that day)
	await expect(shownDay(page)).toHaveAccessibleName(/^Mon 16\.11\./);
	// a day picked above: the keys act on its habits
	await page.getByRole('group', { name: 'Days' }).getByRole('button', { name: /^Tue 17\.11\./ }).click();
	await expect(shownDay(page)).toHaveAccessibleName(/^Tue 17\.11\./);
	await expect(dayList(page)).toBeFocused();
	const today = page.locator('main').getByRole('button', { name: 'Today', exact: true });
	await today.click();
	await expect(shownDay(page)).toHaveAccessibleName(/^Mon 23\.11\./);
	await expect(today).toBeDisabled();
	// Shift+←: the week before, by keyboard
	await keys(page, 'Shift+ArrowLeft');
	await expect(shownDay(page)).toHaveAccessibleName(/^Mon 16\.11\./);
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
	await expect(dialog).toContainText('Day: 2 / 30 min');
	await dialog.getByLabel('Add').fill('10,5');
	await keys(page, 'Enter');
	await expect(dialog).toBeHidden();
	await expect(dayRow(page, 'Read')).toContainText('12.5 / 30 min');
	// complete: in the amount dialog (no button on the row), or c
	await expect(dayRow(page, 'Read').getByRole('button', { name: /Complete/ })).toHaveCount(0);
	await dayRow(page, 'Read').locator('.mark').click();
	await dialog.getByRole('button', { name: 'Complete +17.5 min' }).click();
	await expect(dialog).toBeHidden();
	await expect(dayRow(page, 'Read')).toContainText('30 / 30 min');
	// met: nothing to complete any more
	await keys(page, 'a');
	await expect(dialog.getByRole('button', { name: /Complete/ })).toHaveCount(0);
	await keys(page, 'Escape');
	await keys(page, 'c');
	await dayRow(page, 'Read').getByRole('button', { name: 'Add 1' }).click();
	await expect(dayRow(page, 'Read')).toContainText('31 / 30 min');
	// over the goal: complete never snaps it back
	await keys(page, 'c');
	await expect(dayRow(page, 'Read')).toContainText('31 / 30 min');
	await keys(page, 'Control+z', 'Control+z');
	await expect(dayRow(page, 'Read')).toContainText('12.5 / 30 min');
	// adding, complete adds what's missing too
	await keys(page, 'a');
	await dialog.getByRole('button', { name: 'Complete +17.5 min' }).click();
	await expect(dayRow(page, 'Read')).toContainText('30 / 30 min');
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
	await habitList(page).getByText('Read', { exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Edit habit' });
	await dialog.getByLabel('Goal', { exact: true }).fill('45');
	await expect(dialog).toContainText('The new goal counts from today on.');
	await dialog.getByLabel('Goal', { exact: true }).press('Enter');
	await expect(dialog).toBeHidden();
	await keys(page, 'g', 't');
	await expect(dayRow(page, 'Read')).toContainText('0 / 45');
	await expect(dayRow(page, 'Run')).toContainText('0 / 3');
	await keys(page, 'ArrowLeft');
	await expect(dayRow(page, 'Read')).toContainText('0 / 30');
	await expect(dayRow(page, 'Run')).toContainText('0 / 3');
});

test('reorder, archive and delete (with undo), by clicks', async ({ page }) => {
	await open(page);
	for (const name of ['A', 'B', 'C']) await addHabit(page, name);
	const names = () => habitList(page).locator('.name').allTextContents();
	await page.getByRole('button', { name: 'Reorder' }).click();
	await page.getByRole('button', { name: 'Move “A” down' }).click();
	await expect.poll(names).toEqual(['B', 'A', 'C']);
	await page.getByRole('button', { name: 'Move “A” down' }).click();
	await expect.poll(names).toEqual(['B', 'C', 'A']);
	await page.getByRole('button', { name: 'Move “A” up' }).click();
	await expect.poll(names).toEqual(['B', 'A', 'C']);
	// leaving the tab ends reordering
	await keys(page, 'g', 't', 'g', 'h');
	await expect(page.getByRole('button', { name: 'Reorder' })).toBeVisible();

	// archived: listed last; still counts today, not from tomorrow on
	await habitList(page).getByText('A', { exact: true }).click();
	await page.getByRole('dialog', { name: 'Edit habit' }).getByRole('button', { name: 'Archive' }).click();
	await expect.poll(names).toEqual(['B', 'C', 'A']);
	await expect(habitList(page).getByRole('option').filter({ has: page.locator('.name').getByText('A', { exact: true }) })).toContainText('Archived');
	await keys(page, 'g', 't');
	await expect(dayRow(page, 'A')).toBeVisible();
	await open(page, new Date(2026, 10, 24, 20, 0));
	await expect(dayList(page).getByRole('option')).toHaveCount(2);
	await expect(dayRow(page, 'A')).toHaveCount(0);

	await keys(page, 'g', 'h');
	await habitList(page).getByText('B', { exact: true }).click();
	await page.getByRole('dialog', { name: 'Edit habit' }).getByRole('button', { name: 'Delete' }).click();
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

test('day and week start: part of the data; a device’s old values move over once', async ({ page }) => {
	// before, they were this device's own preferences
	await page.addInitScript(() => {
		if (!sessionStorage.getItem('seeded')) localStorage.setItem('discipline-settings-v1', JSON.stringify({ dateStyle: 'DD.MM.YYYY', dayStart: 240, weekStart: 7 }));
		sessionStorage.setItem('seeded', '1');
	});
	// 02:00 with the day starting at 04:00: still the 23rd
	await open(page, new Date(2026, 10, 24, 2, 0));
	await expect(shownDay(page)).toHaveAccessibleName(/^Mon 23\.11\./);
	const settings = await openSettings(page);
	await expect(settings.getByLabel('New day starts at')).toHaveValue('240');
	await expect(settings.getByLabel('Week starts on')).toHaveValue('7');
	// changed here, it's in the data: it stays after a reload, and the old value doesn't come back
	await settings.getByLabel('New day starts at').selectOption('00:00');
	await page.keyboard.press('Escape');
	await expect(shownDay(page)).toHaveAccessibleName(/^Tue 24\.11\./);
	// Ctrl+Z undoes it like any change
	await keys(page, 'Control+z');
	await expect(shownDay(page)).toHaveAccessibleName(/^Mon 23\.11\./);
	await keys(page, 'Control+Shift+z');
	await expect(shownDay(page)).toHaveAccessibleName(/^Tue 24\.11\./);
	await page.reload();
	await waitForApp(page);
	await expect(shownDay(page)).toHaveAccessibleName(/^Tue 24\.11\./);
	expect(await page.evaluate(() => localStorage.getItem('discipline-settings-v1'))).not.toContain('dayStart');
});

test('the days above: week or month, the week’s dots and the period bars', async ({ page }) => {
	await open(page, new Date(2026, 10, 25, 20, 0));
	await addHabit(page, 'Read', async (dialog) => {
		await dialog.getByText('Amount', { exact: true }).click();
		await dialog.getByLabel('Goal', { exact: true }).fill('30');
		await dialog.getByLabel('Starts').fill('02.11.2026');
	});
	await addHabit(page, 'Run', async (dialog) => {
		await dialog.getByText('Weekly', { exact: true }).click();
		await dialog.getByLabel('Days per week').fill('3');
		await dialog.getByLabel('Starts').fill('02.11.2026');
	});
	await keys(page, 'g', 't');
	const days = page.getByRole('group', { name: 'Days' });
	// Wed 25.11.: Mon met, Tue missed, today and the days after still open
	await days.getByRole('button', { name: /^Mon 23\.11\./ }).click();
	await keys(page, '3', '0', 'Enter');
	await expect(dayRow(page, 'Read')).toContainText('30 / 30');
	await expect(days.getByRole('button', { name: /^Mon 23\.11\./ })).toHaveAccessibleName('Mon 23.11., 1 of 1 done');
	await page.locator('main').getByRole('button', { name: 'Today', exact: true }).click();
	await expect(dayRow(page, 'Read')).toContainText('Week: 1 done, 1 missed.');
	const dots = dayRow(page, 'Read').locator('.dot');
	await expect(dots).toHaveCount(7);
	expect(await dots.evaluateAll((all) => all.map((d) => [...d.classList].filter((c) => ['done', 'missed', 'off', 'open', 'current'].includes(c)).join(' ')))).toEqual([
		'done',
		'missed',
		'open current',
		'open',
		'open',
		'open',
		'open',
	]);
	// a weekly goal: how far the habit is, and how far the week has run (Mon–Wed of 7 days)
	await dayRow(page, 'Run').locator('.mark').click();
	await expect(dayRow(page, 'Run').getByRole('img')).toHaveAccessibleName('33% done, 43% of the week gone');
	await expect(dayRow(page, 'Run')).toContainText('1 / 3');

	// the month: all its days; ‹ › move by a month; Today comes back
	await page.getByRole('button', { name: 'Month' }).click();
	await expect(page.getByRole('heading', { name: 'Nov 2026' })).toBeVisible();
	await expect(days.getByRole('button')).toHaveCount(30);
	await page.getByRole('button', { name: 'The month before' }).click();
	await expect(page.getByRole('heading', { name: 'Oct 2026' })).toBeVisible();
	await expect(days.getByRole('button', { pressed: true })).toHaveAccessibleName(/^Sun 25\.10\./);
	// paging by months comes back to the day picked: 31.10. → 30.09. → 31.10.
	await days.getByRole('button', { name: /^Sat 31\.10\./ }).click();
	await page.getByRole('button', { name: 'The month before' }).click();
	await expect(days.getByRole('button', { pressed: true })).toHaveAccessibleName(/^Wed 30\.09\./);
	await page.getByRole('button', { name: 'The month after' }).click();
	await expect(days.getByRole('button', { pressed: true })).toHaveAccessibleName(/^Sat 31\.10\./);
	const today = page.locator('main').getByRole('button', { name: 'Today', exact: true });
	await today.click();
	await expect(days.getByRole('button', { pressed: true })).toHaveAccessibleName(/^Wed 25\.11\./);
	await expect(today).toBeDisabled();
	// remembered on this device
	await page.reload();
	await waitForApp(page);
	await expect(page.getByRole('heading', { name: 'Nov 2026' })).toBeVisible();
	await keys(page, 'm');
	await expect(page.getByRole('heading', { name: '23.11. – 29.11.' })).toBeVisible();
});

test('a double click is two clicks, never the amount dialog', async ({ page }) => {
	await open(page);
	await addHabit(page, 'Read', async (dialog) => {
		await dialog.getByText('Amount', { exact: true }).click();
		await dialog.getByLabel('Goal', { exact: true }).fill('30');
	});
	await keys(page, 'g', 't');
	// +1 twice in quick succession: 2, and no dialog
	await dayRow(page, 'Read').getByRole('button', { name: 'Add 1' }).dblclick();
	await expect(dayRow(page, 'Read')).toContainText('2 / 30');
	await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the settings close with the × at their top', async ({ page }) => {
	await open(page);
	const settings = await openSettings(page);
	await settings.getByRole('button', { name: 'Close' }).click();
	await expect(settings).toBeHidden();
});

test('a week’s dots stay together, evenly spaced (today’s once jumped to the right on wide screens)', async ({ page }) => {
	// a Wednesday: days before today, today, days to come
	await open(page, new Date(2026, 10, 25, 20, 0));
	await addHabit(page, 'Meditate');
	await keys(page, 'g', 't');
	const lefts = await dayRow(page, 'Meditate').locator('.dot').evaluateAll((dots) => dots.map((d) => d.getBoundingClientRect().left));
	expect(lefts).toHaveLength(7);
	expect(new Set(lefts.slice(1).map((x, i) => Math.round(x - lefts[i]!))).size).toBe(1);

	// f focuses the selected habit (its days above, also on another week and after Today), Escape: all again
	await keys(page, 'f');
	await expect(dayRow(page, 'Meditate')).toContainText('(its days shown above)');
	// the week before it started: no row to tap, so the strip names it, with a way back to all
	await keys(page, 'Shift+ArrowLeft');
	const chip = page.getByRole('button', { name: 'Show all habits’ days, not only “Meditate”’s' });
	await expect(chip).toHaveText('Meditate ×');
	await keys(page, 't');
	await expect(chip).toBeHidden();
	await expect(dayRow(page, 'Meditate')).toContainText('(its days shown above)');
	await keys(page, 'Shift+ArrowLeft');
	await chip.click();
	await expect(chip).toBeHidden();
	await keys(page, 't', 'f');
	await expect(dayRow(page, 'Meditate')).toContainText('(its days shown above)');
	// a click on the row: the same
	await dayRow(page, 'Meditate').locator('.name').click();
	await expect(dayRow(page, 'Meditate')).not.toContainText('(its days shown above)');
	await expect(page.getByRole('dialog')).toBeHidden();
	await keys(page, 'f', 'Escape');
	await expect(dayRow(page, 'Meditate')).not.toContainText('(its days shown above)');

	// a tab comes back fresh: today, all habits
	await keys(page, 'f', 'ArrowLeft');
	await expect(shownDay(page)).toHaveAccessibleName(/^Tue 24\.11\./);
	await keys(page, 'g', 'h', 'g', 't');
	await expect(shownDay(page)).toHaveAccessibleName(/^Wed 25\.11\./);
	await expect(dayRow(page, 'Meditate')).not.toContainText('(its days shown above)');
});
