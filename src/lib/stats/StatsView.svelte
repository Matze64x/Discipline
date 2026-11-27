<!--
	Stats (g s): how many goals were met per week (the last 26 weeks), then each habit with its rate
	over the last 30 days (12 weeks or months for weekly or monthly goals) and its last 26 weeks as
	squares. Opening a habit (tap, Enter) shows its details (`HabitStats`); Escape goes back.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import {
		addDays,
		addMonths,
		dateParts,
		latestGoal,
		periodResults,
		rateOf,
		startOfWeek,
		weekShares,
		type CivilDate,
		type Habit,
		type Id,
	} from '../../core';
	import { clock } from '../clock.svelte';
	import { describeGoal, formatMonth, formatShortDate } from '../display';
	import { shortcuts } from '../shortcuts.svelte';
	import SelectableList from '../ui/SelectableList.svelte';
	import type { Workspace } from '../workspace.svelte';
	import { accentStyle } from '../palette';
	import HabitStats from './HabitStats.svelte';
	import WeekDots from './WeekDots.svelte';
	import WeekLine from './WeekLine.svelte';

	let { workspace, active }: { workspace: Workspace; active: boolean } = $props();

	const WEEKS = 26;
	const data = $derived(workspace.data);
	const today = $derived(clock.today);
	const weekStart = $derived(data.preferences.weekStart);
	const weeks = $derived(Array.from({ length: WEEKS }, (_, i) => addDays(startOfWeek(today, weekStart), (i - WEEKS + 1) * 7)));
	const habits = $derived([...data.habits.filter((h) => h.archived === null), ...data.habits.filter((h) => h.archived !== null)]);

	const shares = $derived(weekShares(data, weeks, weekStart, today));
	const thisWeek = $derived(shares.at(-1)!);
	const points = $derived(
		weeks.map((w, i) => {
			const { met, counted } = shares[i]!;
			// a month's name under the week its first day falls in
			const first = dateParts(addDays(w, 6)).day <= 7;
			return {
				key: w,
				value: counted ? met / counted : null,
				label: first ? formatMonth(addDays(w, 6)) : null,
				info: `Week of ${formatShortDate(w)}: ${counted ? `${met} of ${counted} goals met` : 'no goals'}`,
			};
		}),
	);
	/** The weeks' average share, in % (null: nothing counted) */
	const average = $derived.by(() => {
		const counted = shares.filter((s) => s.counted > 0);
		return counted.length ? Math.round((counted.reduce((sum, s) => sum + s.met / s.counted, 0) / counted.length) * 100) : null;
	});
	let weekInfo = $state<string | null>(null);
	// a tapped week's text would go stale when the data or the day changes
	$effect.pre(() => {
		void [data, today];
		weekInfo = null;
	});

	/** A habit's rate over its recent periods ("87 %") and over what ("last 30 days"); null: nothing to count yet */
	function recentRate(habit: Habit): { rate: string; span: string } | null {
		const end = habit.archived !== null && habit.archived <= today ? addDays(habit.archived, -1) : today;
		const period = latestGoal(habit).period;
		const [from, span] =
			period === 'day' ? [addDays(end, -29), '30 days'] : period === 'week' ? [addDays(startOfWeek(end, weekStart), -77), '12 weeks'] : [addMonths(end, -11), '12 months'];
		const { met, counted } = rateOf(periodResults(data, habit, from as CivilDate, end, weekStart, today));
		return counted ? { rate: `${Math.round((met / counted) * 100)} %`, span: `last ${span}` } : null;
	}

	let selectedId = $state<Id | null>(null);
	let openId = $state<Id | null>(null);
	const open = $derived(habits.find((h) => h.id === openId) ?? null);
	// a habit deleted meanwhile (sync, another tab): back to the overview for good
	$effect.pre(() => {
		if (openId !== null && open === null) openId = null;
	});
	let list = $state<SelectableList<Habit, Id>>();
	let listElement = $state<HTMLElement>();

	/** Where the overview was scrolled to, for coming back */
	let overviewScroll = 0;
	function show(habit: Habit) {
		overviewScroll = window.scrollY;
		openId = habit.id;
		void tick().then(() => window.scrollTo(0, 0));
	}
	// the list is made when the tab is shown: give it the focus like the other views' lists
	$effect(() => {
		if (active && !untrack(() => openId)) list?.focus();
	});
	// a tab comes back fresh (user 2026-11-25): the overview, not the habit opened last
	$effect(() => {
		if (!active) untrack(() => (openId = null));
	});
	function back() {
		openId = null;
		list?.focus();
		void tick().then(() => window.scrollTo(0, overviewScroll));
	}

	$effect(() =>
		shortcuts.add([
			{ keys: ['Escape'], description: 'Back to all habits', group: 'Stats', when: () => active && open !== null, run: back },
		]),
	);
</script>

<!-- only computed while shown: the numbers cover all the data -->
{#if active && open}
	<HabitStats {workspace} habit={open} onback={back} />
{/if}
{#if active}
<div class="page" hidden={open !== null}>
	<div>
		<div class="toolbar"><h2>Stats</h2></div>
		<section class="card">
			<div class="headline">
				<b>{thisWeek.counted ? `${Math.round((thisWeek.met / thisWeek.counted) * 100)} %` : '–'}</b>
				<span>of the goals met this week{thisWeek.counted ? ` (${thisWeek.met} of ${thisWeek.counted})` : ''}</span>
			</div>
			<WeekLine {points} label={`Goals met per week, the last 26 weeks${average === null ? '' : `: ${average} % on average`}`} oninfo={(i) => (weekInfo = i)} />
			<p class="info" aria-live="polite">{weekInfo ?? 'Tap a week to see it.'}</p>
		</section>
	</div>
	<SelectableList
		bind:this={list}
		bind:selected={selectedId}
		bind:element={listElement}
		items={habits}
		key={(h) => h.id}
		label="Habit stats"
		active={active && open === null}
		group="Stats"
		itemName="habit"
		onopen={show}
		showSelection={false}
		cards
	>
		{#snippet row(h)}
			<!-- (its squares in its color) -->
			{@const recent = recentRate(h)}
			<div class="habit" class:archived={h.archived !== null} style={accentStyle(h.color)}>
				<!-- the name and goal on the left, the recent rate and over what on the right (the squares
				     below cover the last 26 weeks, with their months under them) -->
				<div class="head">
					<span class="dot" style:background={h.color}></span>
					<span class="title">{h.name}</span>
					<span class="rate">{recent?.rate ?? '–'}</span>
					<span class="goal">{h.archived !== null ? 'Archived' : describeGoal(latestGoal(h), h)}</span>
					<span class="span">{recent?.span ?? 'Nothing to count yet'}</span>
				</div>
				<WeekDots {data} habit={h} {weeks} {today} />
			</div>
		{/snippet}
		{#snippet empty()}
			<p class="empty">No habits yet.</p>
		{/snippet}
	</SelectableList>
</div>
{/if}

<style>
	.page {
		max-width: 30rem;
	}
	.toolbar {
		padding: 1rem 0.75rem 0.5rem;
	}
	h2 {
		margin: 0;
		font-size: 1.3rem;
	}
	.card {
		margin: 0 0.75rem 0.75rem;
		padding: 0.75rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 0.75rem;
	}
	.headline {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-bottom: 0.4rem;
		flex-wrap: wrap;
	}
	.headline b {
		font-size: 1.8rem;
		line-height: 1;
	}
	.headline span,
	.info {
		color: var(--muted);
		font-size: 0.85rem;
	}
	.info {
		margin: 0.3rem 0 0;
		min-height: 1.3em;
	}
	/* a card per habit, as on Today */
	.habit {
		display: grid;
		gap: 0.4rem;
		padding: 0.6rem 0.75rem 0.7rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 0.75rem;
	}
	.archived {
		opacity: 0.6;
	}
	.head {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		column-gap: 0.6rem;
	}
	.dot {
		width: 0.8rem;
		height: 0.8rem;
		border-radius: 50%;
		flex: none;
	}
	.title {
		min-width: 0;
		overflow-wrap: anywhere;
		font-weight: 600;
	}
	.rate {
		font-weight: 700;
		text-align: right;
	}
	.goal,
	.span {
		color: var(--muted);
		font-size: 0.8rem;
	}
	/* (under the name, not under the dot) */
	.goal {
		grid-column: 2;
	}
	.span {
		text-align: right;
	}
	.empty {
		color: var(--muted);
		text-align: center;
		padding: 3rem 1rem;
	}
</style>
