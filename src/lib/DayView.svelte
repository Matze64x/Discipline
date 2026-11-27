<!--
	A day's habits (today unless another day is picked): check them off, or enter amounts. Above
	them the week (or, expanded, the month) of that day, to pick another; ‹ › (Shift+←/→) move by
	a week or month, ←/→ by a day, Today (t) back to today, m expands or collapses the month.
	Each habit shows how its period goes: a daily goal its week as dots (done, missed, not due,
	still open), a weekly or monthly one a bar whose border shows how far the period has run and
	whose fill how far the habit is. In the focused list, Space or Enter checks the
	selected habit off (or opens its amount), a digit starts entering an amount, Delete clears it,
	e edits the habit. An amount habit's buttons (and keys): +1 (+), add an amount (a); complete
	(add what's missing to meet the goal) is in the amount dialog, and c. A click on a row's mark does the same as Space.
	A tap on a row (or f) focuses its habit: the days above show only how it did, in its color, while
	paging and across tabs; a tap again (or Escape) shows all habits again (user design 2026-11-25:
	a tap on a row must not open the amount dialog).
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import {
		addDays,
		addMonths,
		dayCell,
		dayMarks,
		dayShare,
		entryOn,
		isActiveOn,
		progressOn,
		remainingOf,
		startOfMonth,
		startOfWeek,
		timeShare,
		WEEKDAYS,
		type CivilDate,
		type Habit,
		type Id,
		type Progress,
		type Weekday,
	} from '../core';
	import AmountDialog from './AmountDialog.svelte';
	import { clock } from './clock.svelte';
	import DayStrip from './DayStrip.svelte';
	import ProgressRing from './ProgressRing.svelte';
	import { describeDayAmount, formatDate, formatMonth, formatShortDate, formatValue, withUnit } from './display';
	import { formatShort } from './short-number';
	import { textOn } from './palette';
	import { settings } from './settings.svelte';
	import { addToDay, canComplete, completeDay, setDay, toggleDay } from './entry-actions';
	import { swipe } from './ui/swipe';
	import { touchFirst } from './pointer';
	import { describeCell } from './stats/cells';
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
	const weekStart = $derived(workspace.data.preferences.weekStart);
	/** The days of `date`'s week */
	const week = $derived(Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(date, weekStart), i)));
	const weekdays = $derived<readonly Weekday[]>(weekStart === 7 ? [7, 1, 2, 3, 4, 5, 6] : WEEKDAYS);
	/** The days above the habits: the week, or the month (whole weeks; other months' days blank) */
	const shownDays = $derived.by((): (CivilDate | null)[] => {
		if (!settings.showMonth) return week;
		const first = startOfMonth(date);
		const next = addMonths(first, 1);
		const days: (CivilDate | null)[] = [];
		for (let d = startOfWeek(first, weekStart); d < next || days.length % 7 !== 0; d = addDays(d, 1)) days.push(d >= first && d < next ? d : null);
		return days;
	});
	/** The week's dates for the heading, with the year if it isn't this year's */
	const weekRange = $derived.by(() => {
		const thisYear = (d: CivilDate) => d.slice(0, 4) === clock.today.slice(0, 4);
		const show = (d: CivilDate) => (thisYear(d) ? formatShortDate(d) : formatDate(d));
		return `${show(week[0]!)} – ${show(week[6]!)}`;
	});
	/** The day of the month picked last: paging by months comes back to it (Mar 31 → Feb 28 → Mar 31) */
	let monthDay = 0;

	interface Row {
		readonly habit: Habit;
		readonly progress: Progress;
		/** What's entered on the day: 1 for a check habit, the amount, or null */
		readonly value: number | null;
	}
	const rows = $derived(
		workspace.data.habits.flatMap((habit): Row[] => {
			if (!isActiveOn(habit, date)) return [];
			const progress = progressOn(workspace.data, habit, date, workspace.data.preferences.weekStart);
			return progress ? [{ habit, progress, value: entryOn(workspace.data, habit.id, date)?.value ?? null }] : [];
		}),
	);

	/** The habit whose days the strip shows (null: all habits') */
	let focusedId = $state<Id | null>(null);
	const focused = $derived(workspace.data.habits.find((h) => h.id === focusedId) ?? null);
	// deleted (also by a sync): all habits again, for good
	$effect(() => {
		if (focusedId !== null && !focused) focusedId = null;
	});
	function toggleFocus(habit: Habit) {
		selectedId = habit.id;
		focusedId = focusedId === habit.id ? null : habit.id;
	}
	/**
	 * A day's ring above: all habits' daily goals met, or how the focused habit did (its goal's share
	 * done; a limit: what's left of its allowance; none on days it doesn't count or isn't due)
	 */
	function ring(day: CivilDate): { fill: number; text: string } | null {
		if (!focused) {
			const { met, due } = dayShare(workspace.data, day, clock.today);
			return due > 0 ? { fill: met / due, text: `${met} of ${due} done` } : null;
		}
		const cell = dayCell(workspace.data, focused, day, clock.today);
		if (cell.state === 'inactive' || cell.state === 'notDue') return null;
		return { fill: cell.fill, text: describeCell(cell, day, focused, clock.today).replace(/^[^:]*: /, '') };
	}

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

	/** Shows `day` (today at the latest) */
	function show(day: CivilDate, keepMonthDay = false) {
		chosen = day < clock.today ? day : null;
		if (!keepMonthDay) monthDay = Number(date.slice(8));
		// (a clicked button would keep the focus, and Space would act on it instead of the list)
		list.focus();
	}

	const go = (by: number) => show(addDays(date, by));
	/** The week or month before or after */
	function page(by: number) {
		if (!settings.showMonth) return show(addDays(date, 7 * by));
		const wanted = monthDay || Number(date.slice(8));
		// (addMonths stops at the month's last day)
		const target = addMonths(date.slice(0, 8) + '01' as CivilDate, by);
		show(addDays(target, Math.min(wanted, Number(addDays(addMonths(target, 1), -1).slice(8))) - 1), true);
	}

	// a tab comes back fresh (user 2026-11-25): today, all habits (the month view is a setting)
	$effect(() => {
		if (active) return;
		chosen = null;
		monthDay = 0;
		focusedId = null;
	});

	function toggleMonth() {
		settings.showMonth = !settings.showMonth;
		list.focus();
	}

	function goToday() {
		chosen = null;
		monthDay = 0;
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
		void toggleDay(workspace, row.habit, date, row.value !== null);
	}

	const setValue = (habit: Habit, day: CivilDate, value: number | null) => setDay(workspace, habit, day, value);
	const add = (habit: Habit, day: CivilDate, amount: number) => addToDay(workspace, habit, day, amount);

	/** Adds what's missing to meet the goal (nothing when it's met, or not due that day) */
	function complete(row: Row) {
		selectedId = row.habit.id;
		void completeDay(workspace, row.habit, date, row.progress, row.value);
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
			{ keys: ['Shift+ArrowLeft'], description: 'The week (or month) before', group: 'Day', repeat: true, when: () => active, run: () => page(-1) },
			{ keys: ['Shift+ArrowRight'], description: 'The week (or month) after', group: 'Day', repeat: true, when: () => active && !isToday, visible: () => active, run: () => page(1) },
			{ keys: ['m'], description: 'Show the month (or the week)', group: 'Day', when: () => active, run: toggleMonth },
			{ keys: ['t'], description: 'Today', group: 'Day', when: () => active && !isToday, visible: () => active, run: goToday },
			{ keys: ['n'], description: 'New habit', group: 'Day', when: () => active, run: onnewhabit },
			{ keys: ['Escape'], description: 'Show all habits’ days again', group: 'Day', when: () => active && focusedId !== null, visible: () => active, run: () => (focusedId = null) },
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
				{ keys: ['f'], description: 'Show only its days above (again: all habits’)', run: () => selected && toggleFocus(selected.habit) },
			].map((s) => ({ ...s, group: 'Day', focusIn: () => listElement, visible: () => active, when: () => active && !!selected })),
		]),
	);
</script>

<!-- (on wide screens the days stay together; a swipe pages like ‹ ›, never past today, and only the days follow the finger) -->
<div class="calendar" use:swipe={{ go: page, can: (by) => by < 0 || !isToday, moves: '[role=group]' }}>
<div class="toolbar">
	<button class="nav" aria-label={settings.showMonth ? 'The month before' : 'The week before'} title="Shift+←" onclick={() => page(-1)}>‹</button>
	<h2>{settings.showMonth ? formatMonth(date, { month: 'short', year: 'numeric' }) : weekRange}</h2>
	<button class="nav" aria-label={settings.showMonth ? 'The month after' : 'The week after'} title="Shift+→" disabled={isToday} onclick={() => page(1)}>›</button>
	<button class="go-today" title="t" disabled={isToday} onclick={goToday}>Today</button>
	<button class="month" aria-label="Month" aria-pressed={settings.showMonth} title="Month (m)" onclick={toggleMonth}>
		<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
	</button>
</div>
<DayStrip days={shownDays} {weekdays} selected={date} today={clock.today} {ring} color={focused?.color ?? null} onselect={show} />
<!-- the focused habit has no row to tap on this day (not started, archived): it's named here instead -->
{#if focused && !rows.some((r) => r.habit.id === focused.id)}
	<button class="focus-chip" style:--color={focused.color} aria-label={`Show all habits’ days, not only “${focused.name}”’s`} onclick={() => ((focusedId = null), list.focus())}
		>{focused.name} ×</button
	>
{/if}
</div>

<!-- (as wide as the days above: on a wide screen a row's progress would be far from its name) -->
<div class="day-list">
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
	onopen={(r) => toggleFocus(r.habit)}
	showSelection={!touchFirst}
	cards
>
	{#snippet row(r)}
		{@const { habit, progress, value } = r}
		{@const daily = progress.goal.period === 'day'}
		{@const limit = progress.goal.aim === 'limit'}
		<!--
			The mark's ring closes as the day fills, as the days' rings above do for a focused habit
			(dayCell; a weekly or monthly goal: against a day's share of it), and the mark fills once
			the day is done. A limit's ring is what's left of the allowance: full while nothing is
			entered, emptier with each amount; never filled (an entry of a yes/no limit is a slip, ✗).
		-->
		{@const cell = dayCell(workspace.data, habit, date, clock.today)}
		{@const filled = !limit && cell.fill >= 1}
		<!-- the mark stays a circle: a long amount is written short, and smaller -->
		{@const markText = habit.kind === 'check' ? (value === null ? '' : limit ? '✗' : '✓') : formatShort(value ?? 0)}
		{@const progressText = daily
			? habit.kind === 'amount'
				? describeDayAmount(progress, habit)
				: ''
			: habit.kind === 'check'
				? `${progress.done} / ${limit ? 'max ' : ''}${progress.target}`
				: `${formatValue(progress.done)} / ${limit ? 'max ' : ''}${withUnit(progress.target, habit.unit)}`}
		<div class="row" class:off={!progress.due && value === null} class:focused={focusedId === habit.id} style:--color={habit.color}>
			<!--
				The mark: checks off or opens the amount (Space does the same; a tap on the row focuses). Hidden from
				screen readers, which get the state as text; never focused (then Space would act on it,
				not on the list's selection).
			-->
			<button
				type="button"
				class="mark"
				class:filled
				style:--color={habit.color}
				style:--on-color={textOn(habit.color)}
				style:font-size={markText.length <= 2 ? null : markText.length === 3 ? '0.9rem' : markText.length === 4 ? '0.78rem' : '0.68rem'}
				tabindex="-1"
				aria-hidden="true"
				onmousedown={(e) => e.preventDefault()}
				onclick={(e) => onButton(e, r, activate)}
			>
				<ProgressRing fill={filled ? 0 : cell.fill} />
				<span class="mark-text">{markText}</span>
			</button>
			<div class="text">
				<span class="head">
				<span class="name">{habit.name}{#if habit.kind === 'check'}<span class="visually-hidden">{limit ? (value === null ? ' (kept)' : ' (slipped)') : value === null ? ' (not done)' : ' (done)'}</span>{/if}{#if focusedId === habit.id}<span class="visually-hidden">{' (its days shown above)'}</span>{/if}</span>
				{#if progressText}<span class="progress" class:met={progress.met && !limit} class:over={limit && !progress.met}>{progressText}</span>{/if}
				</span>
				{#if daily}
					{@const marks = dayMarks(workspace.data, habit, week, clock.today)}
					<!-- each day's ring closes as the mark's does (done: filled, missed: crossed out too) -->
					<span class="dots">
						<span class="visually-hidden">{`Week: ${marks.filter((m) => m === 'done').length} ${limit ? 'kept' : 'done'}, ${marks.filter((m) => m === 'missed').length} ${limit ? 'slipped' : 'missed'}.`}</span>
						{#each week as day, i (day)}
							{@const mark = marks[i]}
							{@const solid = mark === 'done' && !limit}
							<span class={`dot ${mark}`} class:solid class:current={day === date} class:today={day === clock.today} style:--color={habit.color} aria-hidden="true"
								>{#if mark !== 'off' && !solid}<ProgressRing fill={dayCell(workspace.data, habit, day, clock.today).fill} width={day === clock.today && mark === 'open' ? 9 : 7} />{/if}</span
							>
						{/each}
					</span>
				{:else}
					{@const time = timeShare(progress, clock.today)}
					<!-- (a limit of 0: anything is all of it) -->
					{@const used = progress.target > 0 ? Math.min(1, progress.done / progress.target) : progress.done > 0 ? 1 : 0}
					<span class="period">
						<span class="label">{progress.goal.period === 'week' ? 'Week' : 'Month'}</span>
						<span
							class="bar"
							role="img"
							class:over={limit && !progress.met}
							aria-label={`${Math.round(used * 100)}% ${limit ? 'of the limit used' : 'done'}, ${Math.round(time * 100)}% of the ${progress.goal.period} gone`}
							style:--color={habit.color}
							style:--time={`${time * 100}%`}
							style:--done={used}
						><span class="fill"></span></span>
					</span>
				{/if}
			</div>
			<!-- (never focused, like the mark: the keys act on the list's selection) -->
			{#if habit.kind === 'amount'}
				<span class="actions">
					<button type="button" tabindex="-1" title="Add 1 (+)" aria-label="Add 1" onmousedown={(e) => e.preventDefault()} onclick={(e) => onButton(e, r, (row) => void add(row.habit, date, 1))}>+1</button>
					<button type="button" tabindex="-1" title="Add an amount (a)" aria-label="Add an amount" onmousedown={(e) => e.preventDefault()} onclick={(e) => onButton(e, r, openAdd)}>+</button>
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
</div>

{#if entering}
	{@const e = entering}
	{@const amountProgress = progressOn(workspace.data, e.habit, e.date, workspace.data.preferences.weekStart)}
	<AmountDialog
		habit={e.habit}
		date={e.date}
		value={e.value}
		typed={e.typed}
		adding={e.adding}
		progress={amountProgress}
		remaining={amountProgress && canComplete(e.habit, amountProgress, e.value) ? remainingOf(amountProgress) : 0}
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
	.calendar,
	.day-list {
		max-width: 30rem;
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.75rem 0.5rem 0.4rem;
	}
	h2 {
		margin: 0;
		font-size: 1rem;
		min-width: 0;
		flex: 0 1 auto;
		padding: 0 0.25rem;
		text-align: center;
		white-space: nowrap;
	}
	.month {
		display: grid;
		place-items: center;
		min-width: 2.75rem;
		padding: 0;
	}
	.month svg {
		width: 1.25rem;
		height: 1.25rem;
		transition: transform 0.15s;
	}
	.month[aria-pressed='true'] svg {
		transform: rotate(180deg);
	}
	.nav {
		min-width: 2.75rem;
		font-size: 1.3rem;
		line-height: 1;
	}
	.go-today {
		margin-left: auto;
	}
	.toolbar button {
		min-height: 2.75rem;
	}
	/* a daily goal's week: each day a ring closing as it fills (ProgressRing): done (filled), missed
	   (grey, crossed out), not due (a small dim dot), still open (in the habit's color) */
	.dots {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		/* (as tall as a bar's line) */
		min-height: 1rem;
	}
	.dot {
		position: relative;
		flex: none;
		width: 0.8rem;
		height: 0.8rem;
		border-radius: 50%;
		--ring-color: var(--color);
		--ring-track: color-mix(in srgb, var(--color) 30%, transparent);
	}
	.dot.solid {
		background: var(--color);
	}
	/* (a smaller dot drawn inside the same box: scaling the box would leave uneven gaps) */
	.dot.off {
		border: none;
		background: radial-gradient(circle, var(--color) 0 45%, transparent 47%);
		opacity: 0.5;
	}
	.dot.missed {
		--ring-track: color-mix(in srgb, var(--muted) 45%, transparent);
	}
	.dot.missed::after {
		content: '';
		position: absolute;
		left: -0.1rem;
		right: -0.1rem;
		top: calc(50% - 1px);
		height: 2px;
		background: var(--muted);
		transform: rotate(-45deg);
	}
	.dot.current {
		outline: 2px solid var(--text);
		outline-offset: 1px;
	}
	/* a weekly or monthly goal: the border shows how far the period has run, the fill how far the habit is */
	.period {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 1rem;
	}
	/* (fixed: the bars of weeks and months start at the same place) */
	.label {
		flex: none;
		width: 3.4rem;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
	}
	/* (the same length on every row, with or without buttons: fits next to them on a phone) */
	.bar {
		position: relative;
		flex: 0 1 7rem;
		height: 0.75rem;
	}
	/* the border: all of it light, and the part for the time gone dark on top of it (cut to --time) */
	.bar::before,
	.bar::after {
		content: '';
		position: absolute;
		inset: 0;
		border: 2px solid var(--border);
		border-radius: 0.375rem;
	}
	.bar::after {
		border-color: var(--text);
		clip-path: inset(0 calc(100% - var(--time)) 0 0);
	}
	.fill {
		position: absolute;
		left: 2px;
		top: 2px;
		bottom: 2px;
		width: calc((100% - 4px) * var(--done));
		border-radius: 0.25rem;
		background: var(--color);
	}
	.focus-chip {
		display: block;
		margin: 0.25rem auto 0;
		min-height: var(--tap);
		padding: 0.2rem 0.8rem;
		border: 2px solid var(--color);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color) 12%, transparent);
		font-size: 0.9rem;
	}
	/* a card per habit */
	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.55rem 0.7rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 0.75rem;
	}
	/* the habit whose days the strip shows: its color, as the rings */
	.row.focused {
		background: color-mix(in srgb, var(--color) 12%, var(--surface));
		border-color: var(--color);
		box-shadow: inset 4px 0 0 var(--color);
	}
	.off {
		opacity: 0.55;
	}
	.mark {
		flex: none;
		width: max(2.4rem, var(--tap));
		height: max(2.4rem, var(--tap));
		padding: 0;
		overflow: hidden;
		white-space: nowrap;
		border-radius: 999px;
		border: none;
		background: none;
		color: var(--text);
		font-weight: 600;
		position: relative;
		--ring-color: var(--color);
		--ring-track: color-mix(in srgb, var(--color) 30%, transparent);
	}
	.mark-text {
		position: relative;
	}
	.mark.filled {
		background: var(--color);
		color: var(--on-color);
	}
	/* the name and its progress, the dots or bar below (all starting at the same place) */
	.text {
		flex: 1 1 auto;
		min-width: 0;
		display: grid;
		gap: 0.3rem;
	}
	/* the progress goes to a line of its own (still right-aligned) when it doesn't fit next to the name */
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		column-gap: 0.5rem;
	}
	.name {
		flex: 1 1 6rem;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.head .progress {
		margin-left: auto;
		min-width: 0;
		text-align: right;
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
		min-width: max(2.4rem, var(--tap));
		height: max(2.4rem, var(--tap));
		padding: 0 0.4rem;
	}
	.progress.met {
		color: var(--positive);
	}
	.progress.over {
		color: var(--negative);
	}
	.bar.over .fill {
		background: var(--negative);
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
