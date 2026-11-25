<!--
	Date entry as text in the user's date style (Settings), since the browser's own date field
	follows the browser's language instead. Parts may be left out ("5" = the 5th of this month).
	↑/↓ change the day, PageUp/PageDown the month, Alt+↓ opens the browser's calendar.
-->
<script lang="ts">
	import { addDays, addMonths, formatDateAs, MAX_YEAR, MIN_YEAR, parseDateInput, type CivilDate } from '../../core';
	import { clock } from '../clock.svelte';
	import { settings } from '../settings.svelte';

	let {
		value = $bindable(),
		id,
		label,
		autofocus = false,
		invalid = $bindable(false),
	}: {
		value: CivilDate | null;
		id?: string;
		label?: string;
		autofocus?: boolean;
		/** Set while the text isn't a date (then `value` is null), e.g. where empty means "open" */
		invalid?: boolean;
	} = $props();

	const uid = $props.id();
	const describedBy = `date-invalid-${uid}`;
	const show = (v: CivilDate | null) => (v === null ? '' : formatDateAs(v, settings.dateStyle));
	let text = $state(show(value));
	// what this field last set, to tell outside changes (and setting changes) from typing
	let lastSet = $state<CivilDate | null>(value);
	let lastStyle = settings.dateStyle;
	$effect(() => {
		if (value !== lastSet || settings.dateStyle !== lastStyle) {
			text = show(value);
			lastSet = value;
			lastStyle = settings.dateStyle;
		}
	});

	// the month and year that left-out parts stand for: those of the current value, else today
	const reference = $derived(lastSet ?? clock.today);
	const textInvalid = $derived(text.trim() !== '' && parseDateInput(text, settings.dateStyle, reference) === null);
	$effect(() => {
		invalid = textInvalid;
	});

	function set(next: CivilDate | null) {
		lastSet = next;
		value = next;
	}

	function oninput(event: Event) {
		text = (event.currentTarget as HTMLInputElement).value;
		set(text.trim() === '' ? null : parseDateInput(text, settings.dateStyle, reference));
	}

	function step(change: (d: CivilDate) => CivilDate) {
		try {
			const next = change(value ?? clock.today);
			set(next);
			text = show(next);
		} catch {
			// would leave the supported years
		}
	}

	let picker: HTMLInputElement;
	function openPicker() {
		try {
			picker.showPicker();
		} catch {
			picker.focus(); // no showPicker (older browsers): the field itself is usable
		}
	}

	function onkeydown(event: KeyboardEvent) {
		const keys: Record<string, () => void> = {
			ArrowUp: () => step((d) => addDays(d, 1)),
			ArrowDown: () => (event.altKey ? openPicker() : step((d) => addDays(d, -1))),
			PageUp: () => step((d) => addMonths(d, 1)),
			PageDown: () => step((d) => addMonths(d, -1)),
		};
		const action = keys[event.key];
		if (action && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
			event.preventDefault();
			action();
		}
	}
</script>

<div class="date">
	<!-- svelte-ignore a11y_autofocus -->
	<input
		{id}
		type="text"
		inputmode="decimal"
		autocomplete="off"
		spellcheck="false"
		placeholder={settings.dateStyle}
		aria-label={label}
		aria-invalid={textInvalid}
		aria-describedby={textInvalid ? describedBy : undefined}
		title="↑/↓: day, PageUp/PageDown: month, Alt+↓: calendar"
		value={text}
		{oninput}
		{onkeydown}
		onblur={() => (text = textInvalid ? text : show(value))}
		{autofocus}
	/>
	<!-- the browser's calendar; on phones a tap opens it directly -->
	<span class="calendar" title="Calendar (Alt+↓)">
		<svg viewBox="0 0 24 24" aria-hidden="true"
			><path
				d="M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zM5 9h14v11H5z"
				fill="currentColor"
			/></svg
		>
		<input
			bind:this={picker}
			type="date"
			tabindex="-1"
			aria-label={`${label ?? 'Date'}: calendar`}
			min={`${MIN_YEAR}-01-01`}
			max={`${MAX_YEAR}-12-31`}
			value={value ?? ''}
			onclick={openPicker}
			onchange={(e) => {
				const picked = e.currentTarget.value as CivilDate;
				if (picked) step(() => picked);
			}}
		/>
	</span>
	<!-- (an invalid date only turns the border red: a message here would shift the form's layout) -->
	<span id={describedBy} class="hidden">{textInvalid ? `Not a date: enter one like ${formatDateAs('2026-03-05' as CivilDate, settings.dateStyle)}` : ''}</span>
</div>

<style>
	.date {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	input[type='text'] {
		flex: 1;
		min-width: 0;
		font-variant-numeric: tabular-nums;
	}
	.calendar {
		position: relative;
		width: max(2.5rem, var(--tap));
		height: max(2.5rem, var(--tap));
		flex: none;
		display: grid;
		place-items: center;
		border: 1px solid var(--control-border);
		border-radius: 0.5rem;
		color: var(--muted);
		/* iOS draws a date field at its own width, ignoring the CSS one: keep it inside the button */
		overflow: hidden;
	}
	.calendar:hover {
		border-color: var(--accent);
	}
	svg {
		width: 1.2rem;
		height: 1.2rem;
	}
	/* invisible, but covers the button so a tap/click reaches the browser's date field */
	.calendar input {
		position: absolute;
		inset: 0;
		-webkit-appearance: none;
		appearance: none;
		min-width: 0;
		width: 100%;
		height: 100%;
		min-height: 0;
		opacity: 0;
		padding: 0;
		border: none;
		cursor: pointer;
	}
	/* for screen readers only */
	.hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
