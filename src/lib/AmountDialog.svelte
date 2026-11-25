<!--
	Enters how much was done of an amount habit on a day (empty or 0: nothing), or (adding) how much
	to add to it (empty or 0: nothing added). Shows how the goal's period stands, and Complete adds
	what's still missing to meet it (in one tap: there's no complete button on Today's rows).
-->
<script lang="ts">
	import { parseValueInput, type CivilDate, type Habit, type Progress } from '../core';
	import { formatDate, formatValue, withUnit } from './display';
	import Modal from './ui/Modal.svelte';

	let {
		habit,
		date,
		value,
		typed = null,
		adding = false,
		progress = null,
		remaining = 0,
		onsave,
		onclose,
	}: {
		habit: Habit;
		date: CivilDate;
		/** What's entered already, or null */
		value: number | null;
		/** A key typed to open the dialog: the field starts with it instead of the value */
		typed?: string | null;
		/** The field is an amount to add to `value`, not the value itself */
		adding?: boolean;
		/** How the goal's period (the day, week or month) stands, shown above the field */
		progress?: Progress | null;
		/** What's still missing to meet the goal (0: nothing to complete) */
		remaining?: number;
		/** The day's amount (null: nothing), or when adding the amount to add */
		onsave: (value: number | null) => void;
		onclose: () => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	let text = $state(typed ?? (value === null || adding ? '' : formatValue(value)));
	let failure = $state<string | null>(null);

	/** Saves the day's amount with what's missing added (or, adding, just what's missing) */
	function complete() {
		onsave(adding ? remaining : Math.round(((value ?? 0) + remaining) * 1000) / 1000);
	}

	const period = $derived(progress === null ? null : progress.goal.period === 'day' ? 'Day' : progress.goal.period === 'week' ? 'Week' : 'Month');

	function save() {
		// (nothing or 0: nothing done)
		if (text.trim() === '' || /^0*([.,]0*)?$/.test(text.trim())) return adding ? onclose() : onsave(null);
		const parsed = parseValueInput(text);
		if (parsed === null) return void (failure = 'Enter a number, or nothing.');
		onsave(parsed);
	}
</script>

<Modal title={`${habit.name}, ${formatDate(date)}`} color={habit.color} {onclose}>
	<form
		onsubmit={(e) => {
			e.preventDefault();
			save();
		}}
	>
		<div class="row">
			<!-- svelte-ignore a11y_autofocus -->
			<input
				type="text"
				inputmode="decimal"
				autocomplete="off"
				aria-label={adding ? 'Add' : 'Amount'}
					placeholder={adding ? '+' : undefined}
				bind:value={text}
				autofocus
				onfocus={(e) => {
					// typed: continue after the key; else replace the value
					if (typed === null) e.currentTarget.select();
				}}
			/>
			{#if habit.unit}<span class="unit">{habit.unit}</span>{/if}
		</div>
		{#if progress && !progress.due}
			<p class="unit now">Not due</p>
		{:else if progress && period}
			<p class="unit now">
				{period}: {formatValue(progress.done)} / {progress.goal.aim === 'limit' ? 'max ' : ''}{withUnit(progress.target, habit.unit)}{#if adding && progress.goal.period !== 'day'}, this day {withUnit(value ?? 0, habit.unit)}{/if}
			</p>
		{:else if adding}<p class="unit now">Now: {withUnit(value ?? 0, habit.unit)}</p>{/if}
		{#if failure}<p class="error" role="alert">{failure}</p>{/if}
		<div class="buttons">
			{#if remaining > 0}
				<div class="item-actions">
					<button type="button" onclick={complete}>Complete +{withUnit(remaining, habit.unit)}</button>
				</div>
			{/if}
			<div class="main-actions">
				<button type="button" onclick={onclose}>Cancel</button>
				<button type="submit" class="primary">Save</button>
			</div>
		</div>
	</form>
</Modal>

<style>
	form {
		display: grid;
		gap: 0.75rem;
	}
	.row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	input {
		width: 8rem;
		font-size: 1.2rem;
	}
	.unit {
		color: var(--muted);
	}
	.now {
		margin: 0;
	}
	.error {
		color: var(--negative);
		margin: 0;
	}
	/* Complete on the left, Cancel and Save on the right: one line if they fit */
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
</style>
