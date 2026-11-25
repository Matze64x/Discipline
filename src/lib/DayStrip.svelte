<!--
	The days above Today's habits: a week, or a whole month (a calendar). Each day can show a ring
	(how many daily goals were met, or how a focused habit did); a tap picks the day. Days after
	today can't be picked.
-->
<script lang="ts">
	import { dateParts, weekday, type CivilDate, type Weekday } from '../core';
	import { formatShortDate, weekdayName } from './display';

	let {
		days,
		weekdays,
		selected,
		today,
		ring,
		color = null,
		onselect,
	}: {
		/** The days in calendar order, a full number of weeks; null: a blank (another month) */
		days: readonly (CivilDate | null)[];
		/** The weekdays of the columns, in the user's week order */
		weekdays: readonly Weekday[];
		selected: CivilDate;
		today: CivilDate;
		/** A day's ring: how full (0…1) and what it says, e.g. "2 of 3 done" (null: none) */
		ring: (day: CivilDate) => { fill: number; text: string } | null;
		/** The rings' color (null: the accent color) */
		color?: string | null;
		onselect: (day: CivilDate) => void;
	} = $props();

	const RADIUS = 16;
	const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
</script>

<div class="strip" role="group" aria-label="Days" style:--ring={color ?? 'var(--accent)'}>
	{#each weekdays as w (w)}<span class="weekday" aria-hidden="true">{weekdayName(w)}</span>{/each}
	{#each days as day, i (day ?? `blank-${i}`)}
		{#if day === null}
			<span></span>
		{:else}
			{@const future = day > today}
			{@const r = future ? null : ring(day)}
			<button
				type="button"
				class="day"
				class:today={day === today}
				class:all={r !== null && r.fill >= 1}
				aria-pressed={day === selected}
				aria-current={day === today ? 'date' : undefined}
				aria-label={`${weekdayName(weekday(day))} ${formatShortDate(day)}${r ? `, ${r.text}` : ''}`}
				disabled={future}
				onmousedown={(e) => e.preventDefault()}
				onclick={() => onselect(day)}
			>
				<svg viewBox="0 0 40 40" aria-hidden="true">
					{#if r}
						<circle class="track" cx="20" cy="20" r={RADIUS} />
						{#if r.fill > 0}
							<circle class="done" cx="20" cy="20" r={RADIUS} stroke-dasharray={`${CIRCUMFERENCE * Math.min(1, r.fill)} ${CIRCUMFERENCE}`} />
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
		stroke: var(--ring);
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
