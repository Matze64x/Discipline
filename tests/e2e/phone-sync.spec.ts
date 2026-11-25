/**
 * The phone side end to end, over a real WebRTC connection: the desktop app's endpoint runs as a
 * test program (`src-tauri/examples/sync_endpoint.rs`, built with `cargo build --example
 * sync_endpoint`), the PC's side of the sync runs here in the test (`core/peer-sync.ts` is plain
 * TypeScript), and the browser is the phone: it pairs through Settings and syncs.
 * Firefox on the host only (`npm run test:phone-sync`): the other tests run in Docker, where the
 * endpoint program can't run. Skipped if the program isn't built (e.g. in CI, which doesn't build
 * the desktop app).
 */
import { expect, test, type Page } from '@playwright/test';
import { waitForApp } from './app';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { addHabit, parseDiscipline, PeerSession, type DisciplineData, type CivilDate, type HabitDraft, type StoredBase, type SyncMessage, type UtcSeconds } from '../../src/core';
const habits = (page: Page) => page.getByRole('listbox', { name: 'Habits', exact: true }).getByRole('option');

/** A habit added by another device (core edit, as that device would) */
const draft = (name: string): HabitDraft => ({ name, kind: 'check', unit: '', color: '#3a86ff', start: '2026-11-01' as CivilDate, goal: { period: 'day', days: [1, 2, 3, 4, 5, 6, 7], aim: 'build', target: 1 } });

const ENDPOINT = fileURLToPath(new URL('../../src-tauri/target/debug/examples/sync_endpoint', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../fixtures/example.json', import.meta.url));

/** The PC: the endpoint program plus the sync's PC side with an in-memory store */
class Pc {
	readonly process: ChildProcessWithoutNullStreams;
	readonly code: Promise<string>;
	working: DisciplineData;
	readonly bases = new Map<string, StoredBase>();
	readonly sessions = new Map<number, PeerSession>();
	readonly paired: string[] = [];
	readonly errors: string[] = [];
	readonly dir = mkdtempSync(join(tmpdir(), 'discipline-e2e-'));
	/** The PC's device id, from its pairing code */
	pcId = '';

	constructor(data: DisciplineData) {
		this.working = data;
		this.process = spawn(ENDPOINT, [this.dir]);
		const lines = createInterface({ input: this.process.stdout });
		let first: (line: string) => void;
		this.code = new Promise((resolve) => (first = resolve));
		let gotCode = false;
		lines.on('line', (line) => {
			if (!gotCode) {
				gotCode = true;
				this.pcId = line.split('|')[7]!;
				return first(line);
			}
			const event = JSON.parse(line) as { event: string; conn: number; phoneId: string; phoneName: string; text: string };
			if (event.event === 'paired') this.paired.push(event.phoneName);
			if (event.event === 'connected') this.#connected(event.conn, event.phoneId);
			if (event.event === 'message') this.sessions.get(event.conn)?.receive(JSON.parse(event.text) as SyncMessage);
			if (event.event === 'closed') this.sessions.delete(event.conn);
		});
	}

	#connected(conn: number, phoneId: string) {
		const store = {
			current: () => this.working,
			transact: async <T,>(peer: string, change: (w: DisciplineData, b: StoredBase | null) => { working: DisciplineData; base: StoredBase | null; value: T }) => {
				const before = this.working;
				const r = change(this.working, this.bases.get(peer) ?? null);
				this.working = r.working;
				if (r.base) this.bases.set(peer, r.base);
				if (r.working !== before) for (const [c, s] of this.sessions) if (c !== conn) s.localChanged();
				return r.value;
			},
		};
		const session = new PeerSession({
			self: { id: this.pcId, name: 'Test PC', kind: 'pc' },
			merger: true,
			store,
			peerId: phoneId,
			send: (message) => this.process.stdin.write(`${JSON.stringify({ cmd: 'send', conn, text: JSON.stringify(message) })}\n`),
			onFailed: (e) => this.errors.push(e.message),
		});
		this.sessions.set(conn, session);
		session.start();
	}

	/** An edit on the PC: passed on to connected phones */
	edit(change: (data: DisciplineData) => DisciplineData) {
		this.working = change(this.working);
		for (const s of this.sessions.values()) s.localChanged();
	}

	stop() {
		this.process.kill();
		rmSync(this.dir, { recursive: true, force: true });
	}
}

test.skip(({ browserName }) => browserName !== 'firefox' || Boolean(process.env['DISCIPLINE_IN_CONTAINER']), 'the endpoint program runs on the host only (npm run test:phone-sync)');
test.skip(() => !existsSync(ENDPOINT), 'the endpoint program isn’t built (cargo build --example sync_endpoint)');

test('a phone pairs with a PC by its code, syncs both ways, and reconnects by itself after a restart', async ({ page }) => {
	const parsed = parseDiscipline(readFileSync(FIXTURE, 'utf8'));
	if (!parsed.ok) throw new Error('fixture');
	const pc = new Pc(parsed.data);
	try {
		const code = await pc.code;

		await page.goto('/');
		await waitForApp(page);
		await page.getByRole('button', { name: 'Habits', exact: true }).click();
		await expect(habits(page)).toHaveCount(0);
		// networking is off at every start
		const syncSwitch = page.getByRole('switch', { name: 'Sync' });
		const syncState = page.locator('header .sync');
		const dialog = page.getByRole('dialog', { name: 'Settings' });
		await expect(syncState).toHaveText('Sync off');
		await page.getByRole('button', { name: 'Settings' }).click();
		await expect(dialog.getByRole('button', { name: 'Pair with a PC' })).toBeDisabled();
		await dialog.getByRole('button', { name: 'Done' }).click();
		await syncSwitch.check();
		await expect(syncState).toHaveText('Not paired');
		await page.getByRole('button', { name: 'Settings' }).click();
		await expect(dialog).toContainText('No PCs paired.');
		await dialog.getByText('Enter the code instead').click();
		await dialog.getByLabel('Pairing code').fill(code);
		await dialog.getByRole('button', { name: 'Pair', exact: true }).click();
		await expect(dialog.getByRole('status').or(dialog.getByRole('alert'))).toContainText('Paired with Test PC', { timeout: 20_000 });
		await expect(dialog.getByText('connected', { exact: true })).toBeVisible();
		await dialog.getByRole('button', { name: 'Done' }).click();

		// the PC's data arrives
		await expect(habits(page)).toHaveCount(3);
		await expect(syncState).toHaveText('1 connected');
		expect(pc.paired).toHaveLength(1);

		// a new habit on the phone reaches the PC
		await page.keyboard.press('n');
		await page.keyboard.type('Added on the phone');
		await page.keyboard.press('Enter');
		await expect.poll(() => pc.working.habits.some((h) => h.name === 'Added on the phone')).toBe(true);

		// one on the PC reaches the phone
		pc.edit((d) => addHabit(d, draft('Added on the PC'), 2_000_000_000 as UtcSeconds).data);
		await expect(habits(page)).toHaveCount(5);

		// after a restart syncing is off; turned on, the phone reconnects with its token, and syncs
		await page.reload();
		await page.getByRole('button', { name: 'Habits', exact: true }).click();
		await expect(syncState).toHaveText('Sync off');
		await syncSwitch.check();
		await expect(syncState).toHaveText('1 connected', { timeout: 15_000 });
		pc.edit((d) => addHabit(d, draft('Added while the phone restarted'), 2_000_000_001 as UtcSeconds).data);
		await expect(habits(page)).toHaveCount(6);
		expect(pc.paired).toHaveLength(1);

		// turned off: the connection ends, and the phone stays off
		await syncSwitch.uncheck();
		await expect.poll(() => pc.sessions.size).toBe(0);
		await expect(syncState).toHaveText('Sync off');
		await page.waitForTimeout(1500);
		expect(pc.sessions.size).toBe(0);
		expect(pc.errors).toEqual([]);
	} finally {
		pc.stop();
	}
});
