<!--
	Importing and exporting the data file, preferences of this device (stored in the browser, not in
	the data file) and the devices it syncs with. Changes apply at once.
-->
<script lang="ts">
	import { DATE_STYLES, formatDateAs, today, type DateStyle } from '../core';
	import { attempt } from './attempt';
	import { chooseFileToSave, dataLocation, isDesktop, suggestedBackupPath } from './desktop';
	import { DAY_STARTS, settings } from './settings.svelte';
	import { displayKeys } from './shortcuts.svelte';
	import type { DesktopSync } from './sync/desktop-sync.svelte';
	import Devices from './sync/Devices.svelte';
	import type { PhoneSync } from './sync/phone-sync.svelte';
	import Modal from './ui/Modal.svelte';
	import type { Workspace } from './workspace.svelte';

	let {
		workspace,
		sync,
		busy,
		onimport,
		onexport,
		onundoimport,
		onclose,
	}: {
		workspace: Workspace;
		sync: DesktopSync | PhoneSync;
		/** The data isn't loaded (yet): no file actions */
		busy: boolean;
		/** The file actions; each closes the dialog first. They must start right in the click
		 * (browsers allow a file chooser or download only directly after one) */
		onimport: () => void;
		onexport: () => void;
		onundoimport: () => void;
		onclose: () => void;
	} = $props();
	const sample = today();
	const time = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
	const location = isDesktop ? dataLocation().catch(() => null) : null;
	/** Why choosing the backup file failed (shown here: a notice would be behind the dialog) */
	let failure = $state<string | null>(null);

	async function chooseBackup() {
		failure = null;
		await attempt(
			(text) => (failure = text),
			async () => {
				const path = await chooseFileToSave('Back up to', settings.backupPath ?? (await suggestedBackupPath()));
				if (path) await workspace.setBackupPath(path);
			},
		);
	}
</script>

<Modal title="Settings" {onclose}>
	<div class="settings">
		<label for="date-style">Date format</label>
		<select id="date-style" value={settings.dateStyle} onchange={(e) => (settings.dateStyle = e.currentTarget.value as DateStyle)}>
			{#each DATE_STYLES as style (style)}
				<option value={style}>{style} ({formatDateAs(sample, style)})</option>
			{/each}
		</select>
		<label for="day-start">New day starts at</label>
		<select id="day-start" value={settings.dayStart} onchange={(e) => (settings.dayStart = Number(e.currentTarget.value))}>
			{#each DAY_STARTS as minutes (minutes)}
				<option value={minutes}>{time(minutes)}</option>
			{/each}
		</select>
		<label for="week-start">Week starts on</label>
		<select id="week-start" value={settings.weekStart} onchange={(e) => (settings.weekStart = e.currentTarget.value === '7' ? 7 : 1)}>
			<option value={1}>Monday</option>
			<option value={7}>Sunday</option>
		</select>
		<p class="muted">These settings apply to this device only.</p>
		<hr />
		<Devices {sync} />
		<hr />
		<h3>Data</h3>
		<div class="row">
			<button type="button" disabled={busy} title={displayKeys('Mod+o')} onclick={onimport}>Import</button>
			<button type="button" disabled={busy} title={displayKeys('Mod+s')} onclick={onexport}>Export</button>
			{#if workspace.canUndoImport}<button type="button" disabled={busy} onclick={onundoimport}>Undo import</button>{/if}
		</div>
		{#if workspace.fileName}<p class="muted file">Last file: <span class="name">{workspace.fileName}</span></p>{/if}
		{#if isDesktop}
			<h4>Backup file</h4>
			<div class="backup">
				{#if settings.backupPath}
					<code class="path">{settings.backupPath}</code>
					<div class="row">
						<button type="button" onclick={() => void chooseBackup()}>Change…</button>
						<button type="button" onclick={() => void workspace.setBackupPath(null)}>Turn off</button>
					</div>
				{:else}
					<div class="row"><button type="button" onclick={() => void chooseBackup()}>Choose…</button></div>
				{/if}
				{#if failure ?? workspace.backupError}<p class="error" role="alert">{failure ?? workspace.backupError}</p>{/if}
				<p class="muted">
					Updated a few seconds after each change. To restore it, import it.
				</p>
			</div>
		{/if}
		{#if location}
			{#await location then where}
				{#if where}
					<p class="muted where">
						{where.portable ? 'Data folder (portable):' : 'Data folder:'}
						<code>{where.path}</code>
					</p>
				{/if}
			{/await}
		{/if}
		<div class="buttons"><button type="button" class="primary" onclick={onclose}>Done</button></div>
	</div>
</Modal>

<style>
	.settings {
		display: grid;
		gap: 0.5rem;
	}
	.muted,
	label {
		color: var(--muted);
	}
	.muted {
		font-size: 0.85rem;
		margin: 0.5rem 0 0;
	}
	h3 {
		margin: 0;
		font-size: 1.1rem;
	}
	h4 {
		margin: 0.75rem 0 0;
		font-size: 1rem;
	}
	.file {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.backup {
		display: grid;
		gap: 0.5rem;
	}
	.row {
		display: flex;
		gap: 0.5rem;
	}
	.path,
	.where code {
		overflow-wrap: anywhere;
	}
	.error {
		color: var(--negative);
		margin: 0;
	}
	hr {
		width: 100%;
		margin: 0.75rem 0 0.25rem;
		border: none;
		border-top: 1px solid var(--border);
	}
	.where code {
		overflow-wrap: anywhere;
	}
	.buttons {
		display: flex;
		justify-content: flex-end;
		margin-top: 0.5rem;
	}
</style>
