<!--
	A week at a glance: the habits as rows, the week's days as columns, each row with how the week
	went. In the focused grid the arrow keys (or h/j/k/l) move between days and habits (past the
	week's edge into the week before or after), Space or Enter checks a day off (or opens its
	amount), a digit starts entering an amount, Delete clears the day, + adds 1, a adds an amount,
	c completes the goal, e edits the habit. PageUp/PageDown show the week before/after, t this
	week. A tap or click on a day does the same as Space. Days after today can't be entered.
-->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { addDays, daysMet, entriesBetween, entriesByHabit, entryOn, isActiveOn, progressOn, startOfWeek, weekday, type CivilDate, type Habit, type Id, type Progress } from '../core';
	import AmountDialog from './AmountDialog.svelte';
	import { clock } from './clock.svelte';
	import { describeProgress, formatDate, formatValue, plural, weekdayName, withUnit } from './display';
	import { addToDay, completeDay, setDay, toggleDay } from './entry-actions';
	import { shortcuts } from './shortcuts.svelte';
	import type { Workspace } from './workspace.svelte';

	let {
		workspace,
		active,
		onnewhabit,
		onedithabit,
	}: { workspace: Workspace; active: boolean; onnewhabit: () => void; onedithabit: (habit: Habit) => void } = $props();

	const weekStart = $derived(workspace.data.preferences.weekStart);
	/** A day of the week shown when it isn't this week (null: this week, following the clock) */
	let chosen = $state<CivilDate | null>(null);
	const from = $derived(startOfWeek(chosen !== null && chosen < clock.today ? chosen : clock.today, weekStart));
	const to = $derived(addDays(from, 6));
	const days = $derived(Array.from({ length: 7 }, (_, i) => addDays(from, i)));
	const isThisWeek = $derived(from === startOfWeek(clock.today, weekStart));
	/** The last day that counts so far: the week's end, or today in this week */
	const lastDay = $derived(to < clock.today ? to : clock.today);

	interface Cell {
		readonly date: CivilDate;
		/** The day can be entered: the habit is active then, and it isn't after today */
		readonly open: boolean;
		readonly progress: Progress | null;
		/** What's entered: 1 for a check habit, the amount, or null */
		readonly value: number | null;
	}
	interface Row {
		readonly habit: Habit;
		readonly cells: readonly Cell[];
		/** How the week went, e.g. "4 of 5 days", "2 of 3 this week" */
		readonly summary: string;
	}

	/**
	 * How the week went: for a daily goal the days met, for a weekly one its progress, for a monthly
	 * one what was done in this week (the month reaches past it). By the goal of the week's last
	 * active day so far.
	 */
	function summary(habit: Habit): string {
		let last = lastDay;
		while (last >= from && !isActiveOn(habit, last)) last = addDays(last, -1);
		const progress = last >= from ? progressOn(workspace.data, habit, last, weekStart) : null;
		if (progress?.goal.period === 'week') return describeProgress(progress, habit, clock.today);
		if (progress?.goal.period === 'month') {
			const entries = entriesBetween(entriesByHabit(workspace.data).get(habit.id) ?? [], from, to);
			const done = habit.kind === 'check' ? plural(entries.length, 'day') : withUnit(entries.reduce((sum, e) => sum + e.value, 0), habit.unit);
			return `${done} this week`;
		}
		const { met, due } = daysMet(workspace.data, habit, from, to, clock.today);
		return due === 0 ? '' : `${met} of ${plural(due, 'day')}`;
	}

	const rows = $derived(
		workspace.data.habits.flatMap((habit): Row[] => {
			if (!days.some((d) => isActiveOn(habit, d))) return [];
			const cells = days.map((date): Cell => {
				const progress = progressOn(workspace.data, habit, date, weekStart);
				return { date, open: progress !== null && date <= clock.today, progress, value: entryOn(workspace.data, habit.id, date)?.value ?? null };
			});
			return [{ habit, cells, summary: summary(habit) }];
		}),
	);

	// the selected cell: a habit and a day (kept while moving between weeks)
	let selectedHabit = $state<Id | null>(null);
	let selectedDay = $state<CivilDate | null>(null);
	const rowIndex = $derived(rows.findIndex((r) => r.habit.id === selectedHabit));
	const dayIndex = $derived(selectedDay === null ? -1 : days.indexOf(selectedDay));
	const selected = $derived(rowIndex >= 0 && dayIndex >= 0 ? { row: rows[rowIndex]!, cell: rows[rowIndex]!.cells[dayIndex]! } : undefined);

	// a selection that isn't in the week shown (another week, or the habit isn't in it): the same
	// weekday, today, or the first habit
	$effect(() => {
		if (rows.length === 0) return;
		if (rowIndex < 0) selectedHabit = rows[0]!.habit.id;
		if (dayIndex < 0) selectedDay = isThisWeek ? clock.today : selectedDay !== null ? addDays(from, (weekday(selectedDay) - weekStart + 7) % 7) : lastDay;
	});

	let grid = $state<HTMLElement>();
	/** The amount dialog: for which habit and day, with the key that opened it (if typed) */
	let entering = $state.raw<{ habit: Habit; date: CivilDate; value: number | null; typed: string | null; adding: boolean } | null>(null);

	function focus() {
		void tick().then(() => grid?.focus({ preventScroll: true }));
	}
	onMount(() => {
		if (active) focus();
	});
	let wasActive = false;
	$effect(() => {
		if (active && !wasActive) focus();
		wasActive = active;
	});

	/** Shows the week containing `day` (never past this week) */
	function showWeek(day: CivilDate) {
		chosen = day < startOfWeek(clock.today, weekStart) ? day : null;
	}

	function goWeek(by: number) {
		showWeek(addDays(from, 7 * by));
		if (selectedDay !== null) {
			const day = addDays(selectedDay, 7 * by);
			selectedDay = day > clock.today ? clock.today : day;
		}
		focus();
	}

	function thisWeek() {
		chosen = null;
		selectedDay = clock.today;
		focus();
	}

	/** Moves the selection by days (into the week before or after at the edges; not past today) */
	function moveDay(by: number) {
		if (selectedDay === null) return;
		const day = addDays(selectedDay, by);
		if (day > clock.today) return;
		selectedDay = day;
		if (day < from || day > to) showWeek(day);
	}

	function moveHabit(by: number) {
		if (rows.length === 0) return;
		const index = Math.max(0, Math.min(rows.length - 1, (rowIndex < 0 ? 0 : rowIndex) + by));
		selectedHabit = rows[index]!.habit.id;
	}

	function select(row: Row, cell: Cell) {
		selectedHabit = row.habit.id;
		selectedDay = cell.date;
	}

	/** Checks a day off (or not), or opens its amount */
	function activate(row: Row, cell: Cell, typed: string | null = null) {
		select(row, cell);
		if (!cell.open) return;
		if (row.habit.kind === 'amount') entering = { habit: row.habit, date: cell.date, value: cell.value, typed, adding: false };
		else void toggleDay(workspace, row.habit, cell.date, cell.value !== null);
	}

	function closeAmount() {
		entering = null;
		focus();
	}

	/** Runs `action` on the selected cell if it can be entered */
	function onSelected(action: (row: Row, cell: Cell) => unknown) {
		if (selected?.cell.open) action(selected.row, selected.cell);
	}

	/** The row and cell a click happened in */
	function cellAt(event: MouseEvent): { row: Row; cell: Cell } | undefined {
		const target = (event.target as HTMLElement).closest<HTMLElement>('[data-day]');
		const row = rows.find((r) => r.habit.id === target?.dataset.habit);
		const cell = row?.cells.find((c) => c.date === target?.dataset.day);
		return row && cell ? { row, cell } : undefined;
	}

	// keep the selected cell on screen (below the sticky header)
	$effect(() => {
		if (!selected || !active) return;
		const id = cellId(selected.row.habit.id, selected.cell.date);
		void tick().then(() => {
			const element = document.getElementById(id);
			if (!element) return;
			const rect = element.getBoundingClientRect();
			const top = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
			if (rect.top < top) scrollBy({ top: rect.top - top });
			else if (rect.bottom > document.documentElement.clientHeight) scrollBy({ top: rect.bottom - document.documentElement.clientHeight });
		});
	});

	const cellId = (habit: Id, day: CivilDate) => `week-${habit}-${day}`;

	/** A cell's state in words, for screen readers (moving up or down doesn't announce the row) */
	function cellLabel(row: Row, cell: Cell): string {
		const day = `${row.habit.name}, ${weekdayName(weekday(cell.date))} ${formatDate(cell.date)}`;
		if (!cell.open) return `${day}: ${cell.date > clock.today ? 'still to come' : 'not active'}`;
		if (row.habit.kind === 'check') return `${day}: ${cell.value === null ? 'not done' : 'done'}`;
		return `${day}: ${cell.value === null ? 'nothing' : row.habit.unit ? `${formatValue(cell.value)} ${row.habit.unit}` : formatValue(cell.value)}`;
	}

	$effect(() =>
		shortcuts.add([
			{ keys: ['PageUp'], description: 'The week before', group: 'Week', repeat: true, when: () => active, run: () => goWeek(-1) },
			{ keys: ['PageDown'], description: 'The week after', group: 'Week', repeat: true, when: () => active && !isThisWeek, visible: () => active, run: () => goWeek(1) },
			{ keys: ['t'], description: 'This week', group: 'Week', when: () => active && !isThisWeek, visible: () => active, run: thisWeek },
			{ keys: ['n'], description: 'New habit', group: 'Week', when: () => active, run: onnewhabit },
			// these act on the selection, so only while the grid (not a button elsewhere) has the focus
			...[
				{ keys: ['ArrowLeft', 'h'], description: 'The day before', repeat: true, run: () => moveDay(-1) },
				{ keys: ['ArrowRight', 'l'], description: 'The day after', repeat: true, run: () => moveDay(1) },
				{ keys: ['ArrowUp', 'k'], description: 'The habit above', repeat: true, run: () => moveHabit(-1) },
				{ keys: ['ArrowDown', 'j'], description: 'The habit below', repeat: true, run: () => moveHabit(1) },
				{ keys: ['Home'], description: 'The week’s first day', run: () => (selectedDay = from) },
				{ keys: ['End'], description: 'The week’s last day (so far)', run: () => (selectedDay = lastDay) },
				{ keys: [' ', 'Enter'], description: 'Check off (again: uncheck), or enter the amount', run: () => onSelected((r, c) => activate(r, c)) },
				{
					keys: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '.'],
					keysLabel: '0–9',
					description: 'Type an amount',
					run: (e: KeyboardEvent) => onSelected((r, c) => r.habit.kind === 'amount' && activate(r, c, e.key)),
				},
				{ keys: ['Delete', 'Backspace'], description: 'Clear the day', run: () => onSelected((r, c) => setDay(workspace, r.habit, c.date, null)) },
				{ keys: ['+'], description: 'Add 1', run: () => onSelected((r, c) => r.habit.kind === 'amount' && addToDay(workspace, r.habit, c.date, 1)) },
				{
					keys: ['a'],
					description: 'Add an amount',
					run: () => onSelected((r, c) => r.habit.kind === 'amount' && (entering = { habit: r.habit, date: c.date, value: c.value, typed: null, adding: true })),
				},
				{ keys: ['c'], description: 'Complete (add what’s missing)', run: () => onSelected((r, c) => c.progress && completeDay(workspace, r.habit, c.date, c.progress)) },
				{ keys: ['e'], description: 'Edit the habit', run: () => selected && onedithabit(selected.row.habit) },
			].map((s) => ({ ...s, group: 'Week', focusIn: () => grid, visible: () => active, when: () => active && rows.length > 0 })),
		]),
	);
</script>

<div class="toolbar">
	<button class="nav" aria-label="The week before" title="PageUp" onclick={() => goWeek(-1)}>‹</button>
	<h2>
		{#if isThisWeek || from === startOfWeek(addDays(clock.today, -7), weekStart)}
			{isThisWeek ? 'This week' : 'Last week'}
			<span class="date">{formatDate(from)} – {formatDate(to)}</span>
		{:else}
			<span class="range">{formatDate(from)} – {formatDate(to)}</span>
		{/if}
	</h2>
	<button class="nav" aria-label="The week after" title="PageDown" disabled={isThisWeek} onclick={() => goWeek(1)}>›</button>
	{#if !isThisWeek}<button class="today" title="t" onclick={thisWeek}>This week</button>{/if}
</div>

<!-- (also for an empty week: moving into one keeps the focus here) -->
<!-- svelte-ignore a11y_click_events_have_key_events (the keys are shortcuts, see the registry) -->
<div
		bind:this={grid}
		class="grid"
		role="grid"
		tabindex="0"
		aria-label="Week"
		aria-activedescendant={selected ? cellId(selected.row.habit.id, selected.cell.date) : undefined}
		onclick={(e) => {
			const hit = cellAt(e);
			if (hit) activate(hit.row, hit.cell);
			if (rows.length > 0) focus();
		}}
	>
	{#if rows.length === 0}
		<div class="empty">
			{#if workspace.data.habits.length > 0}
				<p>No habits this week.</p>
			{:else}
				<p>No habits yet.</p>
				<button class="primary" onclick={onnewhabit}>Add a habit</button>
			{/if}
		</div>
	{:else}
		<div class="row head" role="row">
			<span class="name" role="columnheader"><span class="visually-hidden">Habit</span></span>
			{#each days as day (day)}
				<span class="day-head" class:today={day === clock.today} role="columnheader">
					{weekdayName(weekday(day))}<span class="number">{Number(day.slice(8))}</span>
				</span>
			{/each}
		</div>
		{#each rows as row (row.habit.id)}
			<div class="row" role="row">
				<div class="name" role="rowheader">
					<span class="habit">{row.habit.name}</span>
					{#if row.summary}<span class="summary">{row.summary}</span>{/if}
				</div>
				{#each row.cells as cell (cell.date)}
					{@const isSelected = selected?.row === row && selected.cell === cell}
					{@const daily = cell.progress?.goal.period === 'day'}
					{@const filled = cell.value !== null && (row.habit.kind === 'check' || !daily || !!cell.progress?.met)}
					<div
						id={cellId(row.habit.id, cell.date)}
						class="cell"
						class:selected={isSelected}
						role="gridcell"
						aria-selected={isSelected}
						aria-disabled={!cell.open}
						aria-label={cellLabel(row, cell)}
						data-habit={row.habit.id}
						data-day={cell.date}
					>
						{#if cell.open}
							{@const text = row.habit.kind === 'check' ? (cell.value === null ? '' : '✓') : cell.value === null ? '' : formatValue(cell.value)}
							<span class="mark" class:filled class:off={!cell.progress?.due && cell.value === null} class:long={text.length >= 4} class:longer={text.length >= 5} style:--color={row.habit.color}>
								{text}
							</span>
						{:else}
							<span class="none">·</span>
						{/if}
					</div>
				{/each}
			</div>
		{/each}
	{/if}
</div>

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
			if (!adding) void setDay(workspace, habit, day, value);
			else if (value !== null) void addToDay(workspace, habit, day, value);
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
	.range {
		font-size: 1rem;
	}
	.nav {
		min-width: 2.5rem;
		font-size: 1.3rem;
		line-height: 1;
	}
	.today {
		margin-left: auto;
	}
	/* (on wide screens the days stay close to the names) */
	.grid {
		padding: 0 0.5rem;
		max-width: 44rem;
	}
	.grid:focus-visible {
		/* the selected cell shows the focus instead */
		outline: none;
	}
	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) repeat(7, 2.6rem);
		align-items: center;
		border-bottom: 1px solid var(--border);
		min-height: 3rem;
	}
	.row.head {
		min-height: 2.5rem;
		border-bottom: none;
	}
	.name {
		display: grid;
		min-width: 0;
		padding: 0.35rem 0.5rem 0.35rem 0.25rem;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.habit {
		overflow-wrap: break-word;
		hyphens: auto;
		min-width: 0;
	}
	.summary {
		color: var(--muted);
		font-size: 0.8rem;
	}
	.day-head {
		display: grid;
		justify-items: center;
		font-size: 0.75rem;
		color: var(--muted);
	}
	.day-head .number {
		font-size: 0.95rem;
		color: var(--text);
	}
	.day-head.today .number {
		color: var(--accent);
		font-weight: 700;
	}
	.cell {
		display: grid;
		place-items: center;
		height: 2.75rem;
		border-radius: 0.5rem;
		cursor: pointer;
	}
	.cell[aria-disabled='true'] {
		cursor: default;
	}
	.cell.selected {
		background: var(--accent-soft);
	}
	.grid:focus .cell.selected {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.mark {
		display: grid;
		place-items: center;
		min-width: 2rem;
		height: 2rem;
		padding: 0 0.2rem;
		border-radius: 1rem;
		border: 2px solid var(--color);
		font-size: 0.75rem;
		font-weight: 600;
		line-height: 1;
		box-sizing: border-box;
	}
	/* (longer amounts get smaller, so they stay in their column) */
	.mark.long {
		font-size: 0.65rem;
		padding: 0 0.1rem;
	}
	.mark.longer {
		font-size: 0.55rem;
		letter-spacing: -0.02em;
	}
	.mark.filled {
		background: var(--color);
		color: #fff;
	}
	.mark.off {
		opacity: 0.35;
	}
	.none {
		color: var(--muted);
		opacity: 0.6;
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
	@media (max-width: 40rem) {
		.row {
			grid-template-columns: minmax(0, 1fr) repeat(7, 2.35rem);
		}
		.grid {
			padding: 0 0.25rem;
		}
	}
</style>
