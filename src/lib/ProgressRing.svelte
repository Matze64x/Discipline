<!--
	A ring that closes clockwise from the top as `fill` goes from 0 to 1, like the days' rings above
	Today's habits (DayStrip). It covers its parent (which needs `position: relative`, or its own
	grid cell); the track is `--ring-track`, the arc `--ring-color`. Decoration only (aria-hidden).
-->
<script lang="ts">
	let {
		fill,
		/** The line's width in 1/40 of the ring's size */
		width = 3,
	}: { fill: number; width?: number } = $props();

	const radius = $derived(20 - width / 2);
	const circumference = $derived(2 * Math.PI * radius);
</script>

<svg class="ring" viewBox="0 0 40 40" aria-hidden="true">
	<circle class="track" cx="20" cy="20" r={radius} stroke-width={width} />
	{#if fill > 0}
		<circle class="arc" cx="20" cy="20" r={radius} stroke-width={width} stroke-dasharray={`${circumference * Math.min(1, fill)} ${circumference}`} />
	{/if}
</svg>

<style>
	.ring {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		transform: rotate(-90deg);
		pointer-events: none;
	}
	circle {
		fill: none;
	}
	.track {
		stroke: var(--ring-track, var(--border));
	}
	.arc {
		stroke: var(--ring-color, var(--accent));
		stroke-linecap: round;
	}
</style>
