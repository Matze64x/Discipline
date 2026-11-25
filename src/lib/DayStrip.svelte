<!--
	The days above Today's habits: a week, or a whole month (a calendar). Each day shows how many of
	its daily goals were met as a ring; a tap picks the day. Days after today can't be picked.
-->
<script lang="ts">
	import { dateParts, weekday, type CivilDate, type Weekday } from '../core';
	import { formatShortDate, weekdayName } from './display';

	let {
		days,
		weekdays,
		selected,
		today,
		share,
		onselect,
	}: {
		/** The days in calendar order, a full number of weeks; null: a blank (another month) */
		days: readonly (CivilDate | null)[];
		/** The weekdays of the columns, in the user's week order */
		weekdays: readonly Weekday[];
		selected: CivilDate;
		today: CivilDate;
		/** How many of a day's daily goals were met */
		share: (day: CivilDate) => { met: number; due: number };
		onselect: (day: CivilDate) => void;
	} = $props();

	const RADIUS = 16;
	const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
</script>

<div class="strip" role="group" aria-label="Days">
	{#each weekdays as w (w)}<span class="weekday" aria-hidden="true">{weekdayName(w)}</span>{/each}
	{#each days as day, i (day ?? `blank-${i}`)}
		{#if day === null}
			<span></span>
		{:else}
			{@const { met, due } = share(day)}
			{@const future = day > today}
			<button
				type="button"
				class="day"
				class:today={day === today}
				class:all={due > 0 && met === due}
				aria-pressed={day === selected}
				aria-current={day === today ? 'date' : undefined}
				aria-label={`${weekdayName(weekday(day))} ${formatShortDate(day)}${due > 0 && !future ? `, ${met} of ${due} done` : ''}`}
				disabled={future}
				onmousedown={(e) => e.preventDefault()}
				onclick={() => onselect(day)}
			>
				<svg viewBox="0 0 40 40" aria-hidden="true">
					{#if due > 0 && !future}
						<circle class="track" cx="20" cy="20" r={RADIUS} />
						{#if met > 0}
							<circle class="done" cx="20" cy="20" r={RADIUS} stroke-dasharray={`${(CIRCUMFERENCE * met) / due} ${CIRCUMFERENCE}`} />
						{/if}
					{/if}
				</svg>
				<span class="number">{dateParts(day).day}</span>
			</button>
		{/if}
	{/each}
</div>

<style>
	.strip {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: 0.15rem;
		padding: 0 0.5rem;
	}
	.weekday {
		text-align: center;
		font-size: 0.75rem;
		color: var(--muted);
	}
	.day {
		position: relative;
		display: grid;
		place-items: center;
		height: 2.9rem;
		padding: 0;
		border: none;
		border-radius: 0.6rem;
		background: none;
		color: var(--text);
		min-width: 0;
	}
	.day[aria-pressed='true'] {
		background: var(--accent-soft);
		box-shadow: inset 0 0 0 2px var(--accent);
	}
	.day:disabled {
		/* (a swipe may start on a day to come: WebKit sends a disabled button's events nowhere) */
		pointer-events: none;
		color: var(--muted);
		opacity: 0.45;
	}
	svg {
		position: absolute;
		width: 2.5rem;
		height: 2.5rem;
		transform: rotate(-90deg);
	}
	circle {
		fill: none;
		stroke-width: 3;
	}
	.track {
		stroke: var(--border);
	}
	.done {
		stroke: var(--accent);
		stroke-linecap: round;
	}
	.number {
		position: relative;
		font-size: 0.95rem;
	}
	.today .number {
		color: var(--accent);
		font-weight: 700;
	}
	.all .number {
		font-weight: 700;
	}
</style>
