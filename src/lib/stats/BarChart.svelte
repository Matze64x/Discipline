<!--
	Bars from a zero baseline (SVG, as wide as its container), optionally with each bar's target as a
	short line across it and the values on top. A tap on a bar (its whole column) tells its `info`.
-->
<script lang="ts" module>
	export interface Bar {
		key: string;
		/** Under the bar (null: none) */
		label: string | null;
		value: number;
		target?: number;
		/** full: in the accent color (e.g. the goal met); soft: lighter (still open); weak: grey */
		tone: 'full' | 'soft' | 'weak';
		info: string;
	}
</script>

<script lang="ts">
	let {
		bars,
		max,
		ticks = [],
		values = null,
		label,
		oninfo,
	}: {
		bars: readonly Bar[];
		/** The value at the top */
		max: number;
		/** Grid lines, labeled at the right */
		ticks?: readonly number[];
		/** Writes each bar's value on top of it (null: no values) */
		values?: ((value: number) => string) | null;
		/** What the chart shows, for screen readers */
		label: string;
		oninfo: (info: string) => void;
	} = $props();

	const W = 360;
	const H = 130;
	const BASE = H - 16;
	const top = $derived(values ? 16 : 6);
	const right = $derived(ticks.length ? 28 : 0);
	const step = $derived((W - right) / Math.max(1, bars.length));
	const gap = $derived(Math.min(6, Math.max(1.5, step * 0.18)));
	/** Short enough for the margin: 1500, 15k, 1.5M */
	const tickLabel = (t: number) => (t >= 1e6 ? `${t / 1e6}M` : t >= 1e4 ? `${t / 1e3}k` : String(t));
	const y = (v: number) => BASE - (Math.min(v, max) / max) * (BASE - top);
	/** The top of a bar, rounded at its end (the baseline end stays square) */
	function barPath(x: number, w: number, v: number): string {
		const top = y(v);
		const r = Math.min(3, w / 2, BASE - top);
		return `M${x},${BASE} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${BASE} Z`;
	}
</script>

<svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
	{#each ticks as t (t)}
		<line class="grid" x1="0" x2={W - right} y1={y(t)} y2={y(t)} />
		<text class="tick" x={W - right + 4} y={y(t) + 3.5}>{tickLabel(t)}</text>
	{/each}
	{#each bars as bar, i (bar.key)}
		{@const x = i * step + gap / 2}
		{@const w = step - gap}
		{#if bar.value > 0}<path class={`bar ${bar.tone}`} d={barPath(x, w, bar.value)} />{/if}
		{#if bar.target !== undefined && bar.target > 0}<line class="target" x1={x - 1} x2={x + w + 1} y1={y(bar.target)} y2={y(bar.target)} />{/if}
		{#if values}<text class="value" x={x + w / 2} y={y(bar.value) - 4}>{values(bar.value)}</text>{/if}
		{#if bar.label}<text class="label" x={x + w / 2} y={H - 3}>{bar.label}</text>{/if}
		<!-- the whole column reacts to a tap: thin bars are hard to hit (charts are touch/mouse-first) -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<rect class="hit" x={i * step} y="0" width={step} height={BASE} onclick={() => oninfo(bar.info)} />
	{/each}
	<line class="grid" x1="0" x2={W - right} y1={BASE} y2={BASE} />
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
		stroke-width: 1;
	}
	text {
		fill: var(--muted);
		font-size: 10px;
	}
	.label,
	.value {
		text-anchor: middle;
	}
	.value {
		fill: var(--text);
	}
	.bar.full {
		fill: var(--accent);
	}
	.bar.soft {
		fill: color-mix(in srgb, var(--accent) 45%, transparent);
	}
	.bar.weak {
		fill: color-mix(in srgb, var(--muted) 55%, transparent);
	}
	.target {
		stroke: var(--text);
		stroke-width: 1.5;
	}
	.hit {
		fill: transparent;
		cursor: pointer;
	}
</style>
