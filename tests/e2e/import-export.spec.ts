import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../fixtures/example.json', import.meta.url));
const fixtureText = () => readFileSync(FIXTURE, 'utf8');

async function importFile(page: Page, path: string) {
	// shortcuts and buttons work only once the data is loaded
	await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await (await chooser).setFiles(path);
}

test('import, persist, export and undo', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByText('No habits yet')).toBeVisible();

	await importFile(page, FIXTURE);
	const dialog = page.getByRole('dialog', { name: 'Import “example.json”' });
	await expect(dialog).toContainText('Habits: 3 added');
	await expect(dialog).toContainText('Entries: 5 added');
	await dialog.getByRole('button', { name: 'Import' }).click();
	await expect(page.getByText('3 habits')).toBeVisible();

	// the working copy survives a reload
	await page.reload();
	await expect(page.getByText('3 habits')).toBeVisible();
	await expect(page.getByText('example.json')).toBeVisible();

	// importing the same file again changes nothing
	await importFile(page, FIXTURE);
	await expect(dialog).toContainText('Nothing new');
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toBeHidden();

	// export gives back exactly the imported file
	if (!test.info().project.use.hasTouch) {
		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Export' }).click();
		const file = await download;
		expect(file.suggestedFilename()).toBe('example.json');
		expect(readFileSync(await file.path(), 'utf8')).toBe(fixtureText());
	}

	// undo restores the empty state, also after a reload
	await page.getByRole('button', { name: 'Undo import' }).click();
	await expect(page.getByText('No habits yet')).toBeVisible();
	await page.reload();
	await expect(page.getByText('No habits yet')).toBeVisible();
	await expect(page.getByText('example.json')).toBeHidden();
	await expect(page.getByRole('button', { name: 'Undo import' })).toBeHidden();
});

test('on touch screens, export hands the file to the share sheet', async ({ page }) => {
	await page.addInitScript(() => {
		const original = window.matchMedia.bind(window);
		window.matchMedia = (query: string) => (query === '(pointer: coarse)' ? ({ matches: true } as MediaQueryList) : original(query));
		Object.assign(navigator, {
			canShare: () => true,
			share: async ({ files }: { files: File[] }) => {
				const file = files[0]!;
				(window as unknown as { shared: unknown }).shared = { name: file.name, text: await file.text() };
			},
		});
	});
	await page.goto('/');
	await importFile(page, FIXTURE);
	await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
	await page.getByRole('button', { name: 'Export' }).click();
	await expect(page.getByRole('status')).toContainText('Exported');
	const shared = await page.evaluate(() => (window as unknown as { shared: { name: string; text: string } }).shared);
	expect(shared).toEqual({ name: 'example.json', text: fixtureText() });
});

test('if saving fails, nothing changes and the error is shown', async ({ page }) => {
	await page.addInitScript(() => {
		IDBObjectStore.prototype.put = () => {
			throw new DOMException('The disk is full', 'QuotaExceededError');
		};
	});
	await page.goto('/');
	await importFile(page, FIXTURE);
	await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
	await expect(page.getByRole('alert').filter({ hasText: 'Something went wrong' })).toContainText('The disk is full');
	await expect(page.getByText('No habits yet')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Undo import' })).toBeHidden();
});

test('a broken file is refused with the reason', async ({ page }, testInfo) => {
	await page.goto('/');
	const broken = testInfo.outputPath('broken.json');
	writeFileSync(broken, fixtureText().replace('"value": 42.5', '"value": -1'));
	await importFile(page, broken);
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText("can't be imported");
	await expect(dialog).toContainText('entries[2].value');
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(page.getByText('No habits yet')).toBeVisible();
});

test('another tab sees the import', async ({ page, context }) => {
	await page.goto('/');
	const other = await context.newPage();
	await other.goto('/');
	await expect(other.getByText('No habits yet')).toBeVisible();
	await importFile(page, FIXTURE);
	await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
	await expect(other.getByText('3 habits')).toBeVisible();
});
