<!--
	The header's sync switch: turns all networking on and off, and says how syncing goes
	(off, on, how many devices are connected, or a problem; details on hover and in Settings).
-->
<script lang="ts">
	import { errorMessage } from '../errors';
	import { showError } from '../notices.svelte';
	import { DesktopSync } from './desktop-sync.svelte';
	import type { PhoneSync } from './phone-sync.svelte';

	let { sync }: { sync: DesktopSync | PhoneSync } = $props();

	const desktop = $derived(sync instanceof DesktopSync ? sync : null);
	const phone = $derived(sync instanceof DesktopSync ? null : sync);
	const enabled = $derived(desktop ? desktop.enabled : (phone?.enabled ?? false));
	const canChange = $derived(desktop ? desktop.info !== null : (phone?.canChange ?? false));

	/** The text, its look, and the details for the tooltip */
	const shown = $derived.by((): { text: string; look: 'off' | 'on' | 'problem'; details?: string } => {
		const connections = sync.manager.connections.length;
		const failure = Object.values(sync.manager.problems)[0];
		if (phone?.status === 'other-tab') return { text: 'Other tab syncs', look: enabled ? 'on' : 'off' };
		if (!enabled) return { text: 'Sync off', look: 'off' };
		if (desktop?.problem) return { text: 'Sync problem', look: 'problem', details: `Syncing can’t start: ${desktop.problem}` };
		if (connections > 0) return { text: `${connections} connected`, look: 'on' };
		if (failure) return { text: 'Sync problem', look: 'problem', details: failure };
		if (desktop) return desktop.info ? { text: 'Sync on', look: 'on' } : { text: 'Starting…', look: 'on' };
		switch (phone?.status) {
			case 'connecting':
				return { text: 'Connecting…', look: 'on' };
			case 'unreachable':
				return { text: 'Offline', look: 'on', details: phone.problem ?? 'No paired PC reachable.' };
			case 'unpaired':
				return { text: 'Not paired', look: 'on', details: 'Pair with a PC in Settings.' };
			default:
				return { text: 'Sync on', look: 'on' };
		}
	});

	/** Switching is under way (the switch waits for it) */
	let switching = $state(false);

	async function toggle(input: HTMLInputElement) {
		const on = input.checked;
		switching = true;
		try {
			if (desktop) await desktop.setEnabled(on);
			else phone!.setEnabled(on);
		} catch (e) {
			showError(`Couldn’t turn sync ${on ? 'on' : 'off'}: ${errorMessage(e)}`);
		} finally {
			// (shows the actual state, also if switching failed)
			input.checked = desktop ? desktop.enabled : phone!.enabled;
			switching = false;
		}
	}
</script>

<label class="sync {shown.look}" title={shown.details ?? 'Sync with your devices on the local network'}>
	<input
		type="checkbox"
		role="switch"
		aria-label="Sync"
		checked={enabled}
		disabled={switching || !canChange}
		onchange={(e) => void toggle(e.currentTarget)}
	/>
	<span class="text" aria-live="polite">{shown.text}</span>
</label>

<style>
	.sync {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 2.25rem;
		padding: 0 0.75rem 0 0.3rem;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		color: var(--muted);
		white-space: nowrap;
		cursor: pointer;
	}
	.sync.on {
		border-color: var(--positive);
		color: var(--positive);
	}
	.sync.problem {
		border-color: var(--negative);
		color: var(--negative);
		font-weight: 600;
	}
	.sync:has(input:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	input:focus-visible {
		outline: none;
	}
	input[role='switch']:checked {
		background: var(--positive);
		border-color: var(--positive);
	}
	input[role='switch']:checked::before {
		background: var(--surface);
	}
	@media (max-width: 40rem) {
		.sync {
			font-size: 0.9rem;
		}
	}
</style>
