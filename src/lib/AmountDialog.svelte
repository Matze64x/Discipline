<!-- Enters how much was done of an amount habit on a day (empty or 0: nothing). -->
<script lang="ts">
	import { parseValueInput, type CivilDate, type Habit } from '../core';
	import { formatDate, formatValue } from './display';
	import Modal from './ui/Modal.svelte';

	let {
		habit,
		date,
		value,
		typed = null,
		onsave,
		onclose,
	}: {
		habit: Habit;
		date: CivilDate;
		/** What's entered already, or null */
		value: number | null;
		/** A key typed to open the dialog: the field starts with it instead of the value */
		typed?: string | null;
		onsave: (value: number | null) => void;
		onclose: () => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	let text = $state(typed ?? (value === null ? '' : formatValue(value)));
	let failure = $state<string | null>(null);

	function save() {
		// (nothing or 0: nothing done)
		if (text.trim() === '' || /^0*([.,]0*)?$/.test(text.trim())) return onsave(null);
		const parsed = parseValueInput(text);
		if (parsed === null) return void (failure = 'Enter a number, or nothing.');
		onsave(parsed);
	}
</script>

<Modal title={`${habit.name}, ${formatDate(date)}`} {onclose}>
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
				aria-label="Amount"
				bind:value={text}
				autofocus
				onfocus={(e) => {
					// typed: continue after the key; else replace the value
					if (typed === null) e.currentTarget.select();
				}}
			/>
			{#if habit.unit}<span class="unit">{habit.unit}</span>{/if}
		</div>
		{#if failure}<p class="error" role="alert">{failure}</p>{/if}
		<div class="buttons">
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
	.error {
		color: var(--negative);
		margin: 0;
	}
</style>
