<!--
	Settings' Devices section: pairing (a PC shows a QR code, a phone scans it; PCs compare a code),
	the paired devices with whether they're connected, removing one, and this device's name. Turning
	sync on and off is the header's switch (SyncSwitch).
-->
<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { UtcSeconds } from '../../core';
	import { formatDay } from '../display';
	import { errorMessage } from '../errors';
	import { DesktopSync, type PairingQr } from './desktop-sync.svelte';
	import { parsePairingCode } from './pairing-code';
	import type { PhoneSync } from './phone-sync.svelte';
	import QrScanner from './QrScanner.svelte';

	let { sync }: { sync: DesktopSync | PhoneSync } = $props();

	const desktop = $derived(sync instanceof DesktopSync ? sync : null);
	const phone = $derived(sync instanceof DesktopSync ? null : sync);
	const connected = $derived(new Set(sync.manager.connections.map((c) => c.peerId)));
	const enabled = $derived(desktop ? desktop.enabled : (phone?.enabled ?? false));

	// "synced 5 min ago": refreshed now and then while the dialog is open
	let now = $state(Date.now());
	const ticker = setInterval(() => (now = Date.now()), 30_000);
	onDestroy(() => clearInterval(ticker));

	function stateOf(id: string): string {
		if (connected.has(id)) return 'connected';
		const last = sync.manager.lastSynced[id];
		if (last === undefined) return 'not connected';
		const minutes = Math.floor((now - last) / 60_000);
		if (minutes < 1) return 'synced just now';
		if (minutes < 60) return `synced ${minutes} min ago`;
		if (minutes < 24 * 60) return `synced ${Math.floor(minutes / 60)} h ago`;
		return `synced on ${formatDay(Math.floor(last / 1000) as UtcSeconds)}`;
	}

	const savedName = $derived(desktop ? (desktop.info?.name ?? '') : (phone?.device?.name ?? ''));
	let name = $state('');
	let nameShown = false;
	// fills the field once the name is known (the desktop side may still be starting)
	$effect(() => {
		if (savedName && !nameShown) {
			nameShown = true;
			name = savedName;
		}
	});
	/** Changing devices is only possible in the tab that syncs (phones and browsers) */
	const canChange = $derived(desktop !== null || (phone?.canChange ?? false));
	const problems = $derived(sync.manager.problems);
	let message = $state<string | null>(null);
	let failure = $state<string | null>(null);
	/** The device whose removal waits for a second click */
	let confirming = $state<string | null>(null);

	async function act(action: () => Promise<string | null | void>) {
		failure = null;
		message = null;
		try {
			message = (await action()) ?? null;
		} catch (e) {
			failure = errorMessage(e);
		}
	}

	function rename(event: SubmitEvent) {
		event.preventDefault();
		void act(async () => {
			await sync.rename(name);
			return 'Name saved.';
		});
	}

	function remove(id: string, forget: (id: string) => Promise<void> = (id) => sync.forget(id)) {
		if (confirming !== id) return void (confirming = id);
		confirming = null;
		void act(async () => {
			await forget(id);
			return null;
		});
	}

	// ---- PC: pair with another PC
	const unpairedPcs = $derived(desktop ? desktop.found.filter((f) => !desktop.pcs.some((p) => p.id === f.id)) : []);
	const startingWith = $derived(desktop?.pcPairingStarting ?? null);

	function pairPc(id: string) {
		void act(() => desktop!.pairPc(id));
	}

	// other PCs can start pairing with this one while this section is open
	onMount(() => desktop?.setPairingAllowed(true));
	onDestroy(() => {
		if (!desktop) return;
		desktop.setPairingAllowed(false);
		// (closing Settings ends a pairing in progress)
		if (desktop.pcPairing || desktop.pcPairingStarting) void desktop.cancelPcPairing();
		desktop.pcPairingResult = null;
	});

	// ---- PC: show a pairing code
	let qr = $state.raw<PairingQr | null>(null);
	let left = $state(0);
	/** The address the shown code holds */
	let qrAddress: string | null = null;
	// a code with an old address would lead nowhere
	$effect(() => {
		const address = desktop?.info?.address ?? null;
		if (qr && address !== qrAddress) {
			hideCode();
			message = address ? 'The network changed: show a new code.' : null;
		}
	});
	let timer: ReturnType<typeof setInterval> | undefined;

	function showCode() {
		void act(async () => {
			qr = await desktop!.startPairing();
			qrAddress = desktop!.info?.address ?? null;
			left = qr.seconds;
			clearInterval(timer);
			timer = setInterval(() => {
				left -= 1;
				if (left <= 0) hideCode();
			}, 1000);
			desktop!.onPaired = (phoneName) => {
				hideCode();
				message = `Paired with ${phoneName}.`;
			};
			return null;
		});
	}

	function hideCode() {
		clearInterval(timer);
		if (qr) void desktop?.stopPairing();
		qr = null;
		if (desktop) desktop.onPaired = null;
	}

	onDestroy(hideCode);

	// ---- phone: scan a PC's code
	let scanning = $state(false);
	let typed = $state('');
	let pairing = $state(false);

	function pairWith(text: string) {
		const code = parsePairingCode(text);
		if (!code) return void (failure = 'That’s not a Discipline pairing code.');
		scanning = false;
		pairing = true;
		void act(async () => {
			try {
				const pcName = await phone!.pair(code);
				typed = '';
				return `Paired with ${pcName}.`;
			} finally {
				pairing = false;
			}
		});
	}

	const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	const STATUS: Record<string, string> = {
		starting: 'Starting…',
		unpaired: '',
		connecting: 'Connecting…',
		connected: 'Connected.',
		unreachable: 'No paired PC reachable. Is Discipline running on one, on the same network?',
		'other-tab': 'Another tab syncs.',
		off: '',
	};
</script>

<section class="devices" aria-labelledby="devices-heading">
	<h3 id="devices-heading">Devices</h3>
	{#if !enabled}<p class="muted">Turn on sync at the top to pair.</p>{/if}
	{#if desktop}
		{#if desktop.problem}
			<p class="error" role="alert">Syncing can’t start: {desktop.problem}</p>
		{:else if desktop.enabled && desktop.info && !desktop.info.address}
			<p class="muted">Not on a local network.</p>
		{/if}

		<h4>Phones</h4>
		{#if desktop.phones.length === 0}
			<p class="muted">No phones paired.</p>
		{:else}
			<ul>
				{#each desktop.phones as p (p.id)}
					<li>
						<span class="name">{p.name}</span>
						<span class="state" class:on={connected.has(p.id)}>{stateOf(p.id)}</span>
						<button type="button" class:danger={confirming === p.id} onclick={() => remove(p.id)}>{confirming === p.id ? 'Remove for good' : 'Remove'}</button>
						{#if problems[p.id]}<p class="error small problem">{problems[p.id]}</p>{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if qr}
			<div class="qr">
				<!-- (an SVG made by this app's own desktop side) -->
				<div class="code" aria-label="Pairing code">{@html qr.svg}</div>
				<p>Scan it on the phone under Settings → “Pair with a PC”. Valid for {minutes(left)}.</p>
				<details>
					<summary>Can’t scan it?</summary>
					<code class="payload">{qr.payload}</code>
				</details>
				<button type="button" onclick={hideCode}>Stop pairing</button>
			</div>
		{:else}
			<button type="button" class="primary" disabled={!desktop.info?.address} onclick={showCode}>Pair a phone</button>
		{/if}

		<h4>PCs</h4>
		{#if desktop.pcs.length > 0}
			<ul>
				{#each desktop.pcs as p (p.id)}
					<li>
						<span class="name">{p.name}</span>
						<span class="state" class:on={connected.has(p.id)}>{stateOf(p.id)}</span>
						<button type="button" class:danger={confirming === p.id} onclick={() => remove(p.id, (id) => desktop.forgetPc(id))}>{confirming === p.id ? 'Remove for good' : 'Remove'}</button>
						{#if problems[p.id]}<p class="error small problem">{problems[p.id]}</p>{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if desktop.pcPairing}
			{@const pairing = desktop.pcPairing}
			<div class="pairing" role="group" aria-label="Pairing with {pairing.peerName}">
				<p>Does {pairing.peerName} show the same code?</p>
				<p class="digits" aria-label="Code">{pairing.code}</p>
				<div class="row">
					<button type="button" class="primary" disabled={pairing.confirmed} onclick={() => void act(() => desktop.confirmPcPairing())}>{pairing.confirmed ? `Waiting for ${pairing.peerName}…` : 'Same code'}</button>
					<button type="button" onclick={() => void act(() => desktop.cancelPcPairing())}>Cancel</button>
				</div>
			</div>
		{:else if unpairedPcs.length > 0}
			<p class="muted small">To pair, open Settings on the other PC too.</p>
			<ul aria-label="PCs on this network">
				{#each unpairedPcs as f (f.id)}
					<li>
						<span class="name">{f.name}</span>
						<button type="button" disabled={startingWith !== null} onclick={() => pairPc(f.id)}>{startingWith === f.id ? 'Pairing…' : 'Pair'}</button>
					</li>
				{/each}
			</ul>
		{:else if desktop.pcs.length === 0 && desktop.enabled}
			<p class="muted">No other PC found. Is Discipline running there and allowed through its firewall?</p>
		{/if}
		{#if desktop.pcPairingResult}
			<p class={desktop.pcPairingResult.ok ? 'ok' : 'error'} role={desktop.pcPairingResult.ok ? 'status' : 'alert'}>{desktop.pcPairingResult.message}</p>
		{/if}
	{:else if phone}
		{#if STATUS[phone.status]}<p class="muted" aria-live="polite">{STATUS[phone.status]}</p>{/if}
		{#if phone.status !== 'connected' && phone.status !== 'other-tab' && phone.problem}<p class="muted small">{phone.problem}</p>{/if}

		<h4>PCs</h4>
		{#if phone.pairings.length === 0}
			<p class="muted">No PCs paired.</p>
		{:else}
			<ul>
				{#each phone.pairings as p (p.pcId)}
					<li>
						<span class="name">{p.name}</span>
						<span class="state" class:on={connected.has(p.pcId)}>{stateOf(p.pcId)}</span>
						<button type="button" class:danger={confirming === p.pcId} disabled={!canChange} onclick={() => remove(p.pcId)}>{confirming === p.pcId ? 'Remove for good' : 'Remove'}</button>
						{#if problems[p.pcId]}<p class="error small problem">{problems[p.pcId]}</p>{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if !canChange}
			<p class="muted small">Change devices in the tab that syncs.</p>
		{:else if scanning}
			<QrScanner accept={(text) => parsePairingCode(text) !== null} onfound={pairWith} />
			<button type="button" onclick={() => (scanning = false)}>Cancel</button>
		{:else}
			<p class="muted small">The code is on the PC under Settings → “Pair a phone”.</p>
			<button type="button" class="primary" disabled={pairing || !enabled} onclick={() => ((scanning = true), (failure = null), (message = null))}>
				{pairing ? 'Pairing…' : 'Pair with a PC'}
			</button>
			<details>
				<summary>Enter the code instead</summary>
				<form
					class="typed"
					onsubmit={(e) => {
						e.preventDefault();
						pairWith(typed);
					}}
				>
					<input type="text" autocomplete="off" spellcheck="false" aria-label="Pairing code" placeholder="DS1|…" bind:value={typed} />
					<button type="submit" disabled={pairing || !enabled || !typed.trim()}>Pair</button>
				</form>
			</details>
		{/if}
	{/if}

	{#if failure}<p class="error" role="alert">{failure}</p>{/if}
	{#if message}<p class="ok" role="status">{message}</p>{/if}

	<h4>This device</h4>
	<form class="rename" onsubmit={rename}>
		<label for="device-name">Name</label>
		<input id="device-name" type="text" autocomplete="off" maxlength="64" disabled={!canChange} bind:value={name} />
		<button type="submit" disabled={!canChange}>Save</button>
	</form>
</section>

<style>
	.devices {
		display: grid;
		gap: 0.6rem;
	}
	h3 {
		margin: 0;
		font-size: 1.1rem;
	}
	h4 {
		margin: 0.75rem 0 0;
		font-size: 1rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.35rem;
	}
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
	}
	.problem {
		flex-basis: 100%;
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.state {
		color: var(--muted);
		font-size: 0.85rem;
	}
	.state.on {
		color: var(--positive);
	}
	.muted {
		color: var(--muted);
		margin: 0;
	}
	.small {
		font-size: 0.85rem;
	}
	.error {
		color: var(--negative);
		margin: 0;
	}
	.ok {
		color: var(--positive);
		margin: 0;
	}
	.qr {
		display: grid;
		gap: 0.5rem;
		justify-items: start;
	}
	.code {
		background: #fff;
		padding: 0.5rem;
		border-radius: 0.5rem;
		line-height: 0;
	}
	.code :global(svg) {
		width: min(16rem, 70vw);
		height: auto;
	}
	.qr p {
		margin: 0;
	}
	.payload {
		display: block;
		overflow-wrap: anywhere;
		user-select: all;
	}
	.pairing {
		display: grid;
		gap: 0.5rem;
		justify-items: start;
	}
	.pairing p {
		margin: 0;
	}
	.digits {
		font-size: 2rem;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.1em;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.typed,
	.rename {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-top: 0.4rem;
	}
	.typed input,
	.rename input {
		flex: 1;
		min-width: 0;
	}
	.rename label {
		color: var(--muted);
	}
	button.danger {
		border-color: var(--negative);
		color: var(--negative);
	}
</style>
