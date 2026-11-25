<!--
	Adds or edits a habit: name, build (at least) or limit (at most), yes/no or amount (the goal's amount and its unit), how often (on
	which weekdays, or per week or month; a yes/no habit: on how many days), the day it starts, and its color. A changed goal counts from today
	on; earlier days keep the goal they had. Editing also offers archiving and deleting.
-->
<script lang="ts">
	import { addHabit, deepEqual, parseValueInput, toDraft, updateHabit, WEEKDAYS, type CivilDate, type Aim, type Goal, type Habit, type HabitKind, type Id, type Weekday } from '../core';
	import { attempt } from './attempt';
	import { clock } from './clock.svelte';
	import { formatValue, weekdayName } from './display';
	import { unusedColor } from './palette';
	import ColorPicker from './ui/ColorPicker.svelte';
	import DateInput from './ui/DateInput.svelte';
	import Modal from './ui/Modal.svelte';
	import Segmented from './ui/Segmented.svelte';
	import type { Workspace } from './workspace.svelte';

	let {
		workspace,
		habit,
		onsaved,
		onarchive,
		onmove,
		canmove,
		ondelete,
		onclose,
	}: {
		workspace: Workspace;
		/** The habit to edit, or null for a new one */
		habit: Habit | null;
		onsaved: (id: Id) => void;
		/** Archives (or makes active again) the edited habit; the dialog closes first */
		onarchive: (habit: Habit) => void;
		/** Moves the edited habit up or down in the order (the dialog stays open) */
		onmove: (habit: Habit, by: -1 | 1) => void;
		canmove: (habit: Habit, by: -1 | 1) => boolean;
		ondelete: (habit: Habit) => void;
		onclose: () => void;
	} = $props();

	// (the habit as it was when the dialog opened: saving refuses to overwrite a change made
	// meanwhile; the fields start from it once)
	// svelte-ignore state_referenced_locally
	const original = habit;
	// svelte-ignore state_referenced_locally
	const usedColors = workspace.data.habits.map((h) => h.color);
	const initial = original
		? toDraft(original)
		: { name: '', kind: 'check' as HabitKind, unit: '', color: unusedColor(usedColors), start: clock.today, goal: { period: 'day', days: [...WEEKDAYS], aim: 'build', target: 1 } as Goal };

	/** The habit as it is now (moving it, or a sync, changes it while the dialog is open) */
	const current = $derived(original ? workspace.data.habits.find((h) => h.id === original.id) : undefined);
	/** What the editor edits of a habit: a change to anything else meanwhile doesn't conflict */
	const edited = (h: Habit) => ({ name: h.name, kind: h.kind, unit: h.unit, color: h.color, goals: h.goals });

	let name = $state(initial.name);
	let aim = $state<Aim>(initial.goal.aim);
	let kind = $state<HabitKind>(initial.kind);
	let unit = $state(initial.unit);
	let color = $state(initial.color);
	let start = $state<CivilDate | null>(initial.start);
	let period = $state<Goal['period']>(initial.goal.period);
	let days = $state<Weekday[]>(initial.goal.period === 'day' ? [...initial.goal.days] : [...WEEKDAYS]);
	// a check habit's daily target is always 1 (a limit: 0): nothing to type then
	let targetText = $state(initial.goal.period === 'day' && initial.kind === 'check' ? '' : formatValue(initial.goal.target));
	let failure = $state<string | null>(null);
	let saving = false;

	const PERIODS = [
		{ value: 'day', label: 'Daily' },
		{ value: 'week', label: 'Weekly' },
		{ value: 'month', label: 'Monthly' },
	] as const;
	const AIMS = [
		{ value: 'build', label: 'Build' },
		{ value: 'limit', label: 'Limit' },
	] as const;
	const KINDS = [
		{ value: 'check', label: 'Yes / no' },
		{ value: 'amount', label: 'Amount' },
	] as const;

	const needsTarget = $derived(!(period === 'day' && kind === 'check'));

	/** The goal as entered, or a reason why it isn't valid */
	function goal(): Goal | string {
		if (period === 'day' && days.length === 0) return 'Choose at least one weekday.';
		if (!needsTarget) return { period: 'day', days: [...days], aim, target: aim === 'build' ? 1 : 0 };
		// a limit can be 0 (none at all)
		const target = aim === 'limit' && /^(0+([.,]0*)?|[.,]0+)$/.test(targetText.trim()) ? 0 : parseValueInput(targetText);
		if (target === null) return aim === 'build' ? 'Enter a target greater than 0.' : 'Enter a limit (0 or more).';
		if (kind === 'check') {
			const max = period === 'week' ? 7 : 31;
			if (!Number.isInteger(target) || target > max) return `Enter a whole number of days, at most ${max}.`;
		}
		return period === 'day' ? { period, days: [...days], aim, target } : { period, aim, target };
	}

	/** Whether the goal differs from the habit's latest one (it then counts from today on) */
	const goalChanged = $derived.by(() => {
		if (!original) return false;
		const g = goal();
		return typeof g !== 'string' && !deepEqual(g, initial.goal);
	});
	/** Changing the kind, or the goal before the habit has started, applies to all its days */
	const appliesToAll = $derived(original !== null && (kind !== original.kind || (start !== null && start >= clock.today)));

	/** The weekdays in the order of the user's week */
	const weekdays = $derived(workspace.data.preferences.weekStart === 7 ? ([7, 1, 2, 3, 4, 5, 6] as Weekday[]) : WEEKDAYS);

	function toggleDay(day: Weekday) {
		days = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b);
	}

	async function save() {
		if (saving) return;
		failure = null;
		const g = goal();
		if (name.trim() === '') return void (failure = 'Enter a name.');
		if (start === null) return void (failure = 'Enter the day it starts.');
		if (typeof g === 'string') return void (failure = g);
		const draft = { name, kind, unit, color, start, goal: g };
		saving = true;
		let id: Id | null = original?.id ?? null;
		const saved = await attempt(
			(text) => (failure = text),
			async () => {
				if (original)
					await workspace.edit(`Edit “${name.trim()}”`, (d, now) => {
						// refuses to overwrite what was changed meanwhile in the fields shown here only
						const latest = d.habits.find((h) => h.id === original.id);
						const expected = latest && deepEqual(edited(latest), edited(original)) ? latest : original;
						return updateHabit(d, original.id, draft, clock.today, now, expected);
					});
				else
					await workspace.edit(`Add “${name.trim()}”`, (d, now) => {
						const result = addHabit(d, draft, now);
						id = result.id;
						return result.data;
					});
			},
		);
		saving = false;
		if (saved && id !== null) onsaved(id);
	}
</script>

<Modal title={original ? 'Edit habit' : 'New habit'} {onclose}>
	<form
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<label for="habit-name">Name</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input id="habit-name" type="text" autocomplete="off" bind:value={name} autofocus required />

		<span class="label">Aim</span>
		<div class="row"><Segmented bind:value={aim} options={AIMS} label="Aim" /></div>

		<span class="label">Track</span>
		<div class="row">
			<Segmented bind:value={kind} options={KINDS} label="Track" />
			{#if kind === 'amount'}
				<!-- the goal's amount, then its unit: "30 min", how often follows below -->
				<div class="amount">
					<input class="target" type="text" inputmode="decimal" autocomplete="off" aria-label={aim === 'build' ? 'Goal' : 'At most'} placeholder={aim === 'build' ? 'Goal' : 'At most'} bind:value={targetText} />
					<input class="unit" type="text" autocomplete="off" aria-label="Unit" placeholder="Unit (min, km, …)" bind:value={unit} />
				</div>
			{/if}
		</div>

		<span class="label">How often</span>
		<div class="row"><Segmented bind:value={period} options={PERIODS} label="How often" /></div>
		{#if period === 'day'}
			<div class="days" role="group" aria-label="Weekdays">
				{#each weekdays as day (day)}
					<button type="button" class="day" aria-pressed={days.includes(day)} onclick={() => toggleDay(day)}>{weekdayName(day)}</button>
				{/each}
			</div>
		{/if}
		{#if kind === 'check' && period !== 'day'}
			<label for="habit-days">{aim === 'build' ? `Days per ${period}` : `Max days per ${period}`}</label>
			<div class="row">
				<input id="habit-days" class="target" type="text" inputmode="numeric" autocomplete="off" bind:value={targetText} />
			</div>
		{/if}
		{#if original && (goalChanged || kind !== original.kind)}<p class="muted note">{appliesToAll ? 'Applies to all days.' : 'The new goal counts from today on.'}</p>{/if}

		<label for="habit-start">Starts</label>
		<DateInput id="habit-start" bind:value={start} />

		<ColorPicker bind:value={color} />

		{#if failure}<p class="error" role="alert">{failure}</p>{/if}
		<div class="buttons">
			{#if original}
				<div class="item-actions">
					<button type="button" aria-label="Move up" title="Move up" disabled={!current || !canmove(current, -1)} onclick={() => current && onmove(current, -1)}>↑</button>
					<button type="button" aria-label="Move down" title="Move down" disabled={!current || !canmove(current, 1)} onclick={() => current && onmove(current, 1)}>↓</button>
					<button type="button" onclick={() => onarchive(original)}>{original.archived ? 'Unarchive' : 'Archive'}</button>
					<button type="button" class="danger" onclick={() => ondelete(original)}>Delete</button>
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
		gap: 0.6rem;
	}
	label,
	.label,
	.muted {
		color: var(--muted);
	}
	.row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}
	/* the goal's amount and its unit stay together (on a phone: on a line of their own) */
	.amount {
		display: flex;
		gap: 0.5rem;
		flex: 1 1 14rem;
		min-width: 0;
	}
	.unit {
		flex: 1 1 8rem;
		min-width: 0;
		width: 0;
	}
	.target {
		width: 7rem;
	}
	/* one row, also on a phone */
	.days {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: 0.25rem;
		max-width: 26rem;
	}
	.day {
		padding: 0.35rem 0;
		min-width: 0;
		font-size: 0.85rem;
	}
	.day[aria-pressed='true'] {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-text);
	}
	.note {
		margin: 0;
		font-size: 0.85rem;
	}
	.error {
		color: var(--negative);
		margin: 0;
	}
	.danger {
		color: var(--negative);
	}
</style>
