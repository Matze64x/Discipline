<!--
	All habits: add (n), edit (Enter), reorder (Alt+↑/↓), archive (a) and delete (Delete, with undo).
	Active habits first, in their order; archived ones after them.
-->
<script lang="ts">
	import { addDays, deleteHabit, latestGoal, moveHabit, setArchived, type Habit, type Id } from '../core';
	import { attempt } from './attempt';
	import { clock } from './clock.svelte';
	import { describeGoal } from './display';
	import HabitEditor from './HabitEditor.svelte';
	import { showError } from './notices.svelte';
	import { shortcuts } from './shortcuts.svelte';
	import SelectableList from './ui/SelectableList.svelte';
	import type { Workspace } from './workspace.svelte';

	let { workspace, active, notify }: { workspace: Workspace; active: boolean; notify: (text: string, undo?: boolean) => void } = $props();

	const activeHabits = $derived(workspace.data.habits.filter((h) => h.archived === null));
	const archivedHabits = $derived(workspace.data.habits.filter((h) => h.archived !== null));
	const habits = $derived([...activeHabits, ...archivedHabits]);

	let selectedId = $state<Id | null>(null);
	const selectedIndex = $derived(habits.findIndex((h) => h.id === selectedId));
	const selected = $derived(habits[selectedIndex]);
	/** The dialog: a new habit (null) or the habit edited; undefined: closed */
	let editing = $state.raw<Habit | null | undefined>(undefined);
	let list: SelectableList<Habit, Id>;
	let listElement = $state<HTMLElement>();

	/** Opens the editor for a new habit (also from other views) */
	export function openNew() {
		editing = null;
	}

	/** Opens the editor for a habit (also from other views) */
	export function openEdit(habit: Habit) {
		selectedId = habit.id;
		editing = habit;
	}

	function close() {
		editing = undefined;
		list.focus();
	}

	async function remove(h: Habit | undefined) {
		if (!h) return;
		const next = habits[selectedIndex + 1] ?? habits[selectedIndex - 1];
		if (await attempt(showError, () => workspace.edit(`Delete “${h.name}”`, (d) => deleteHabit(d, h.id)))) {
			selectedId = next?.id ?? null;
			notify(`Deleted “${h.name}”.`, true);
		}
	}

	/** Archives from tomorrow on (today still counts), or makes active again */
	async function toggleArchived(h: Habit | undefined) {
		if (!h) return;
		const archive = h.archived === null;
		const label = archive ? `Archive “${h.name}”` : `Unarchive “${h.name}”`;
		if (await attempt(showError, () => workspace.edit(label, (d, now) => setArchived(d, h.id, archive ? addDays(clock.today, 1) : null, now)))) {
			notify(archive ? `Archived “${h.name}”.` : `“${h.name}” is active again.`, true);
		}
	}

	/** Moves the selected habit up or down among the active habits (or the archived ones) */
	async function move(h: Habit | undefined, by: -1 | 1) {
		if (!h) return;
		const group = h.archived === null ? activeHabits : archivedHabits;
		const index = group.findIndex((x) => x.id === h.id);
		const target = group[index + by];
		if (!target) return;
		// before the one above it, or before whatever follows the one below it in the data's order
		// (where archived habits sit between active ones; null: the very end)
		const all = workspace.data.habits;
		const before = by < 0 ? target.id : (all[all.findIndex((x) => x.id === target.id) + 1]?.id ?? null);
		await attempt(showError, () => workspace.edit(`Move “${h.name}”`, (d, now) => moveHabit(d, h.id, before, now)));
	}

	$effect(() =>
		shortcuts.add([
			{ keys: ['n'], description: 'New habit', group: 'Habits', when: () => active, run: openNew },
			// these act on the selection, so only while the list (not a button elsewhere) has the focus
			...[
				{ keys: ['Enter', 'e'], description: 'Edit the selected habit', run: () => (editing = selected) },
				{ keys: ['Alt+ArrowUp'], description: 'Move it up', repeat: true, run: () => void move(selected, -1) },
				{ keys: ['Alt+ArrowDown'], description: 'Move it down', repeat: true, run: () => void move(selected, 1) },
				{ keys: ['a'], description: 'Archive it, or make it active again', run: () => void toggleArchived(selected) },
				{ keys: ['Delete', 'Backspace'], description: 'Delete it', run: () => void remove(selected) },
			].map((s) => ({ ...s, group: 'Habits', focusIn: () => listElement, visible: () => active, when: () => active && !!selected })),
		]),
	);
</script>

<div class="toolbar">
	<h2>Habits</h2>
	<button class="primary" onclick={openNew}>New</button>
</div>

<SelectableList
	bind:this={list}
	bind:selected={selectedId}
	bind:element={listElement}
	items={habits}
	key={(h) => h.id}
	label="Habits"
	{active}
	group="Habits"
	itemName="habit"
	onopen={(h) => (editing = h)}
>
	{#snippet row(h)}
		<div class="row" class:archived={h.archived !== null}>
			<span class="dot" style:background={h.color}></span>
			<span class="name">{h.name}</span>
			<span class="goal">{h.archived !== null ? 'Archived' : describeGoal(latestGoal(h), h)}</span>
		</div>
	{/snippet}
	{#snippet empty()}
		<p class="empty">No habits yet.</p>
	{/snippet}
</SelectableList>

{#if editing !== undefined}
	<HabitEditor
		{workspace}
		habit={editing}
		onsaved={(id) => {
			selectedId = id;
			close();
		}}
		onarchive={(h) => {
			close();
			void toggleArchived(h);
		}}
		onmove={(h, by) => void move(h, by)}
		canmove={(h, by) => {
			const group = h.archived === null ? activeHabits : archivedHabits;
			const i = group.findIndex((x) => x.id === h.id);
			return i >= 0 && group[i + by] !== undefined;
		}}
		ondelete={(h) => {
			close();
			selectedId = h.id;
			void remove(h);
		}}
		onclose={close}
	/>
{/if}

<style>
	.toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 0.75rem 0.5rem;
	}
	h2 {
		margin: 0;
		font-size: 1.3rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 0.75rem;
	}
	.archived {
		opacity: 0.6;
	}
	.dot {
		width: 0.9rem;
		height: 0.9rem;
		border-radius: 50%;
		flex: none;
	}
	.name {
		flex: 1 0 40%;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.goal {
		flex: 0 1 auto;
		color: var(--muted);
		font-size: 0.9rem;
		text-align: right;
	}
	.empty {
		color: var(--muted);
		text-align: center;
		padding: 3rem 1rem;
	}
</style>
