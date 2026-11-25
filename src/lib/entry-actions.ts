/**
 * What can be done to a habit's day (Today and Week views): check off, set, add to or complete an
 * amount. Each goes through `workspace.edit` (undoable) and shows a failure instead of throwing.
 */
import { addToEntry, remainingOf, setEntry, toggleCheck, type CivilDate, type Habit, type Progress } from '../core';
import { attempt } from './attempt';
import { formatValue } from './display';
import { showError } from './notices.svelte';
import type { Workspace } from './workspace.svelte';

/** Checks a check habit off on a day, or unchecks it (`done`: whether it's checked off now) */
export function toggleDay(workspace: Workspace, habit: Habit, day: CivilDate, done: boolean) {
	const label = `${done ? 'Uncheck' : 'Check off'} “${habit.name}”`;
	return attempt(showError, () => workspace.edit(label, (d, now) => toggleCheck(d, habit.id, day, now)));
}

/** Sets what was done on a day (null: nothing) */
export function setDay(workspace: Workspace, habit: Habit, day: CivilDate, value: number | null) {
	const label = value === null ? `Clear “${habit.name}”` : `Enter “${habit.name}”`;
	return attempt(showError, () => workspace.edit(label, (d, now) => setEntry(d, habit.id, day, value, now)));
}

/** Adds to an amount habit's day */
export function addToDay(workspace: Workspace, habit: Habit, day: CivilDate, amount: number, label = `Add ${formatValue(amount)} to “${habit.name}”`) {
	return attempt(showError, () => workspace.edit(label, (d, now) => addToEntry(d, habit.id, day, amount, now)));
}

/** Whether "complete" can add something: an amount habit, due that day, its goal not met yet */
export function canComplete(habit: Habit, progress: Progress): boolean {
	return habit.kind === 'amount' && progress.due && remainingOf(progress) > 0;
}

/** Adds what's missing to meet the goal of the day's period (nothing if it's met or not due) */
export function completeDay(workspace: Workspace, habit: Habit, day: CivilDate, progress: Progress) {
	if (!canComplete(habit, progress)) return Promise.resolve(false);
	return addToDay(workspace, habit, day, remainingOf(progress), `Complete “${habit.name}”`);
}
