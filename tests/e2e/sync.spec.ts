/**
 * Syncing two devices with the app's real storage: two browser contexts (each its own IndexedDB,
 * like two devices) whose sync managers are connected through the test runner instead of the
 * network. Uses the dev-only `__disciplineTest` hook (see `App.svelte`).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../fixtures/example.json', import.meta.url));

interface Device {
	page: Page;
	id: string;
	kind: 'pc' | 'phone';
}

async function openDevice(context: BrowserContext, id: string, kind: 'pc' | 'phone'): Promise<Device> {
	const page = await context.newPage();
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Habits', exact: true }).click();
	await expect(habitList(page)).toContainText('No habits yet.');
	return { page, id, kind };
}

/** Bridges already set up (they survive reloads) */
const bridged = new WeakSet<Page>();

/** Connects two devices' sync managers; messages go through the test runner (in order). */
async function connect(a: Device, b: Device) {
	const links: [Device, Device][] = [
		[a, b],
		[b, a],
	];
	for (const [from, to] of links) {
		if (bridged.has(from.page)) continue;
		bridged.add(from.page);
		await from.page.exposeBinding(`__sendTo_${to.id}`, async (_source, text: string) => {
			await to.page.evaluate(([peer, text]) => (window as never as { __receive: Record<string, (t: string) => void> }).__receive[peer]!(text), [from.id, text] as const);
		});
	}
	// a mailbox per connection first: messages arriving before the session is attached wait there
	for (const [self, peer] of links) {
		await self.page.evaluate((peer) => {
			const w = window as never as { __receive?: Record<string, (t: string) => void>; __inbox?: Record<string, string[]> };
			const inbox: string[] = ((w.__inbox ??= {})[peer] = []);
			(w.__receive ??= {})[peer] = (text) => void inbox.push(text);
		}, peer.id);
	}
	for (const [self, peer] of links) {
		await self.page.evaluate(
			({ self, peer }) => {
				const w = window as never as {
					__disciplineTest: { workspace: unknown; SyncManager: new (...args: unknown[]) => { attach(c: unknown, phone: boolean): { receive(t: string): void; closed(): void } }; notices: { info(t: string): void } };
					__receive?: Record<string, (t: string) => void>;
					__inbox?: Record<string, string[]>;
					__managers?: unknown[];
				} & Record<string, (t: string) => Promise<void>>;
				const { workspace, SyncManager, notices } = w.__disciplineTest;
				const manager = new SyncManager(workspace, () => ({ id: self.id, name: self.id, kind: self.kind }), (r: { peer: { name: string } }) =>
					notices.info(`Synced with ${r.peer.name}.`),
				);
				// messages are passed on one after the other, in order
				let chain = Promise.resolve();
				const connection = {
					peerId: peer.id,
					send: (text: string) => void (chain = chain.then(() => w[`__sendTo_${peer.id}`]!(text))),
					close: () => undefined,
				};
				(w.__managers ??= []).push(manager);
				const handlers = manager.attach(connection, peer.kind === 'phone');
				(w.__receive ??= {})[peer.id] = handlers.receive;
				for (const text of w.__inbox![peer.id]!.splice(0)) handlers.receive(text);
			},
			{ self: { id: self.id, kind: self.kind }, peer: { id: peer.id, kind: peer.kind } },
		);
	}
}

async function importFixture(page: Page) {
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await (await chooser).setFiles(FIXTURE);
	await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
	await expect(habits(page)).toHaveCount(3);
}

async function addHabit(page: Page, name: string) {
	await page.keyboard.press('n');
	await page.keyboard.type(name);
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog')).toBeHidden();
}

const habitList = (page: Page) => page.getByRole('listbox', { name: 'Habits', exact: true });
const habits = (page: Page) => habitList(page).getByRole('option');
const dayRow = (page: Page, name: string) =>
	page.getByRole('listbox', { name: 'Habits of the day' }).getByRole('option').filter({ has: page.locator('.name').getByText(name, { exact: false }).filter({ hasText: new RegExp(`^${name}( \\((not )?done\\))?$`) }) });
const habit = (page: Page, name: string) => habits(page).filter({ has: page.locator('.name').getByText(name, { exact: true }) });

test('two devices sync additions, edits and deletions both ways, and keep their base across restarts', async ({ browser }) => {
	const pcContext = await browser.newContext();
	const phoneContext = await browser.newContext();
	const pc = await openDevice(pcContext, 'pc-1', 'pc');
	const phone = await openDevice(phoneContext, 'phone-1', 'phone');

	await importFixture(pc.page);
	await addHabit(phone.page, 'Added on the phone');
	await connect(pc, phone);

	// first sync: both sides combined
	await expect(habits(pc.page)).toHaveCount(4);
	await expect(habits(phone.page)).toHaveCount(4);
	await expect(phone.page.getByRole('status')).toContainText('Synced with pc-1');

	// a check-off on the phone reaches the PC
	await phone.page.getByRole('button', { name: 'Today', exact: true }).click();
	await dayRow(phone.page, 'Added on the phone').locator('.mark').click();
	await pc.page.getByRole('button', { name: 'Today', exact: true }).click();
	await expect(dayRow(pc.page, 'Added on the phone')).toContainText('(done)');
	for (const page of [phone.page, pc.page]) await page.getByRole('button', { name: 'Habits', exact: true }).click();

	// an edit on the phone reaches the PC
	await habit(phone.page, 'Added on the phone').dblclick();
	await phone.page.getByRole('dialog').getByLabel('Name').fill('Renamed on the phone');
	await phone.page.keyboard.press('Enter');
	await expect(habit(pc.page, 'Renamed on the phone')).toBeVisible();

	// a deletion on the PC reaches the phone
	await habit(pc.page, 'Run').click();
	await pc.page.keyboard.press('Delete');
	await expect(habits(pc.page)).toHaveCount(3);
	await expect(habits(phone.page)).toHaveCount(3);
	await expect(habit(phone.page, 'Run')).toHaveCount(0);

	// after a restart (offline meanwhile), a deletion on the phone still carries over: the base was stored
	await phone.page.reload();
	await pc.page.reload();
	for (const page of [phone.page, pc.page]) await page.getByRole('button', { name: 'Habits', exact: true }).click();
	await expect(habits(phone.page)).toHaveCount(3);
	await habit(phone.page, 'Read').click();
	await phone.page.keyboard.press('Delete');
	await expect(habits(phone.page)).toHaveCount(2);
	await addHabit(pc.page, 'Added on the PC while apart');
	await connect(pc, phone);
	await expect(habits(pc.page)).toHaveCount(3);
	await expect(habits(phone.page)).toHaveCount(3);
	await expect(habit(phone.page, 'Added on the PC while apart')).toBeVisible();
	await expect(habit(pc.page, 'Read')).toHaveCount(0);

	await pcContext.close();
	await phoneContext.close();
});
