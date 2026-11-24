/**
 * The sync protocol between devices, with in-memory devices and connections whose messages are
 * delivered in a controlled order (so edits can happen while a round is under way).
 */
import { describe, expect, it } from 'vitest';
import {
	addHabit,
	deleteHabit,
	EMPTY_DATA,
	FORMAT_VERSION,
	hashText,
	PeerSession,
	serializeDiscipline,
	updateHabit,
	type DisciplineData,
	type HabitDraft,
	type CivilDate,
	type DeviceInfo,
	type StoredBase,
	type SyncMessage,
	type SyncReport,
	type SyncStore,
	type UtcSeconds,
} from '../../src/core';
import { canonicalString } from '../../src/core/equal';
import { randomData, randomEdit } from './random-data';

let clock = 1_000_000;
const now = () => clock++ as UtcSeconds;
const draft = (name: string): HabitDraft => ({ name, kind: 'check', unit: '', goal: { period: 'week', target: 3 }, color: '#3a86ff', start: '2026-01-01' as CivilDate });

/** A device: its working copy and a base per peer, changed atomically like the app's storage */
class Device implements SyncStore {
	working: DisciplineData;
	bases = new Map<string, StoredBase>();
	sessions: PeerSession[] = [];
	readonly info: DeviceInfo;
	/** Fails the next `transact` (like a storage error) */
	failNext = false;

	constructor(id: string, kind: 'pc' | 'phone', data: DisciplineData = EMPTY_DATA) {
		this.info = { id, name: id, kind };
		this.working = data;
	}

	current() {
		return this.working;
	}

	async transact<T>(peer: string, change: (working: DisciplineData, base: StoredBase | null) => { working: DisciplineData; base: StoredBase | null; value: T }) {
		await Promise.resolve();
		if (this.failNext) {
			this.failNext = false;
			throw new Error('storage failed');
		}
		const before = this.working;
		const result = change(this.working, this.bases.get(peer) ?? null);
		this.working = result.working;
		if (result.base) this.bases.set(peer, result.base);
		else this.bases.delete(peer);
		// passes a change on to the other connections (as the app's workspace does)
		if (result.working !== before) for (const s of this.sessions) if (s.peer?.id !== peer) s.localChanged();
		return result.value;
	}

	/** A local edit */
	edit(change: (data: DisciplineData) => DisciplineData) {
		const before = this.working;
		this.working = change(this.working);
		if (this.working !== before) for (const s of this.sessions) s.localChanged();
	}

	add(description: string) {
		this.edit((d) => addHabit(d, draft(description), now()).data);
	}

	descriptions() {
		return this.working.habits.map((h) => h.name).sort();
	}
}

/** A connection between two devices; messages wait in queues until delivered */
class Link {
	readonly toA: SyncMessage[] = [];
	readonly toB: SyncMessage[] = [];
	readonly sessionA: PeerSession;
	readonly sessionB: PeerSession;
	readonly reports: SyncReport[] = [];
	readonly errors: Error[] = [];

	constructor(
		readonly a: Device,
		readonly b: Device,
		/** Whether `a` is the merger */
		aMerges: boolean,
	) {
		// (through JSON, like a real transport)
		const copy = (m: SyncMessage) => JSON.parse(JSON.stringify(m)) as SyncMessage;
		this.sessionA = new PeerSession({
			self: a.info,
			merger: aMerges,
			store: a,
			peerId: b.info.id,
			send: (m) => this.toB.push(copy(m)),
			onSynced: (r) => this.reports.push(r),
			onFailed: (e) => this.errors.push(e),
		});
		this.sessionB = new PeerSession({
			self: b.info,
			merger: !aMerges,
			store: b,
			peerId: a.info.id,
			send: (m) => this.toA.push(copy(m)),
			onSynced: (r) => this.reports.push(r),
			onFailed: (e) => this.errors.push(e),
		});
		a.sessions.push(this.sessionA);
		b.sessions.push(this.sessionB);
		this.sessionA.start();
		this.sessionB.start();
	}

	/** Delivers one waiting message (to `a` or `b`), and lets the receiver handle it */
	async step(to: 'a' | 'b'): Promise<boolean> {
		const queue = to === 'a' ? this.toA : this.toB;
		const message = queue.shift();
		if (!message) return false;
		(to === 'a' ? this.sessionA : this.sessionB).receive(message);
		await settle();
		return true;
	}

	pending() {
		return this.toA.length + this.toB.length;
	}

	close() {
		this.sessionA.close();
		this.sessionB.close();
		this.a.sessions = this.a.sessions.filter((s) => s !== this.sessionA);
		this.b.sessions = this.b.sessions.filter((s) => s !== this.sessionB);
	}
}

/** Records the messages sent over a link from now on */
function record(link: Link): { toA: SyncMessage[]; toB: SyncMessage[] } {
	const seen = { toA: [] as SyncMessage[], toB: [] as SyncMessage[] };
	for (const side of ['toA', 'toB'] as const) {
		const queue = link[side];
		const push = queue.push.bind(queue);
		queue.push = (...m: SyncMessage[]) => (seen[side].push(...m), push(...m));
	}
	return seen;
}

/** Lets queued promise work finish */
async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Delivers messages on all links until none are left */
async function run(...links: Link[]) {
	await settle();
	for (let guard = 0; guard < 10_000; guard++) {
		let moved = false;
		for (const link of links) moved = (await link.step('a')) || (await link.step('b')) || moved;
		if (!moved) {
			await settle();
			if (links.every((l) => l.pending() === 0)) return;
		}
	}
	throw new Error('sync did not settle');
}

const same = (...devices: Device[]) => {
	for (const d of devices.slice(1)) expect(canonicalString(d.working)).toBe(canonicalString(devices[0]!.working));
};

describe('two devices', () => {
	it('first sync without a base combines both sides', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		pc.add('on the PC');
		phone.add('on the phone');
		const link = new Link(pc, phone, true);
		await run(link);
		expect(link.errors).toEqual([]);
		expect(phone.descriptions()).toEqual(['on the PC', 'on the phone']);
		same(pc, phone);
		// both keep the same base
		expect(pc.bases.get('phone')!.hash).toBe(phone.bases.get('pc')!.hash);
		expect(pc.bases.get('phone')!.hash).toBe(hashText(serializeDiscipline(pc.working)));
	});

	it('after agreeing, deletions carry over in both directions, and edits on both sides merge', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		for (const d of ['a', 'b', 'c', 'd']) pc.add(d);
		const link = new Link(pc, phone, true);
		await run(link);
		const id = (name: string) => pc.working.habits.find((h) => h.name === name)!.id;

		phone.edit((d) => deleteHabit(d, id('a')));
		pc.edit((d) => deleteHabit(d, id('b')));
		pc.edit((d) => updateHabit(d, id('c'), draft('c changed on the PC'), '2026-01-01' as CivilDate, now()));
		phone.add('e');
		await run(link);
		expect(link.errors).toEqual([]);
		expect(pc.descriptions()).toEqual(['c changed on the PC', 'd', 'e']);
		same(pc, phone);
	});

	it('an edit while a round is under way is merged on top and synced in another round', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		pc.add('first');
		const link = new Link(pc, phone, true);
		await run(link);

		phone.add('sent');
		// the state goes out; before the result comes back, the phone gets another edit
		await link.step('a'); // pc receives state, merges, answers
		phone.add('typed meanwhile');
		await run(link);
		expect(link.errors).toEqual([]);
		expect(pc.descriptions()).toEqual(['first', 'sent', 'typed meanwhile']);
		same(pc, phone);
	});

	it('a change on the merger reaches the client', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		const link = new Link(pc, phone, true);
		await run(link);
		pc.add('new on the PC');
		await run(link);
		expect(phone.descriptions()).toEqual(['new on the PC']);
	});

	it('a client that lost its base merges without deleting anything', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		for (const d of ['a', 'b']) pc.add(d);
		const link = new Link(pc, phone, true);
		await run(link);
		link.close();

		// the PC deletes one; the phone forgets its base (e.g. storage cleared, data restored)
		pc.edit((d) => deleteHabit(d, d.habits.find((h) => h.name === 'a')!.id));
		phone.bases.clear();
		const again = new Link(pc, phone, true);
		await run(again);
		expect(again.errors).toEqual([]);
		// without a common base the deletion can't be told from a new record: kept (errs towards keeping data)
		expect(phone.descriptions()).toEqual(['a', 'b']);
		same(pc, phone);
	});

	it('a result lost on the way: the next round still knows what the merger deleted', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		pc.add('keep');
		pc.add('deleted on the PC');
		const first = new Link(pc, phone, true);
		await run(first);
		first.close();
		pc.edit((d) => deleteHabit(d, d.habits.find((h) => h.name === 'deleted on the PC')!.id));
		phone.add('new on the phone');

		// the connection drops just before the result reaches the phone
		const second = new Link(pc, phone, true);
		await settle();
		for (;;) {
			if (await second.step('a')) continue;
			const next = second.toB[0];
			if (!next) break;
			if (next.type === 'result') break;
			await second.step('b');
		}
		second.close();
		expect(pc.descriptions()).toEqual(['keep', 'new on the phone']);
		expect(phone.descriptions()).toEqual(['deleted on the PC', 'keep', 'new on the phone']);

		const third = new Link(pc, phone, true);
		await run(third);
		expect(third.errors).toEqual([]);
		expect(pc.descriptions()).toEqual(['keep', 'new on the phone']);
		same(pc, phone);
		// the PC keeps just the base the phone named last (the lost one is dropped)
		const named = phone.bases.get('pc')!.hash;
		pc.add('later');
		await run(third);
		expect(pc.bases.get('phone')!.previous?.hash).toBe(named);
		same(pc, phone);
	});

	it('a client whose save of the result failed: the next round still knows what the merger deleted', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		pc.add('keep');
		pc.add('deleted on the PC');
		const first = new Link(pc, phone, true);
		await run(first);
		first.close();
		pc.edit((d) => deleteHabit(d, d.habits.find((h) => h.name === 'deleted on the PC')!.id));

		const second = new Link(pc, phone, true);
		await settle();
		// (the phone's first transact reads its state; the second saves the result)
		await second.step('b'); // hello to the phone: it reads and sends its state
		await second.step('a'); // hello to the PC
		await second.step('a'); // state to the PC: it merges and answers
		phone.failNext = true;
		await second.step('b'); // the result: saving it fails
		expect(second.errors.map((e) => e.message)).toEqual(['storage failed']);
		second.close();

		const third = new Link(pc, phone, true);
		await run(third);
		expect(pc.descriptions()).toEqual(['keep']);
		same(pc, phone);
	});

	it('a closed session saves nothing more', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		phone.add('a');
		const link = new Link(pc, phone, true);
		await settle();
		await link.step('b');
		await link.step('a');
		link.sessionA.close();
		await link.step('a'); // the state reaches the closed PC session
		expect(pc.descriptions()).toEqual([]);
		expect(pc.bases.size).toBe(0);
		expect(link.toB).toEqual([]);
	});

	it('a merger that lost its base asks for the data (resend) instead of guessing', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		pc.add('a');
		const link = new Link(pc, phone, true);
		await run(link);
		link.close();
		pc.bases.clear();
		pc.add('b');
		// the phone is unchanged, so it sends no data; the PC can't know it without the base
		const again = new Link(pc, phone, true);
		const seen = record(again);
		await run(again);
		expect(again.errors).toEqual([]);
		expect(seen.toA.find((m) => m.type === 'state')).toMatchObject({ data: null });
		expect(seen.toB.map((m) => m.type)).toContain('resend');
		expect(phone.descriptions()).toEqual(['a', 'b']);
		same(pc, phone);
	});

	it('nothing to do: an unchanged client sends no data and gets none back', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		pc.add('a');
		const link = new Link(pc, phone, true);
		await run(link);
		link.close();
		const again = new Link(pc, phone, true);
		const seen = record(again);
		await run(again);
		expect(seen.toA.find((m) => m.type === 'state')).toMatchObject({ data: null });
		expect(seen.toB.find((m) => m.type === 'result')).toMatchObject({ data: null });
		expect(seen.toB.map((m) => m.type)).not.toContain('resend');
	});
});

describe('refusals', () => {
	it('another format version: both stop', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		const link = new Link(pc, phone, true);
		link.toA[0] = { type: 'hello', protocol: 1, format: 99, device: phone.info };
		await run(link);
		expect(link.errors.map((e) => e.message)).toEqual([
			'phone uses another data format (99). Update both.',
			`The other device stopped syncing: phone uses another data format (99). Update both.`,
		]);
		expect(FORMAT_VERSION).not.toBe(99);
	});

	it('a device claiming another identity than its key is refused', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		const link = new Link(pc, phone, true);
		link.toA[0] = { type: 'hello', protocol: 1, format: FORMAT_VERSION, device: { id: 'pc2', name: 'pc2', kind: 'pc' } };
		await run(link);
		expect(link.errors[0]?.message).toBe("The other device's identity doesn't match its key.");
	});

	it('invalid data is refused and changes nothing', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		pc.add('a');
		const link = new Link(pc, phone, true);
		await settle();
		// the phone's hello is fine; its state carries broken data
		await link.step('a');
		await link.step('b');
		link.toA.length = 0;
		link.sessionA.receive({ type: 'state', base: null, data: '{"Version": "cgt_0.6.0", "Transactions": [{"ID": "x"}]}' });
		await settle();
		expect(link.errors[0]?.message).toMatch(/invalid data/);
		expect(pc.descriptions()).toEqual(['a']);
	});

	it('a damaged result is refused (hash check)', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		pc.add('a');
		const link = new Link(pc, phone, true);
		await settle();
		await link.step('a'); // pc: phone's hello
		await link.step('b'); // phone: pc's hello → sends state
		await link.step('a'); // pc: state → result
		const result = link.toB.find((m) => m.type === 'result') as SyncMessage & { type: 'result' };
		Object.assign(result, { hash: '0000000000000000' });
		await run(link);
		expect(link.errors[0]?.message).toMatch(/didn't arrive intact/);
		expect(phone.descriptions()).toEqual([]);
	});

	it('a session that receives a hello before it was started introduces itself first', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		pc.add('a');
		const toPc: SyncMessage[] = [];
		const toPhone: SyncMessage[] = [];
		const store = (d: Device) => d;
		const pcSession = new PeerSession({ self: pc.info, merger: true, store: store(pc), peerId: 'phone', send: (m) => toPhone.push(m) });
		const phoneSession = new PeerSession({ self: phone.info, merger: false, store: store(phone), peerId: 'pc', send: (m) => toPc.push(m) });
		pcSession.start();
		// the phone gets the PC's hello before its own start()
		phoneSession.receive(toPhone.shift()!);
		await settle();
		expect(toPc.map((m) => m.type)).toEqual(['hello', 'state']);
		phoneSession.start(); // (no second hello)
		expect(toPc).toHaveLength(2);
	});

	it('messages out of order are refused', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		const link = new Link(pc, phone, true);
		link.sessionB.receive({ type: 'result', hash: 'x', data: null });
		await settle();
		expect(link.errors[0]?.message).toMatch(/did not introduce itself/);
	});

	it('a storage failure stops the session and changes nothing', async () => {
		const pc = new Device('pc', 'pc');
		const phone = new Device('phone', 'phone');
		phone.add('a');
		pc.failNext = true;
		const link = new Link(pc, phone, true);
		await run(link);
		expect(link.errors.map((e) => e.message)[0]).toBe('storage failed');
		expect(pc.descriptions()).toEqual([]);
		expect(pc.bases.size).toBe(0);
	});
});

describe('several devices', () => {
	it('phone → PC → other PC → its phone, and back', async () => {
		const phone1 = new Device('phone1', 'phone');
		const pc1 = new Device('pc1', 'pc');
		const pc2 = new Device('pc2', 'pc');
		const phone2 = new Device('phone2', 'phone');
		const links = [new Link(pc1, phone1, true), new Link(pc1, pc2, true), new Link(pc2, phone2, true)];
		await run(...links);
		phone1.add('from phone 1');
		await run(...links);
		expect(phone2.descriptions()).toEqual(['from phone 1']);
		phone2.edit((d) => deleteHabit(d, d.habits[0]!.id));
		phone2.add('from phone 2');
		await run(...links);
		expect(phone1.descriptions()).toEqual(['from phone 2']);
		same(phone1, pc1, pc2, phone2);
		expect(links.flatMap((l) => l.errors)).toEqual([]);
	});

	it('random edits everywhere, with messages in random order: all devices end up equal', async () => {
		for (let seed = 1; seed <= 40; seed++) {
			let state = seed;
			const random = () => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32);
			const start = randomData(seed);
			const devices = [new Device('pc1', 'pc', start), new Device('pc2', 'pc', start), new Device('phone1', 'phone'), new Device('phone2', 'phone', start)];
			const [pc1, pc2, phone1, phone2] = devices as [Device, Device, Device, Device];
			const links = [new Link(pc1, pc2, true), new Link(pc1, phone1, true), new Link(pc2, phone2, true)];
			for (let i = 0; i < 60; i++) {
				const r = random();
				if (r < 0.15) {
					const d = devices[Math.floor(random() * devices.length)]!;
					d.edit((data) => randomEdit(data, seed * 1000 + i));
				} else {
					const link = links[Math.floor(random() * links.length)]!;
					await link.step(random() < 0.5 ? 'a' : 'b');
				}
			}
			await run(...links);
			expect(links.flatMap((l) => l.errors), `seed ${seed}`).toEqual([]);
			same(...devices);
		}
	});
});
