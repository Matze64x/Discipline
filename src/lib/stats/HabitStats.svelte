<!--
	One habit's stats over 3 months, a year or all its time: goals met (limits kept), days done (slips) (and the total of
	an amount), a calendar of small months, and how often it's done per weekday (yes/no habits) or
	the totals per week or month against the goal (amounts). A tap on a day or bar tells its numbers.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import {
		addDays,
		addMonths,
		amountBuckets,
		dateParts,
		dayCell,
		entriesBetween,
		entriesByHabit,
		latestGoal,
		periodResults,
		rateOf,
		startOf,
		startOfMonth,
		startOfWeek,
		weekday,
		weekdayShares,
		type CivilDate,
		type Habit,
		type Weekday,
		WEEKDAYS,
	} from '../../core';
	import { clock } from '../clock.svelte';
	import { describeGoal, formatDate, formatMonth, formatShortDate, formatValue, weekdayName, withUnit } from '../display';
	import type { Workspace } from '../workspace.svelte';
	import BarChart, { type Bar } from './BarChart.svelte';
	import { cellLook, describeCell } from './cells';
	import { niceTicks } from './scale';

	let { workspace, habit, onback }: { workspace: Workspace; habit: Habit; onback: () => void } = $props();

	const RANGES = [
		{ id: 'quarter', label: '3 months' },
		{ id: 'year', label: 'Year' },
		{ id: 'all', label: 'All' },
	] as const;
	let range = $state<(typeof RANGES)[number]['id']>('year');
	let dayInfo = $state<string | null>(null);
	let chartInfo = $state<string | null>(null);
	let backButton: HTMLButtonElement;
	// the list that had the focus is hidden now
	onMount(() => backButton.focus({ preventScroll: true }));

	const data = $derived(workspace.data);
	const weekStart = $derived(data.preferences.weekStart);
	const weekdays = $derived<readonly Weekday[]>(weekStart === 7 ? [7, 1, 2, 3, 4, 5, 6] : WEEKDAYS);
	const today = $derived(clock.today);
	/** The last day that counts: today, or the day before the archive day */
	const end = $derived(habit.archived !== null && habit.archived <= today ? addDays(habit.archived, -1) : today);
	const firstMonth = $derived(startOfMonth(startOf(habit)));
	// tapped texts would go stale when the data or the day changes
	$effect.pre(() => {
		void [data, today];
		dayInfo = chartInfo = null;
	});
	const from = $derived.by(() => {
		const back = range === 'quarter' ? 2 : range === 'year' ? 11 : null;
		const wanted = back === null ? firstMonth : startOfMonth(addMonths(end, -back));
		return wanted > firstMonth ? wanted : firstMonth;
	});
	const months = $derived.by(() => {
		const list: CivilDate[] = [];
		for (let m = from; m <= end; m = addMonths(m, 1)) list.push(m);
		return list;
	});

	/** The latest goal limits (the texts follow it; past goals may have built) */
	const limit = $derived(latestGoal(habit).aim === 'limit');
	const rate = $derived(rateOf(periodResults(data, habit, from, end, weekStart, today)));
	const entries = $derived(entriesBetween(entriesByHabit(data).get(habit.id) ?? [], from, end));
	const total = $derived(entries.reduce((sum, e) => sum + e.value, 0));

	function monthLabel(m: CivilDate): string {
		const { year, month } = dateParts(m);
		return month === 1 || m === months[0] && year !== dateParts(today).year ? formatMonth(m, { year: '2-digit' }) : formatMonth(m);
	}
	/** A month's days, after blanks for the weekdays before its first */
	function monthDays(m: CivilDate): (CivilDate | null)[] {
		const days: (CivilDate | null)[] = Array(weekdays.indexOf(weekday(m))).fill(null);
		for (let d = m; d < addMonths(m, 1); d = addDays(d, 1)) days.push(d);
		return days;
	}
	/**
	 * A month of the calendar for screen readers: "November 2026: met on 20 of 25 days", for weekly
	 * or monthly goals "done on 8 days" (limits: "kept", "slipped", amounts "logged"). The words
	 * follow the latest goal, like the legend.
	 */
	function monthSummary(m: CivilDate): string {
		let [met, judged, free] = [0, 0, 0];
		for (const d of monthDays(m)) {
			if (d === null) continue;
			const cell = dayCell(data, habit, d, today);
			if (cell.state === 'met' || cell.state === 'missed') judged++;
			if (cell.state === 'met') met++;
			if (cell.state === 'free' && cell.value > 0) free++;
		}
		const parts = [judged ? `${limit ? 'kept' : 'met'} on ${met} of ${judged} days` : '', free ? `${limit ? (habit.kind === 'check' ? 'slipped' : 'logged') : 'done'} on ${free} days` : ''].filter(Boolean);
		return `${formatMonth(m, { month: 'long', year: 'numeric' })}: ${parts.join(', ') || 'nothing to count'}`;
	}
	function tapDay(event: MouseEvent) {
		const date = (event.target as HTMLElement).dataset.date as CivilDate | undefined;
		if (date) dayInfo = describeCell(dayCell(data, habit, date, today), date, habit);
	}

	// yes/no habits: done per weekday
	const byWeekday = $derived.by<Bar[]>(() => {
		const shares = weekdayShares(data, habit, from, end, today);
		return weekdays.map((w) => {
			const { done, days } = shares[w];
			return {
				key: String(w),
				label: weekdayName(w),
				value: days ? (done / days) * 100 : 0,
				// (slips aren't success: grey)
				tone: limit ? 'weak' : 'full',
				info: days ? `${weekdayName(w)}: ${done} of ${days} ${limit ? 'slipped' : 'done'}` : `${weekdayName(w)}: –`,
			};
		});
	});

	// amounts: totals per week (per month for monthly goals or more than a year)
	const monthly = $derived(latestGoal(habit).period === 'month' || months.length > 12);
	const buckets = $derived.by(() => {
		const list: { from: CivilDate; to: CivilDate }[] = [];
		const first = monthly ? from : startOfWeek(from, weekStart);
		for (let b = first; b <= end; ) {
			const next = monthly ? addMonths(b, 1) : addDays(b, 7);
			list.push({ from: b, to: addDays(next, -1) });
			b = next;
		}
		return amountBuckets(data, habit, list, weekStart);
	});
	const amountTicks = $derived(niceTicks(Math.max(0, ...buckets.map((b) => Math.max(b.total, b.target)))));
	/** The bars for screen readers: "goal met in 30 of 52 weeks, 5 km on average" */
	const amountSummary = $derived.by(() => {
		// finished buckets since the habit's start
		const done = amountBars.filter((_, i) => buckets[i]!.to < today && buckets[i]!.to >= startOf(habit));
		const met = done.filter((b) => b.tone === 'full').length;
		const unit = monthly ? 'months' : 'weeks';
		const average = done.length ? done.reduce((sum, b) => sum + b.value, 0) / done.length : 0;
		return `${limit ? 'within the limit' : 'goal met'} in ${met} of ${done.length} ${unit}, ${withUnit(Math.round(average * 10) / 10, habit.unit)} on average`;
	});
	const amountBars = $derived<Bar[]>(
		buckets.map((b, i) => {
			const met = b.aim === 'build' ? b.target > 0 && b.total >= b.target : b.total <= b.target;
			const current = b.to >= today;
			// a limit: kept (full), kept so far (soft), broken (red)
			const tone = b.aim === 'build' ? (met ? 'full' : current ? 'soft' : 'weak') : !met ? 'bad' : current ? 'soft' : 'full';
			const name = monthly ? formatMonth(b.from, { year: '2-digit' }) : `Week of ${formatShortDate(b.from)}`;
			// labels: each month, or a year's first month when there are many
			const first = monthly ? (buckets.length <= 12 || dateParts(b.from).month === 1) : i === 0 || dateParts(b.from).month !== dateParts(buckets[i - 1]!.from).month;
			const label = !first ? null : monthly && buckets.length > 12 ? String(dateParts(b.from).year) : formatMonth(monthly ? b.from : addDays(b.from, 6));
			return {
				key: b.from,
				label,
				value: b.total,
				target: b.target,
				tone,
				info: `${name}: ${formatValue(b.total)}${b.target > 0 ? ` / ${withUnit(b.target, habit.unit)}` : habit.unit ? ` ${habit.unit}` : ''}`,
			};
		}),
	);
</script>

<div class="stats">
	<button class="back" bind:this={backButton} onclick={onback}>‹ Stats</button>
	<h2>{habit.name}</h2>
	<p class="sub">{habit.archived !== null ? 'Archived' : describeGoal(latestGoal(habit), habit)} · since {formatDate(startOf(habit))}</p>

	{#if startOf(habit) > end}
		<p class="empty">{startOf(habit) > today ? `Starts on ${formatDate(startOf(habit))}.` : 'Archived before it started.'}</p>
	{:else}
		<div class="tiles" style:--tiles={habit.kind === 'amount' ? 3 : 2}>
			<div class="tile"><b>{rate.counted ? `${Math.round((rate.met / rate.counted) * 100)} %` : '–'}</b><span>{limit ? 'limits kept' : 'goals met'}</span></div>
			<div class="tile"><b>{entries.length}</b><span>{limit && habit.kind === 'check' ? (entries.length === 1 ? 'slip' : 'slips') : `${entries.length === 1 ? 'day' : 'days'} ${limit ? 'logged' : 'done'}`}</span></div>
			{#if habit.kind === 'amount'}<div class="tile"><b>{withUnit(total >= 100 ? Math.round(total) : Math.round(total * 1000) / 1000, habit.unit)}</b><span>total</span></div>{/if}
		</div>

		<div class="segmented" role="group" aria-label="Range">
			{#each RANGES as r (r.id)}
				<button aria-pressed={range === r.id} onclick={() => ((range = r.id), (dayInfo = chartInfo = null))}>{r.label}</button>
			{/each}
		</div>

		<h3>Calendar</h3>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (taps for details; the numbers are in the tiles and charts too) -->
		<div class="months" onclick={tapDay}>
			{#each months as m (m)}
				<div class="month" role="img" aria-label={monthSummary(m)}>
					<span class="month-name">{monthLabel(m)}</span>
					<div class="days">
						{#each monthDays(m) as d, i (d ?? `blank-${i}`)}
							{#if d === null}<span></span>
							{:else}
								{@const look = cellLook(dayCell(data, habit, d, today))}
								<span class={`cell ${look.kind}`} class:today={d === today} style:--fill={look.fill} data-date={d}></span>
							{/if}
						{/each}
					</div>
				</div>
			{/each}
		</div>
		<p class="info" aria-live="polite">{dayInfo ?? 'Tap a day to see it.'}</p>

		{#if habit.kind === 'check'}
			<h3>{limit ? 'Slipped' : 'Done'} by weekday (%)</h3>
			<BarChart bars={byWeekday} max={100} values={(v) => String(Math.round(v))} label={`${limit ? 'Slipped' : 'Done'} by weekday`} oninfo={(i) => (chartInfo = i)} />
		{:else}
			<h3>Per {monthly ? 'month' : 'week'}{habit.unit ? ` (${habit.unit})` : ''}</h3>
			<BarChart bars={amountBars} max={amountTicks.at(-1)!} ticks={amountTicks} label={`Totals per ${monthly ? 'month' : 'week'}`} summary={amountSummary} oninfo={(i) => (chartInfo = i)} />
			{#if limit}
				<p class="legend"><i class="full"></i>within <i class="bad"></i>over <i class="line"></i>limit</p>
			{:else}
				<p class="legend"><i class="full"></i>goal met <i class="weak"></i>below <i class="line"></i>goal</p>
			{/if}
		{/if}
		<p class="info" aria-live="polite">{chartInfo ?? 'Tap a bar to see it.'}</p>
	{/if}
</div>

<style>
	.stats {
		max-width: 30rem;
		padding: 0.5rem 0.75rem 1rem;
	}
	.back {
		border: none;
		background: none;
		color: var(--muted);
		padding: 0.25rem 0.5rem 0.25rem 0;
		min-height: var(--tap);
	}
	h2 {
		margin: 0;
		font-size: 1.3rem;
		overflow-wrap: anywhere;
	}
	.sub {
		margin: 0 0 0.75rem;
		color: var(--muted);
		font-size: 0.9rem;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(var(--tiles), minmax(0, 1fr));
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}
	.tile {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 0.75rem;
		padding: 0.6rem 0.7rem;
		min-width: 0;
	}
	.tile b {
		display: block;
		font-size: 1.45rem;
		line-height: 1.15;
		overflow-wrap: anywhere;
	}
	.tile span {
		color: var(--muted);
		font-size: 0.8rem;
	}
	.segmented {
		display: flex;
		border: 1px solid var(--control-border);
		border-radius: 0.5rem;
		overflow: hidden;
	}
	.segmented button {
		flex: 1;
		border: none;
		border-radius: 0;
		background: none;
		color: var(--muted);
	}
	.segmented button[aria-pressed='true'] {
		background: var(--accent-soft);
		color: var(--text);
		font-weight: 600;
	}
	h3 {
		font-size: 0.95rem;
		margin: 1rem 0 0.4rem;
	}
	.months {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.6rem 0.7rem;
	}
	.month-name {
		font-size: 0.75rem;
		color: var(--muted);
	}
	.days {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: 2px;
	}
	.days span {
		aspect-ratio: 1;
		border-radius: 3px;
	}
	.days .today {
		outline: 1.5px solid var(--text);
		outline-offset: 1px;
	}
	.info {
		color: var(--muted);
		font-size: 0.85rem;
		margin: 0.4rem 0 0;
		min-height: 1.3em;
	}
	.legend {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		color: var(--muted);
		font-size: 0.75rem;
		margin: 0.3rem 0 0;
	}
	.legend i {
		display: inline-block;
		width: 0.65rem;
		height: 0.65rem;
		border-radius: 2px;
		margin-left: 0.4rem;
	}
	.legend i:first-child {
		margin-left: 0;
	}
	.legend .full {
		background: var(--accent);
	}
	.legend .weak {
		background: color-mix(in srgb, var(--muted) 55%, transparent);
	}
	.legend .bad {
		background: var(--negative);
	}
	.legend .line {
		height: 2px;
		background: var(--text);
	}
	.empty {
		color: var(--muted);
	}
</style>
