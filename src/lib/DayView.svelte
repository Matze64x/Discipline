<!--
	A day's habits (today unless another day is chosen): check them off, or enter amounts. ←/→ go
	to the day before or after, t back to today. In the focused list, Space or Enter checks the
	selected habit off (or opens its amount), a digit starts entering an amount, Delete clears it,
	e edits the habit. An amount habit's buttons (and keys): +1 (+), add an amount (a), complete:
	add what's missing to meet the goal (c). A tap on a row (or a click on its mark) does the same
	as Space.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { addDays, addToEntry, entryOn, isActiveOn, progressOn, remainingOf, setEntry, toggleCheck, type CivilDate, type Habit, type Id, type Progress } from '../core';
	import AmountDialog from './AmountDialog.svelte';
	import { attempt } from './attempt';
	import { clock } from './clock.svelte';
	import { describeProgress, formatDate, formatValue, formatWeekday } from './display';
	import { showError } from './notices.svelte';
	import { settings } from './settings.svelte';
	import { shortcuts } from './shortcuts.svelte';
	import SelectableList from './ui/SelectableList.svelte';
	import type { Workspace } from './workspace.svelte';

	let {
		workspace,
		active,
		onnewhabit,
		onedithabit,
	}: { workspace: Workspace; active: boolean; onnewhabit: () => void; onedithabit: (habit: Habit) => void } = $props();

	/** The day shown when it isn't today (null: today, following the clock) */
	let chosen = $state<CivilDate | null>(null);
	const date = $derived(chosen !== null && chosen < clock.today ? chosen : clock.today);
	const isToday = $derived(date === clock.today);

	interface Row {
		readonly habit: Habit;
		readonly progress: Progress;
		/** What's entered on the day: 1 for a check habit, the amount, or null */
		readonly value: number | null;
	}
	const rows = $derived(
		workspace.data.habits.flatMap((habit): Row[] => {
			if (!isActiveOn(habit, date)) return [];
			const progress = progressOn(workspace.data, habit, date, settings.weekStart);
			return progress ? [{ habit, progress, value: entryOn(workspace.data, habit.id, date)?.value ?? null }] : [];
		}),
	);

	let selectedId = $state<Id | null>(null);
	const selected = $derived(rows.find((r) => r.habit.id === selectedId));
	let list: SelectableList<Row, Id>;
	let listElement = $state<HTMLElement>();
	/** The amount dialog: for which habit and day, with the key that opened it (if typed) */
	let entering = $state.raw<{ habit: Habit; date: CivilDate; value: number | null; typed: string | null; adding: boolean } | null>(null);

	// the selected habit isn't on the day shown (another day, archived, deleted): select the first
	// (on a day without any, the selection stays for when the habit shows again)
	$effect(() => {
		if (selectedId !== null && !selected && rows.length > 0) selectedId = rows[0]!.habit.id;
	});

	// (shown right after loading: the list takes the focus, as when switching to this view)
	onMount(() => {
		if (active) list.focus();
	});

	function go(by: number) {
		const next = addDays(date, by);
		chosen = next < clock.today ? next : null;
		// (a clicked button would keep the focus, and Space would act on it instead of the list)
		list.focus();
	}

	function goToday() {
		chosen = null;
		list.focus();
	}

	/** Checks a check habit off (or not), or opens the amount dialog */
	function activate(row: Row | undefined, typed: string | null = null) {
		if (!row) return;
		selectedId = row.habit.id;
		if (row.habit.kind === 'amount') {
			entering = { habit: row.habit, date, value: row.value, typed, adding: false };
			return;
		}
		const { habit } = row;
		const day = date;
		const label = `${row.value === null ? 'Check off' : 'Uncheck'} “${habit.name}”`;
		void attempt(showError, () => workspace.edit(label, (d, now) => toggleCheck(d, habit.id, day, now)));
	}

	function setValue(habit: Habit, day: CivilDate, value: number | null) {
		const label = value === null ? `Clear “${habit.name}”` : `Enter “${habit.name}”`;
		return attempt(showError, () => workspace.edit(label, (d, now) => setEntry(d, habit.id, day, value, now)));
	}

	function add(habit: Habit, day: CivilDate, amount: number, label = `Add ${formatValue(amount)} to “${habit.name}”`) {
		return attempt(showError, () => workspace.edit(label, (d, now) => addToEntry(d, habit.id, day, amount, now)));
	}

	/** Adds what's missing to meet the goal (nothing when it's met, or not due that day) */
	function complete(row: Row) {
		selectedId = row.habit.id;
		const missing = remainingOf(row.progress);
		if (row.habit.kind === 'amount' && row.progress.due && missing > 0) void add(row.habit, date, missing, `Complete “${row.habit.name}”`);
	}

	function openAdd(row: Row) {
		selectedId = row.habit.id;
		entering = { habit: row.habit, date, value: row.value, typed: null, adding: true };
	}

	/** A row's button: acts on its row only (not also as a tap on the row), the list keeps the focus */
	function onButton(e: MouseEvent, row: Row, run: (row: Row) => void) {
		e.stopPropagation();
		selectedId = row.habit.id;
		run(row);
		list.focus();
	}

	function closeAmount() {
		entering = null;
		list.focus();
	}

	$effect(() =>
		shortcuts.add([
			{ keys: ['ArrowLeft'], description: 'The day before', group: 'Day', repeat: true, when: () => active, run: () => go(-1) },
			{ keys: ['ArrowRight'], description: 'The day after', group: 'Day', repeat: true, when: () => active && !isToday, visible: () => active, run: () => go(1) },
			{ keys: ['t'], description: 'Today', group: 'Day', when: () => active && !isToday, visible: () => active, run: goToday },
			{ keys: ['n'], description: 'New habit', group: 'Day', when: () => active, run: onnewhabit },
			// these act on the selection, so only while the list (not a button elsewhere) has the focus
			...[
				{ keys: [' ', 'Enter'], description: 'Check off (again: uncheck), or enter the amount', run: () => activate(selected) },
				{
					keys: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '.'],
					keysLabel: '0–9',
					description: 'Type an amount',
					run: (e: KeyboardEvent) => (selected?.habit.kind === 'amount' ? activate(selected, e.key) : undefined),
				},
				{ keys: ['+'], description: 'Add 1', run: () => selected?.habit.kind === 'amount' && void add(selected.habit, date, 1) },
				{ keys: ['a'], description: 'Add an amount', run: () => selected?.habit.kind === 'amount' && openAdd(selected) },
				{ keys: ['c'], description: 'Complete (add what’s missing)', run: () => selected && complete(selected) },
				{ keys: ['Delete', 'Backspace'], description: 'Clear the day', run: () => selected && void setValue(selected.habit, date, null) },
				{ keys: ['e'], description: 'Edit the habit', run: () => selected && onedithabit(selected.habit) },
			].map((s) => ({ ...s, group: 'Day', focusIn: () => listElement, visible: () => active, when: () => active && !!selected })),
		]),
	);
</script>

<div class="toolbar">
	<button class="nav" aria-label="The day before" title="←" onclick={() => go(-1)}>‹</button>
	<h2>
		{isToday ? 'Today' : date === addDays(clock.today, -1) ? 'Yesterday' : formatWeekday(date)}
		<span class="date">{formatDate(date)}</span>
	</h2>
	<button class="nav" aria-label="The day after" title="→" disabled={isToday} onclick={() => go(1)}>›</button>
	{#if !isToday}<button class="today" title="t" onclick={goToday}>Today</button>{/if}
</div>

<SelectableList
	bind:this={list}
	bind:selected={selectedId}
	bind:element={listElement}
	items={rows}
	key={(r) => r.habit.id}
	label="Habits of the day"
	{active}
	group="Day"
	itemName="habit"
	onopen={(r) => activate(r)}
>
	{#snippet row(r)}
		{@const { habit, progress, value } = r}
		{@const text = describeProgress(progress, habit, clock.today)}
		{@const filled = habit.kind === 'check' || progress.goal.period !== 'day' ? value !== null : progress.met}
		<div class="row" class:off={!progress.due && value === null}>
			<!--
				The mark: a click target for the mouse (a tap on the row does the same). Hidden from
				screen readers, which get the state as text; never focused (then Space would act on it,
				not on the list's selection).
			-->
			<button
				type="button"
				class="mark"
				class:filled
				style:--color={habit.color}
				tabindex="-1"
				aria-hidden="true"
				onmousedown={(e) => e.preventDefault()}
				onclick={(e) => onButton(e, r, activate)}
			>
				{#if habit.kind === 'check'}{value === null ? '' : '✓'}{:else}{formatValue(value ?? 0)}{/if}
			</button>
			<div class="text">
				<span class="name">{habit.name}{#if habit.kind === 'check'}<span class="visually-hidden">{value === null ? ' (not done)' : ' (done)'}</span>{/if}</span>
				{#if text}<span class="progress" class:met={progress.met}>{text}</span>{/if}
			</div>
			{#if habit.kind === 'amount'}
				<!-- (never focused, like the mark: the keys act on the list's selection) -->
				{@const completable = progress.due && !progress.met}
				<span class="actions">
					<button type="button" tabindex="-1" title="Add 1 (+)" aria-label="Add 1" onmousedown={(e) => e.preventDefault()} onclick={(e) => onButton(e, r, (row) => void add(row.habit, date, 1))}>+1</button>
					<button type="button" tabindex="-1" title="Add an amount (a)" aria-label="Add an amount" onmousedown={(e) => e.preventDefault()} onclick={(e) => onButton(e, r, openAdd)}>+</button>
					<button
						type="button"
						tabindex="-1"
						title="Complete (c)"
						aria-label="Complete"
						aria-disabled={!completable}
						onmousedown={(e) => e.preventDefault()}
						onclick={(e) => onButton(e, r, complete)}>✓</button
					>
				</span>
			{/if}
		</div>
	{/snippet}
	{#snippet empty()}
		<div class="empty">
			{#if workspace.data.habits.length > 0}
				<p>Nothing due.</p>
			{:else}
				<p>No habits yet.</p>
				<button class="primary" onclick={onnewhabit}>Add a habit</button>
			{/if}
		</div>
	{/snippet}
</SelectableList>

{#if entering}
	{@const e = entering}
	<AmountDialog
		habit={e.habit}
		date={e.date}
		value={e.value}
		typed={e.typed}
		adding={e.adding}
		onsave={(value) => {
			// (closing clears `entering`, and with it `e`: take what's needed first)
			const { habit, date: day, adding } = e;
			closeAmount();
			if (!adding) void setValue(habit, day, value);
			else if (value !== null) void add(habit, day, value);
		}}
		onclose={closeAmount}
	/>
{/if}

<style>
	.toolbar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 1rem 0.75rem 0.5rem;
	}
	h2 {
		margin: 0;
		font-size: 1.3rem;
		min-width: 9rem;
		text-align: center;
	}
	.date {
		display: block;
		font-size: 0.85rem;
		font-weight: normal;
		color: var(--muted);
	}
	.nav {
		min-width: 2.5rem;
		font-size: 1.3rem;
		line-height: 1;
	}
	.today {
		margin-left: auto;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0.75rem;
	}
	.off {
		opacity: 0.55;
	}
	.mark {
		flex: none;
		min-width: 2.4rem;
		height: 2.4rem;
		padding: 0 0.5rem;
		border-radius: 1.2rem;
		border: 2px solid var(--color);
		background: none;
		color: var(--text);
		font-weight: 600;
	}
	.mark.filled {
		background: var(--color);
		color: #fff;
	}
	/* the name, with the progress below it */
	.text {
		flex: 1 1 auto;
		min-width: 0;
		display: grid;
	}
	.name {
		overflow-wrap: anywhere;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.progress {
		color: var(--muted);
		font-size: 0.85rem;
	}
	.actions {
		flex: none;
		display: flex;
		gap: 0.25rem;
	}
	.actions button {
		min-width: 2.4rem;
		height: 2.4rem;
		padding: 0 0.4rem;
	}
	.actions button[aria-disabled='true'] {
		opacity: 0.4;
	}
	.progress.met {
		color: var(--positive);
	}
	.empty {
		color: var(--muted);
		text-align: center;
		padding: 3rem 1rem;
		display: grid;
		justify-items: center;
		gap: 0.5rem;
	}
	.empty p {
		margin: 0;
	}
</style>
