<script lang="ts">
	import DayView from './lib/DayView.svelte';
	import HabitsView from './lib/HabitsView.svelte';
	import StatsView from './lib/stats/StatsView.svelte';
	import { touchFirst } from './lib/pointer';
	import { errorMessage } from './lib/errors';
	import ImportDialog from './lib/ImportDialog.svelte';
	import { notices } from './lib/notices.svelte';
	import SettingsDialog from './lib/SettingsDialog.svelte';
	import { displayKeys, shortcuts } from './lib/shortcuts.svelte';
	import ShortcutHelp from './lib/ui/ShortcutHelp.svelte';
	import { Workspace, type ImportCandidate } from './lib/workspace.svelte';
	import { DesktopSync } from './lib/sync/desktop-sync.svelte';
	import SyncSwitch from './lib/sync/SyncSwitch.svelte';
	import { SyncManager } from './lib/sync/manager.svelte';
	import { PhoneSync } from './lib/sync/phone-sync.svelte';
	import { setPreferences, type SyncReport } from './core';
	import { clock } from './lib/clock.svelte';
	import { forgetOldPreferences, oldPreferences, settings } from './lib/settings.svelte';
	import { updates } from './lib/updates.svelte';

	const SECTIONS = [
		{ id: 'today', label: 'Today', keys: 'g t' },
		{ id: 'habits', label: 'Habits', keys: 'g h' },
		{ id: 'stats', label: 'Stats', keys: 'g s' },
	] as const;
	let section = $state<(typeof SECTIONS)[number]['id']>('today');

	/** Shows a tab, from its top (each tab resets itself when it's left) */
	function go(id: typeof section) {
		if (id === section) return;
		section = id;
		window.scrollTo(0, 0);
	}

	const workspace = new Workspace();

	/** What a sync brought in, e.g. "Synced with Desktop. Entries: 3 added, 1 changed." */
	function reportSync(report: SyncReport) {
		const kinds = [
			['habits', 'Habits'],
			['entries', 'Entries'],
		] as const;
		const lines = kinds.flatMap(([kind, label]) => {
			const c = report.changes[kind];
			const counts = [c.added && `${c.added} added`, c.changed && `${c.changed} changed`, c.deleted && `${c.deleted} removed`].filter(Boolean);
			return counts.length ? [`${label}: ${counts.join(', ')}.`] : [];
		});
		if (report.changes.preferences) lines.push('Day and week start changed.');
		notices.info(`Synced with ${report.peer.name}. ${lines.join(' ')}`);
	}
	const sync = workspace.isDesktop ? new DesktopSync(workspace, reportSync) : new PhoneSync(workspace, reportSync);

	// end-to-end tests reach the app and drive the sync through this (dev builds only; removed from
	// production builds)
	if (import.meta.env.DEV) Object.assign(window, { __disciplineTest: { workspace, SyncManager, notices, sync } });
	let loadError = $state<string | null>(null);
	$effect(() => {
		const stop = workspace
			.start()
			.then(async (stopWorkspace) => {
				await movePreferencesIntoData();
				// syncing starts once the data is loaded
				const stopSync = await sync.start().catch((e: unknown) => {
					notices.error(`Syncing can’t start: ${errorMessage(e)}`);
					return () => {};
				});
				return () => {
					stopSync();
					stopWorkspace();
				};
			})
			.catch((e: unknown) => {
				loadError = errorMessage(e);
				return () => {};
			});
		return () => void stop.then((f) => f());
	});

	// the installed web app: its service worker, and new versions (see updates.svelte.ts)
	$effect(() => {
		const stop = updates.start(() => workspace.settled());
		return () => void stop.then((f) => f());
	});
	/** "New version available" was closed (until the next start) */
	let updateDismissed = $state(false);

	// "today" follows the data's day start (shared by all synced devices)
	$effect(() => {
		clock.dayStart = workspace.data.preferences.dayStart;
	});

	/**
	 * The day and week start used to be this device's own preferences: if they were set and the
	 * data has none yet, they move into the data (once; afterwards the data's apply).
	 */
	async function movePreferencesIntoData() {
		const old = oldPreferences();
		try {
			// (checked inside the edit: a sync or another tab may have set them meanwhile)
			if (old) await workspace.edit('Day and week start', (d, now) => (d.preferences.edited === null ? setPreferences(d, old, now) : d), { undoable: false });
			forgetOldPreferences();
		} catch (e) {
			notices.error(`The day and week start couldn’t be taken over: ${errorMessage(e)}`);
		}
	}

	// raw: a proxy would break the identity check of `candidate.from` in the workspace
	let candidate = $state.raw<ImportCandidate | null>(null);
	function closeDialog() {
		candidate = null;
	}
	// another tab changed the data: a planned import is based on old data, so drop it
	$effect(() => {
		void workspace.revision;
		candidate = null;
	});

	let settingsOpen = $state(false);
	let habitsView = $state<HabitsView>();

	/** `undo`: offer to undo the last change (e.g. after deleting) */
	function notify(text: string, undo = false) {
		notices.info(text, undo);
	}

	function undo() {
		void run(async () => {
			const label = await workspace.undo();
			return label ? `Undone: ${label}` : 'Nothing to undo.';
		});
	}

	function redo() {
		void run(async () => {
			const label = await workspace.redo();
			return label ? `Redone: ${label}` : 'Nothing to redo.';
		});
	}

	$effect(() => {
		window.addEventListener('keydown', shortcuts.handle);
		return () => window.removeEventListener('keydown', shortcuts.handle);
	});

	$effect(() =>
		shortcuts.add([
			// also in dialogs (outside text fields), so the help can show e.g. the editor's keys
			{ keys: ['?'], description: 'Show the keyboard shortcuts', group: 'General', inDialog: true, when: () => !shortcuts.helpOpen, run: () => (shortcuts.helpOpen = true) },
			{ keys: ['Mod+z'], description: 'Undo the last change', group: 'General', when: () => !busy, run: undo },
			{ keys: ['Mod+Shift+z', 'Mod+y'], description: 'Redo', group: 'General', when: () => !busy, run: redo },
			{ keys: ['Mod+,'], description: 'Settings', group: 'General', inFields: true, run: () => (settingsOpen = true) },
			...SECTIONS.map((s) => ({ keys: [s.keys], description: `Go to ${s.label.toLowerCase()}`, group: 'General', run: () => go(s.id) })),
			{ keys: ['Mod+o'], description: 'Import a file', group: 'File', inFields: true, when: () => !busy, run: importFile },
			{ keys: ['Mod+s'], description: 'Export the file', group: 'File', inFields: true, when: () => !busy, run: exportFile },
		]),
	);

	let runs = 0;
	/** The run whose message is shown (0: none of them) */
	let shownBy = 0;
	/** Runs an action and shows a failure instead of losing it in the console. */
	async function run(action: () => Promise<string | null>) {
		const id = ++runs;
		try {
			const text = await action();
			// an action that finishes late must not replace or clear the message of one started
			// after it; errors always show
			if (id < shownBy) return;
			if (text) notices.info(text);
			else notices.clearInfo();
			shownBy = text ? id : 0;
		} catch (e) {
			notices.error(`Something went wrong: ${errorMessage(e)}`);
		}
	}

	let fileInput: HTMLInputElement;

	function onFileChosen() {
		const file = fileInput.files?.[0];
		fileInput.value = ''; // so choosing the same file again triggers a change too
		if (file) {
			void run(async () => {
				candidate = workspace.planImport(file.name, await file.text());
				return null;
			});
		}
	}

	/** The browser picks the file with the file input; the desktop app with its own dialog */
	function importFile() {
		if (!workspace.isDesktop) return fileInput.click();
		void run(async () => {
			candidate = await workspace.chooseImport();
			return null;
		});
	}

	function applyImport() {
		const chosen = candidate;
		closeDialog();
		if (chosen?.ok) {
			void run(async () => {
				await workspace.applyImport(chosen);
				return 'Imported.';
			});
		}
	}

	function undoImport() {
		void run(async () => {
			await workspace.undoImport();
			return 'Import undone.';
		});
	}

	function exportFile() {
		// no await before exportFile: browsers only allow sharing/downloading directly after a click
		void run(async () => ((await workspace.exportFile()) ? 'Exported.' : null));
	}

	const busy = $derived(!workspace.ready || loadError !== null);
</script>

<!-- iOS greys out files for a strict filter on some versions, so text files are allowed too -->
<input type="file" accept=".json,application/json,text/plain" hidden bind:this={fileInput} onchange={onFileChosen} />

<header>
	<div class="title">
		<h1>Discipline</h1>
	</div>
	<nav aria-label="Sections">
		{#each SECTIONS as s (s.id)}
			<button class="tab" aria-current={section === s.id ? 'page' : undefined} title={displayKeys(s.keys)} onclick={() => go(s.id)}
				>{s.label}</button
			>
		{/each}
	</nav>
	<div class="tools">
		<SyncSwitch {sync} />
		{#if !touchFirst}<button class="tab icon help" aria-label="Keyboard shortcuts" title="?" onclick={() => (shortcuts.helpOpen = true)}>?</button>{/if}
		<button class="tab icon" aria-label="Settings" title={displayKeys('Mod+,')} onclick={() => (settingsOpen = true)}>
			<svg viewBox="0 0 24 24" aria-hidden="true"
				><path
					fill="currentColor"
					d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.67 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.12.22.39.3.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.05.24.25.42.49.42h3.84c.24 0 .44-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.48 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7"
				/></svg
			>
		</button>
	</div>
</header>

<main>
	{#if loadError}
		<p class="notice error" role="alert">Your data can't be loaded: {loadError}</p>
	{:else if workspace.ready}
		<!-- each view stays mounted (keeps its selection); only the shown one is active -->
		<div hidden={section !== 'today'}>
			<DayView
				{workspace}
				active={section === 'today'}
				onnewhabit={() => {
					section = 'habits';
					habitsView?.openNew();
				}}
				onedithabit={(habit) => {
					section = 'habits';
					habitsView?.openEdit(habit);
				}}
			/>
		</div>
		<div hidden={section !== 'habits'}>
			<HabitsView bind:this={habitsView} {workspace} active={section === 'habits'} {notify} />
		</div>
		<div hidden={section !== 'stats'}>
			<StatsView {workspace} active={section === 'stats'} />
		</div>
	{/if}
</main>

<!-- floating, so a message coming or going never shifts the page -->
<div class="notices">
	{#if workspace.backupError}
		<p class="notice error" role="alert">
			<span>The backup file couldn't be written: {workspace.backupError} It's tried again with the next change.</span>
			<button class="dismiss" aria-label="Dismiss" title="Dismiss" onclick={() => (workspace.backupError = null)}>×</button>
		</p>
	{/if}
	{#if updates.available && settings.updates === 'ask' && !updateDismissed}
		<p class="notice" role="status">
			<span>New version available.</span>
			<button class="link" disabled={updates.busy} onclick={() => void updates.apply()}>Update</button>
			<button class="dismiss" aria-label="Dismiss" title="Dismiss" onclick={() => (updateDismissed = true)}>×</button>
		</p>
	{/if}
	{#each notices.list as n (n.id)}
		<p class="notice" class:error={n.error} role={n.error ? 'alert' : 'status'}>
			<span>{n.text}</span>
			{#if n.undo && workspace.undoLabel}<button class="link" onclick={undo}>Undo{#if !touchFirst} <kbd>{displayKeys('Mod+z')}</kbd>{/if}</button>{/if}
			<button class="dismiss" aria-label="Dismiss" title="Dismiss" onclick={() => notices.dismiss(n.id)}>×</button>
		</p>
	{/each}
</div>

{#if shortcuts.helpOpen}
	<ShortcutHelp onclose={() => (shortcuts.helpOpen = false)} />
{/if}

{#if settingsOpen}
	<SettingsDialog
		{workspace}
		{sync}
		{busy}
		onimport={() => {
			settingsOpen = false;
			importFile();
		}}
		onexport={() => {
			settingsOpen = false;
			exportFile();
		}}
		onundoimport={() => {
			settingsOpen = false;
			undoImport();
		}}
		onclose={() => (settingsOpen = false)}
	/>
{/if}

{#if candidate}
	<ImportDialog {candidate} onapply={applyImport} onclose={closeDialog} />
{/if}

<style>
	header {
		position: sticky;
		top: 0;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		grid-template-areas: 'title nav tools';
		column-gap: 1.25rem;
		gap: 0.5rem;
		align-items: center;
		padding: max(0.75rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) 0.75rem max(1rem, env(safe-area-inset-left));
		background: var(--surface);
		border-bottom: 1px solid var(--border);
		z-index: 1;
	}
	.title {
		grid-area: title;
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		min-width: 0;
	}
	h1 {
		margin: 0;
		font-size: 1.25rem;
	}
	.tools {
		grid-area: tools;
		justify-self: end;
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}
	/* lists read best narrow */
	main {
		max-width: 60rem;
		margin: 0 auto;
		padding: 0 env(safe-area-inset-right) max(1rem, env(safe-area-inset-bottom)) env(safe-area-inset-left);
	}
	nav {
		grid-area: nav;
		display: flex;
		gap: 0.25rem;
		overflow-x: auto;
	}
	.tab {
		border: none;
		border-radius: 0.5rem;
		background: none;
		color: var(--muted);
		min-height: var(--tap);
	}
	/* phones: the tabs get a row of their own; the shortcut help is for keyboards (? still
	   opens it) */
	@media (max-width: 40rem) {
		header {
			grid-template-columns: minmax(0, 1fr) auto;
			grid-template-areas: 'title tools' 'nav nav';
		}
		.tab {
			padding: 0.45rem 0.45rem;
			font-size: 0.9rem;
		}
		.tools .tab.help {
			display: none;
		}
	}
	.tab[aria-current='page'] {
		color: var(--text);
		background: var(--accent-soft);
		font-weight: 600;
	}
	.tab.icon {
		min-width: var(--tap);
		display: grid;
		place-items: center;
	}
	/* (framed, so it's clear they can be clicked or tapped) */
	.tools .tab.icon {
		border: 1px solid var(--control-border);
		padding: 0;
	}
	.tools .tab.icon:hover {
		border-color: var(--accent);
		color: var(--text);
	}
	.tab svg {
		width: 1.15rem;
		height: 1.15rem;
	}
	.link {
		border: none;
		background: none;
		color: var(--accent);
		font-weight: 600;
		min-height: 0;
		padding: 0 0.4rem;
	}
	.notice {
		margin: 0.75rem 0.75rem 0;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		background: var(--accent-soft);
	}
	.notice.error {
		background: none;
		border: 1px solid var(--negative);
		color: var(--negative);
	}
	.notices {
		position: fixed;
		z-index: 10;
		left: 50%;
		bottom: max(1rem, env(safe-area-inset-bottom));
		transform: translateX(-50%);
		width: min(36rem, calc(100vw - 1.5rem));
		display: grid;
		gap: 0.5rem;
		/* only the messages take clicks, not the space between them */
		pointer-events: none;
	}
	.notices .notice {
		pointer-events: auto;
		margin: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.5rem 0.5rem 0.9rem;
		background: var(--surface);
		border: 1px solid var(--border);
		box-shadow: 0 0.25rem 1rem rgb(0 0 0 / 0.18);
	}
	.notices .notice > span {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.notices .notice.error {
		border-color: var(--negative);
		background: var(--surface);
	}
	.dismiss {
		flex: none;
		min-height: 0;
		min-width: var(--tap);
		align-self: stretch;
		padding: 0 0.5rem;
		border: none;
		background: none;
		color: var(--muted);
		font-size: 1.2rem;
		line-height: 1.5;
	}
</style>
