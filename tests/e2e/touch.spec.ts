/** The phone: everything by taps (iPhone project only). */
import { expect, test, type Page } from '@playwright/test';

test.skip(({ hasTouch }) => !hasTouch, 'touch only');

const dayList = (page: Page) => page.getByRole('listbox', { name: 'Habits of the day' });
const dayRow = (page: Page, name: string) => dayList(page).getByRole('option').filter({ has: page.locator('.name').getByText(name, { exact: false }).filter({ hasText: new RegExp(`^${name}( \\((not )?done\\))?( \\(its days shown above\\))?$`) }) });
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
	// a tap on the mark checks it off; again: unchecks
	await dayRow(page, 'Meditate').locator('.mark').tap();
	await expect(dayRow(page, 'Meditate')).toContainText('(done)');
	await dayRow(page, 'Meditate').locator('.mark').tap();
	await expect(dayRow(page, 'Meditate')).toContainText('(not done)');
	await dayRow(page, 'Meditate').locator('.mark').tap();
	await expect(dayRow(page, 'Meditate')).toContainText('(done)');

	// a tap on the row only focuses the habit: the days above show it alone; again: all habits
	const monday = page.getByRole('group', { name: 'Days' }).getByRole('button', { name: /^Mon 23\.11\./ });
	await expect(monday).toHaveAccessibleName('Mon 23.11., 1 of 2 done');
	await dayRow(page, 'Read').getByText('Read').tap();
	await expect(page.getByRole('dialog')).toBeHidden();
	await expect(dayRow(page, 'Read')).toContainText('(its days shown above)');
	await expect(monday).toHaveAccessibleName('Mon 23.11., 0');
	await dayRow(page, 'Read').getByText('Read').tap();
	await expect(dayRow(page, 'Read')).not.toContainText('(its days shown above)');
	await expect(monday).toHaveAccessibleName('Mon 23.11., 1 of 2 done');

	await dayRow(page, 'Read').locator('.mark').tap();
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
	// a tapped button doesn't stay lit up (phones keep it "hovered" until the next tap elsewhere)
	const addOne = dayRow(page, 'Read').getByRole('button', { name: 'Add 1' });
	const border = () => addOne.evaluate((b) => getComputedStyle(b).borderColor);
	const accent = await page.evaluate(() => {
		const probe = document.body.appendChild(document.createElement('div'));
		probe.style.borderColor = 'var(--accent)';
		probe.style.borderStyle = 'solid';
		const color = getComputedStyle(probe).borderColor;
		probe.remove();
		return color;
	});
	expect(await border()).not.toBe(accent);
	await dayRow(page, 'Read').getByRole('button', { name: 'Add an amount' }).tap();
	amount = page.getByRole('dialog', { name: /Read/ });
	await amount.getByLabel('Add').fill('4');
	await amount.getByRole('button', { name: 'Save' }).tap();
	await expect(dayRow(page, 'Read')).toContainText('5 / 30');
	await dayRow(page, 'Read').locator('.mark').tap();
	await page.getByRole('dialog', { name: /Read/ }).getByRole('button', { name: 'Complete +25' }).tap();
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

	// Reorder: arrows on every row, the order changes in place; a tap opens nothing meanwhile
	await page.getByRole('button', { name: 'Reorder' }).tap();
	await expect(page.getByRole('button', { name: 'Move “A” up' })).toBeDisabled();
	await page.getByRole('button', { name: 'Move “A” down' }).tap();
	await expect.poll(names).toEqual(['B', 'A', 'C']);
	await page.getByRole('button', { name: 'Move “C” up' }).tap();
	await expect.poll(names).toEqual(['B', 'C', 'A']);
	await habitList(page).getByText('A', { exact: true }).tap();
	await expect(page.getByRole('dialog')).toBeHidden();
	await page.getByRole('button', { name: 'Move “C” down' }).tap();
	await page.getByRole('button', { name: 'Done' }).tap();
	await expect(page.getByRole('button', { name: 'Move “A” up' })).toBeHidden();
	await expect.poll(names).toEqual(['B', 'A', 'C']);

	// a tap opens the editor
	await habitList(page).getByText('A', { exact: true }).tap();
	const dialog = page.getByRole('dialog', { name: 'Edit habit' });
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

/** A finger moving sideways over Today's calendar by `dx` pixels */
async function swipeCalendar(page: Page, dx: number, thenClick = true) {
	await page.locator('.calendar').evaluate((node, [dx, thenClick]) => {
		const box = node.getBoundingClientRect();
		const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
		const event = (type: string, clientX: number) => new PointerEvent(type, { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX, clientY: y, bubbles: true });
		const target = node.querySelector('[role=group] button') ?? node;
		target.dispatchEvent(event('pointerdown', x));
		target.dispatchEvent(event('pointermove', x + dx / 2));
		target.dispatchEvent(event('pointerup', x + dx));
		// what a browser may send after the finger lifts: not a tap on the day
		if (thenClick) target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	}, [dx, thenClick] as const);
}

test('swiping the calendar pages by week or month, never past today', async ({ page }) => {
	await page.clock.setFixedTime(new Date(2026, 10, 25, 20, 0));
	await page.goto('/');
	const heading = page.locator('.calendar h2');
	await expect(heading).toHaveText('23.11. – 29.11.');
	await swipeCalendar(page, 120);
	await expect(heading).toHaveText('16.11. – 22.11.');
	// the click after the swipe didn't pick a day: still the same weekday, one week back
	await expect(page.getByRole('group', { name: 'Days' }).getByRole('button', { pressed: true })).toHaveAccessibleName(/^Wed 18\.11\./);
	await swipeCalendar(page, -120);
	await expect(heading).toHaveText('23.11. – 29.11.');
	await swipeCalendar(page, -120);
	await expect(heading).toHaveText('23.11. – 29.11.');
	// while the finger moves, only the days follow it, not the buttons above them
	const moved = await page.locator('.calendar').evaluate((node) => {
		const days = node.querySelector('[role=group]')!;
		const box = days.getBoundingClientRect();
		const event = (type: string, clientX: number) => new PointerEvent(type, { pointerType: 'touch', pointerId: 8, isPrimary: true, clientX, clientY: box.top + 10, bubbles: true });
		days.dispatchEvent(event('pointerdown', box.left + 100));
		days.dispatchEvent(event('pointermove', box.left + 160));
		const result = { days: getComputedStyle(days).transform, calendar: getComputedStyle(node).transform };
		days.dispatchEvent(event('pointercancel', box.left + 160));
		return result;
	});
	expect(moved.days).not.toBe('none');
	expect(moved.calendar).toBe('none');
	// too short: nothing
	await swipeCalendar(page, 30);
	await expect(heading).toHaveText('23.11. – 29.11.');

	// a swipe the browser sent no click after: a later click (mouse, keyboard) is still a click
	await swipeCalendar(page, 120, false);
	await expect(heading).toHaveText('16.11. – 22.11.');
	await page.waitForTimeout(500);
	await page.locator('.calendar').getByRole('button', { name: 'Today' }).evaluate((button: HTMLElement) => button.click());
	await expect(heading).toHaveText('23.11. – 29.11.');

	await page.getByRole('button', { name: 'Month' }).tap();
	await expect(heading).toHaveText('Nov 2026');
	await swipeCalendar(page, 120);
	await expect(heading).toHaveText('Oct 2026');
});
