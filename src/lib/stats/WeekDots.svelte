<!--
	A habit's last weeks at a glance: one column per week, one small square per day; below, a month's
	name under the week its first day falls in (so it's clear which time the squares show)
-->
<script lang="ts">
	import { addDays, dateParts, dayCell, type CivilDate, type DisciplineData, type Habit } from '../../core';
	import { formatMonth } from '../display';
	import { cellLook } from './cells';

	let { data, habit, weeks, today }: { data: DisciplineData; habit: Habit; weeks: readonly CivilDate[]; today: CivilDate } = $props();

	const months = $derived(weeks.flatMap((w, i) => (dateParts(addDays(w, 6)).day <= 7 ? [{ column: i + 1, name: formatMonth(addDays(w, 6)) }] : [])));
	const cells = $derived(weeks.flatMap((w) => Array.from({ length: 7 }, (_, i) => cellLook(dayCell(data, habit, addDays(w, i), today)))));
</script>

<div style:--weeks={weeks.length} aria-hidden="true">
	<div class="dots">
		{#each cells as c, i (i)}<span class={`cell ${c.kind}`} style:--fill={c.fill}></span>{/each}
	</div>
	<!-- (the same columns as the squares) -->
	<div class="months">
		{#each months as m (m.column)}<span style:grid-column={m.column}>{m.name}</span>{/each}
	</div>
</div>

<style>
	.dots {
		display: grid;
		grid-template-rows: repeat(7, auto);
		grid-template-columns: repeat(var(--weeks), minmax(0, 1fr));
		grid-auto-flow: column;
		gap: 2px;
	}
	.cell {
		aspect-ratio: 1;
	}
	.months {
		display: grid;
		grid-template-columns: repeat(var(--weeks), minmax(0, 1fr));
		column-gap: 2px;
		margin-top: 0.2rem;
	}
	.months span {
		/* (may reach over the next weeks: there are 4 or 5 to the next month) */
		width: 0;
		overflow: visible;
		white-space: nowrap;
		font-size: 0.7rem;
		line-height: 1.2;
		color: var(--muted);
	}
</style>
