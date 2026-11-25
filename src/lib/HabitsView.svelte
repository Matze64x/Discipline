<!--
	All habits, as cards: add (New, n), edit (a tap; archive and delete are in the editor, delete
	with undo), reorder (Reorder: ↑ ↓ on every card, a tap then opens nothing, so the new order
	shows in place). Active habits first, in their order; archived ones after them. Touch first
	(user 2026-11-25): no keys that act on a selected row, and no selection shown.
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
	/** The dialog: a new habit (null) or the habit edited; undefined: closed */
	let editing = $state.raw<Habit | null | undefined>(undefined);
	let list: SelectableList<Habit, Id>;

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

	/** Reorder mode: ↑ ↓ on every row */
	let reordering = $state(false);
	// nothing left to reorder (also after a sync or an undone import): the mode ends, else New and
	// the taps that open a habit would stay hidden
	$effect(() => {
		if (habits.length < 2) reordering = false;
	});

	/** Whether a habit can move up or down among the active habits (or the archived ones) */
	function canMove(h: Habit, by: -1 | 1): boolean {
		const group = h.archived === null ? activeHabits : archivedHabits;
		const i = group.findIndex((x) => x.id === h.id);
		return i >= 0 && group[i + by] !== undefined;
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

	$effect(() => shortcuts.add([{ keys: ['n'], description: 'New habit', group: 'Habits', when: () => active, run: openNew }]));

	// a tab comes back fresh (user 2026-11-25): not reordering
	$effect(() => {
		if (!active) reordering = false;
	});
</script>

<div class="toolbar">
	<h2>Habits</h2>
	<div class="tools">
		{#if habits.length > 1}<button onclick={() => ((reordering = !reordering), list.focus())}>{reordering ? 'Done' : 'Reorder'}</button>{/if}
		{#if !reordering}<button class="primary" onclick={openNew}>New</button>{/if}
	</div>
</div>

<SelectableList
	bind:this={list}
	bind:selected={selectedId}
	items={habits}
	key={(h) => h.id}
	label="Habits"
	{active}
	group="Habits"
	itemName="habit"
	onopen={(h) => !reordering && (editing = h)}
	showSelection={false}
	cards
>
	{#snippet row(h)}
		<div class="row" class:archived={h.archived !== null}>
			<span class="dot" style:background={h.color}></span>
			<span class="name">{h.name}</span>
			<span class="goal">{h.archived !== null ? 'Archived' : describeGoal(latestGoal(h), h)}</span>
			{#if reordering}
				<!-- (never focused, like Today's row buttons: the keys act on the list's selection) -->
				<span class="move">
					{#each [-1, 1] as const as by (by)}
						<button
							type="button"
							tabindex="-1"
							aria-label={by < 0 ? `Move “${h.name}” up` : `Move “${h.name}” down`}
							disabled={!canMove(h, by)}
							onmousedown={(e) => e.preventDefault()}
							onclick={(e) => {
								e.stopPropagation();
								selectedId = h.id;
								void move(h, by);
								list.focus();
							}}>{by < 0 ? '↑' : '↓'}</button
						>
					{/each}
				</span>
			{/if}
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
	.tools {
		display: flex;
		gap: 0.5rem;
	}
	.move {
		flex: none;
		display: flex;
		gap: 0.25rem;
	}
	.move button {
		min-width: max(2.4rem, var(--tap));
		height: max(2.4rem, var(--tap));
		padding: 0;
	}
	/* a card per habit, as on Today */
	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 0.75rem;
		min-height: 3.5rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 0.75rem;
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
