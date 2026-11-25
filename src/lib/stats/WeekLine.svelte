<!--
	A share (0…1) per week as a line (SVG, as wide as its container), gaps where a week has nothing
	to count. A tap on a week tells its `info`.
-->
<script lang="ts">
	let {
		points,
		label,
		oninfo,
	}: {
		/** value null: nothing counted that week; label: under the week (a month's first week) */
		points: readonly { key: string; value: number | null; label: string | null; info: string }[];
		label: string;
		oninfo: (info: string) => void;
	} = $props();

	const W = 360;
	const H = 100;
	const BASE = H - 16;
	const TOP = 5;
	const RIGHT = 30;
	const x = (i: number) => 4 + (i / Math.max(1, points.length - 1)) * (W - RIGHT - 8);
	const y = (v: number) => BASE - v * (BASE - TOP);
	/** Line segments over consecutive weeks that have a value */
	const path = $derived(points.map((p, i) => (p.value === null ? '' : `${i > 0 && points[i - 1]!.value !== null ? 'L' : 'M'}${x(i)},${y(p.value)}`)).join(''));
	const last = $derived(points.findLastIndex((p) => p.value !== null));
	const step = $derived((W - RIGHT - 8) / Math.max(1, points.length - 1));
</script>

<svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
	{#each [0, 0.5, 1] as t (t)}
		<line class="grid" x1="0" x2={W - RIGHT} y1={y(t)} y2={y(t)} />
		<text class="tick" x={W - RIGHT + 4} y={y(t) + 3.5}>{t * 100} %</text>
	{/each}
	<path class="line" d={path} />
	{#each points as p, i (p.key)}
		{#if p.value !== null && (i === last || points[i - 1]?.value == null) && (i === last || points[i + 1]?.value == null)}
			<!-- a week standing alone (or the latest) gets a dot, or it wouldn't show -->
			<circle class="dot" cx={x(i)} cy={y(p.value)} r="3.5" />
		{/if}
		{#if p.label}<text x={x(i)} y={H - 3}>{p.label}</text>{/if}
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (touch/mouse-first) -->
		<rect class="hit" x={x(i) - step / 2} y="0" width={step} height={BASE} onclick={() => oninfo(p.info)} />
	{/each}
</svg>

<style>
	svg {
		display: block;
		width: 100%;
		height: auto;
		overflow: visible;
	}
	.grid {
		stroke: var(--border);
	}
	text {
		fill: var(--muted);
		font-size: 10px;
	}
	.line {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.dot {
		fill: var(--accent);
		stroke: var(--surface);
		stroke-width: 2;
	}
	.hit {
		fill: transparent;
		cursor: pointer;
	}
</style>
