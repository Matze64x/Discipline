<!--
	A keyboard-operated list (listbox): the focus stays on the list while j/k or the arrow keys
	(PageUp/PageDown, Home/End) move the selection. A click or tap (no double clicks: they don't
	work on touch screens) or the view's own shortcut (Enter) opens a row. Without a selection, moving starts at the first row on screen, so nothing jumps.
	Showing the view (`active` becomes true) puts the focus into the list. Several lists in one view
	(`shared`): their keys only apply while the list has the focus, and only the first takes it.
	Only the rows on and near the screen are in the page (the list scrolls with the page): the
	others are spacers, sized by the rows' measured heights (or the average of the first ones
	measured), so tens of thousands of rows stay fast. When rows above the screen turn out taller
	or shorter than assumed, what's on screen stays put: the browser's scroll anchoring sees to that,
	and where there is none (Safari), the list scrolls the page by the difference itself.
-->
<script lang="ts" generics="T, K extends string">
	import { tick, untrack, type Snippet } from 'svelte';
	import { shortcuts } from '../shortcuts.svelte';

	let {
		items,
		key,
		selected = $bindable(),
		element = $bindable(),
		label,
		active,
		shared = null,
		group,
		itemName,
		onopen,
		row,
		empty,
		showSelection = true,
		cards = false,
	}: {
		items: readonly T[];
		/** Identifies an item (unique within the list) */
		key: (item: T) => K;
		/** The key of the selected item, or null */
		selected: K | null;
		/** The list element, e.g. for shortcuts that only apply while it has the focus */
		element?: HTMLElement;
		label: string;
		/** Whether the list's view is the one shown (its keys only apply then) */
		active: boolean;
		/** One of several lists in the view: `'first'` takes the focus when it's shown, `'other'` doesn't; both only take keys while focused */
		shared?: 'first' | 'other' | null;
		/** Heading in the shortcut help, e.g. 'Habits' */
		group: string;
		/** What an item is called in the help, e.g. 'habit' */
		itemName: string;
		onopen: (item: T) => void;
		row: Snippet<[T]>;
		empty: Snippet;
		/** Whether the selected row is highlighted (false: the view shows something else, e.g. on touch screens, where there's no keyboard cursor) */
		showSelection?: boolean;
		/** Each row is a card of its own (the row snippet draws it; the selection outlines it) instead of a line */
		cards?: boolean;
	} = $props();

	const prefix = `option-${Math.random().toString(36).slice(2)}`;
	const selectedIndex = $derived(items.findIndex((item) => key(item) === selected));
	const domId = (k: K) => `${prefix}-${k}`;

	/** Focuses the list without scrolling; after a dialog is gone, since closing one returns the focus */
	export function focus(): void {
		void tick().then(() => element?.focus({ preventScroll: true }));
	}

	// svelte-ignore state_referenced_locally
	let wasActive = active;
	$effect(() => {
		if (active && !wasActive && shared !== 'other') focus();
		wasActive = active;
	});

	/** Where the page's visible area starts: below the sticky header */
	const visibleTop = () => document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;

	// ---- only the rows near the screen are rendered
	/** How far beyond the screen rows are rendered, in pixels */
	const OVERSCAN = 1500;
	/** Measured row heights by key (a plain map: `measured` says when it changed) */
	const heights = new Map<string, number>();
	let measured = $state(0);
	/** The height assumed for rows not measured yet: the average of the first rows measured (at this width) */
	let estimate = 42;
	let estimated = false;
	/** The screen's part of the list, in the list's coordinates */
	let viewTop = $state(0);
	let viewHeight = $state(typeof window === 'undefined' ? 1000 : window.innerHeight);

	/** Where each row starts (and the total height at the end): measured heights, else their average */
	const offsets = $derived.by(() => {
		void measured;
		const result = new Float64Array(items.length + 1);
		for (let i = 0; i < items.length; i++) result[i + 1] = result[i]! + (heights.get(key(items[i]!)) ?? estimate);
		return result;
	});
	/** The index of the row at `y` (list coordinates), clamped to the rows */
	function indexAt(y: number): number {
		let low = 0;
		let high = items.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if (offsets[mid]! <= y) low = mid;
			else high = mid - 1;
		}
		return Math.max(0, low);
	}
	const start = $derived(indexAt(viewTop - OVERSCAN));
	const end = $derived(Math.min(items.length, indexAt(viewTop + viewHeight + OVERSCAN) + 1));
	const shown = $derived(items.slice(start, end));

	function updateView() {
		if (!element) return;
		viewTop = -element.getBoundingClientRect().top;
		viewHeight = document.documentElement.clientHeight;
	}
	$effect(() => {
		const update = () => {
			if (untrack(() => active)) updateView();
		};
		addEventListener('scroll', update, { passive: true });
		addEventListener('resize', update);
		// a new width can change the rows' heights (wrapping): measure again
		let width = element?.clientWidth;
		// (in the next frame: changing the layout right in the callback makes WebKit report a loop)
		let frame = 0;
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (element && element.clientWidth !== width) {
					width = element.clientWidth;
					const before = estimate;
					heights.clear();
					estimated = false;
					measure();
					// (if nothing was measured, the old estimate stays)
					if (estimate !== before) measured++;
				}
				update();
			});
		});
		if (element) observer.observe(element);
		return () => {
			removeEventListener('scroll', update);
			removeEventListener('resize', update);
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
	});
	// shown again, or other rows (e.g. a search): what's above the list may have changed too
	$effect(() => {
		void items;
		if (active) updateView();
	});
	/** Browsers with scroll anchoring keep the screen in place themselves (Safari has none) */
	const nativeAnchoring = typeof CSS !== 'undefined' && CSS.supports('overflow-anchor', 'auto');

	/** Measures the rendered rows; keeps what's on screen in place if rows above it changed height */
	function measure() {
		if (!element) return;
		const top = Math.max(visibleTop(), 0);
		let shift = 0;
		let changed = false;
		const rows = element.querySelectorAll<HTMLElement>('[role="option"]');
		const firstRect = rows[0]?.getBoundingClientRect();
		for (const row of rows) {
			const rect = row.getBoundingClientRect();
			// (0: hidden, e.g. another section is shown)
			if (rect.height <= 0) continue;
			const k = row.dataset.key!;
			const old = heights.get(k);
			if (old !== undefined && Math.abs(old - rect.height) <= 0.5) continue;
			// (a row reaching above the top line pushes what follows it, too)
			if (rect.top < top) shift += rect.height - (old ?? estimate);
			heights.set(k, rect.height);
			changed = true;
		}
		if (!changed) return;
		if (!estimated) {
			let sum = 0;
			for (const h of heights.values()) sum += h;
			const next = sum / heights.size;
			// the rows before the first rendered one are all estimated (nothing is measured at this width yet)
			if (firstRect && firstRect.top <= top) shift += (next - estimate) * start;
			estimate = next;
			estimated = true;
		}
		untrack(() => measured++);
		if (shift !== 0 && !nativeAnchoring) scrollBy({ top: shift });
	}
	$effect(() => {
		void shown;
		measure();
	});
	// rows whose height changes on their own (e.g. another date format)
	let rowFrame = 0;
	const rowObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
		cancelAnimationFrame(rowFrame);
		rowFrame = requestAnimationFrame(measure);
	});
	$effect(() => () => {
		rowObserver?.disconnect();
		cancelAnimationFrame(rowFrame);
	});
	function observed(row: HTMLElement) {
		rowObserver?.observe(row);
		return { destroy: () => rowObserver?.unobserve(row) };
	}
	// forget rows that are gone
	$effect(() => {
		if (heights.size <= items.length * 2) return;
		const keys = new Set(items.map((item) => key(item) as string));
		for (const k of heights.keys()) if (!keys.has(k)) heights.delete(k);
	});

	/** Scrolls the page just enough to show the selected row, and only if needed */
	function reveal(top: number, bottom: number) {
		const above = top - visibleTop();
		// the layout viewport: `innerHeight` briefly reported a far too small height in mobile WebKit
		// after a full-screen dialog closed
		const below = bottom - document.documentElement.clientHeight;
		if (above < 0) scrollBy({ top: above });
		else if (below > 0) scrollBy({ top: below });
	}

	// keep the selection visible (not with `scrollIntoView`, which ignores the sticky header and in
	// WebKit sometimes scrolled far past a row that was already visible): first by where the row
	// should be, then, once it's rendered, by where it is
	$effect(() => {
		if (selected === null) return;
		const k = selected;
		untrack(() => {
			const index = selectedIndex;
			if (index < 0 || !element) return;
			const listTop = element.getBoundingClientRect().top;
			if (!document.getElementById(domId(k))) reveal(listTop + offsets[index]!, listTop + offsets[index + 1]!);
			void tick().then(() =>
				requestAnimationFrame(() => {
					const row = document.getElementById(domId(k));
					if (row && selected === k) reveal(row.getBoundingClientRect().top, row.getBoundingClientRect().bottom);
				}),
			);
		});
	});

	/** The index of the first row on screen (below the sticky header) */
	function firstRowOnScreen(): number {
		if (!element) return 0;
		const y = visibleTop() - element.getBoundingClientRect().top;
		const index = indexAt(y);
		return offsets[index + 1]! <= y && index + 1 < items.length ? index + 1 : index;
	}

	function move(by: number) {
		if (items.length === 0) return;
		const index =
			selectedIndex < 0 && Number.isFinite(by) ? firstRowOnScreen() : Math.max(0, Math.min(items.length - 1, (selectedIndex < 0 ? (by > 0 ? -1 : items.length) : selectedIndex) + by));
		selected = key(items[index]!);
	}

	$effect(() =>
		shortcuts.add(
			[
				{ keys: ['j', 'ArrowDown'], description: `Next ${itemName}`, repeat: true, run: () => move(1) },
				{ keys: ['k', 'ArrowUp'], description: `Previous ${itemName}`, repeat: true, run: () => move(-1) },
				{ keys: ['PageDown'], description: `10 ${itemName}s down`, repeat: true, run: () => move(10) },
				{ keys: ['PageUp'], description: `10 ${itemName}s up`, repeat: true, run: () => move(-10) },
				{ keys: ['Home'], description: `First ${itemName}`, run: () => move(-Infinity) },
				{ keys: ['End'], description: `Last ${itemName}`, run: () => move(Infinity) },
			].map((s) => ({ ...s, group, when: () => active, ...(shared && { focusIn: () => element }) })),
		),
	);

	/** The item of the row a mouse event happened in */
	function itemAt(event: MouseEvent): T | undefined {
		const k = (event.target as HTMLElement).closest('[data-key]')?.getAttribute('data-key');
		return k == null ? undefined : items.find((item) => key(item) === k);
	}

</script>

<!-- svelte-ignore a11y_click_events_have_key_events (the keys are shortcuts, see the registry) -->
<div
	bind:this={element}
	class="list"
	class:cards
	role="listbox"
	tabindex="0"
	aria-label={label}
	aria-activedescendant={selectedIndex >= 0 && selected !== null ? domId(selected) : undefined}
	onfocus={() => {
		if (selectedIndex < 0) move(1);
	}}
	onclick={(e) => {
		const item = itemAt(e);
		if (item === undefined) return;
		selected = key(item);
		// (a click or tap opens the row: no double-clicks, they don't work on touch screens)
		onopen(item);
	}}
>
	{#if items.length === 0}
		{@render empty()}
	{:else}
		<div style:height={`${offsets[start]}px`}></div>
		{#each shown as item, i (key(item))}
			<div
				id={domId(key(item))}
				data-key={key(item)}
				class="option"
				class:selected={showSelection && key(item) === selected}
				role="option"
				use:observed
				aria-selected={key(item) === selected}
				aria-setsize={items.length}
				aria-posinset={start + i + 1}
			>
				{@render row(item)}
			</div>
		{/each}
		<div style:height={`${offsets[items.length]! - offsets[end]!}px`}></div>
	{/if}
</div>

<style>
	.list:focus-visible {
		/* the selected row shows the focus instead */
		outline: none;
	}
	.option {
		border-bottom: 1px solid var(--border);
		cursor: default;
	}
	.option.selected {
		background: var(--accent-soft);
		box-shadow: inset 3px 0 0 var(--accent);
	}
	/* a grey bar: the keys don't go to the list right now */
	.list:not(:focus) .option.selected {
		box-shadow: inset 3px 0 0 var(--control-border);
	}
	/* cards: apart from each other; the selection outlines the card */
	.cards {
		padding: 0.15rem 0.75rem 0.5rem;
	}
	.cards .option {
		border-bottom: none;
		padding: 0.25rem 0;
	}
	.cards .option.selected,
	.list.cards:not(:focus) .option.selected {
		background: none;
		box-shadow: none;
	}
	.cards .option.selected > :global(*) {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}
	.list.cards:not(:focus) .option.selected > :global(*) {
		outline-color: var(--control-border);
	}
</style>
