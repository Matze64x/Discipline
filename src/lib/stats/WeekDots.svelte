<!-- A habit's last weeks at a glance: one column per week, one small square per day -->
<script lang="ts">
	import { addDays, dayCell, type CivilDate, type DisciplineData, type Habit } from '../../core';
	import { cellLook } from './cells';

	let { data, habit, weeks, today }: { data: DisciplineData; habit: Habit; weeks: readonly CivilDate[]; today: CivilDate } = $props();

	const cells = $derived(weeks.flatMap((w) => Array.from({ length: 7 }, (_, i) => cellLook(dayCell(data, habit, addDays(w, i), today)))));
</script>

<div class="dots" style:--weeks={weeks.length} aria-hidden="true">
	{#each cells as c, i (i)}<span class={`cell ${c.kind}`} style:--fill={c.fill}></span>{/each}
</div>

<style>
	.dots {
		display: grid;
		grid-template-rows: repeat(7, auto);
		grid-template-columns: repeat(var(--weeks), minmax(0, 1fr));
		grid-auto-flow: column;
		gap: 2px;
	}
	span {
		aspect-ratio: 1;
	}
</style>
