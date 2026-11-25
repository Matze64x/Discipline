<!--
	A modal dialog: traps the focus, closes on Escape, and returns the focus where it was when it
	closes. While it's open, only shortcuts marked `inDialog` apply. Enter in a dropdown submits the
	dialog's form like in a text field (browsers don't do that by themselves). A held Enter doesn't
	repeat: one press, one submit (else holding it submitted once per key repeat).
-->
<script lang="ts">
	import { accentStyle } from '../palette';
	import type { Snippet } from 'svelte';
	import { shortcuts } from '../shortcuts.svelte';

	let {
		title,
		onclose,
		wide = false,
		closeButton = false,
		color = null,
		children,
	}: {
		title: string;
		onclose: () => void;
		wide?: boolean;
		/** An × next to the title, which stays on top while the dialog scrolls (for long dialogs) */
		closeButton?: boolean;
		/** A habit's color ("#rrggbb") to use as the accent (its dialogs); null: the app's */
		color?: string | null;
		children: Snippet;
	} = $props();

	let dialog: HTMLDialogElement;
	const id = `dialog-${Math.random().toString(36).slice(2)}`;

	// closing because the component goes away (e.g. replaced by the next dialog) isn't the user
	// closing it, so `onclose` must not fire then
	let unmounting = false;

	/**
	 * Takes the focus out of the dialog before it closes. Otherwise mobile WebKit scrolled the page
	 * to the focused text field's caret, which (no longer on top) sits at the end of the page.
	 */
	function releaseFocus() {
		const focused = document.activeElement;
		if (focused instanceof HTMLElement && dialog.contains(focused)) focused.blur();
	}
	$effect(() => {
		const closeScope = shortcuts.openDialog();
		dialog.showModal();
		// Without a field marked `autofocus` (where data is entered), the dialog itself takes the
		// focus: browsers would focus its first control (e.g. a dropdown in Settings) on their own.
		if (!dialog.querySelector('[autofocus]')) dialog.focus();
		return () => {
			unmounting = true;
			closeScope();
			releaseFocus();
			dialog.close();
		};
	});
</script>

<dialog
	bind:this={dialog}
	style={color ? accentStyle(color) : undefined}
	tabindex="-1"
	class:wide
	aria-labelledby={id}
	oncancel={releaseFocus}
	onclose={() => {
		if (!unmounting) onclose();
	}}
	onkeydown={(event) => {
		if (event.key === 'Enter' && event.repeat) return event.preventDefault();
		const target = event.target;
		if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || !(target instanceof HTMLSelectElement)) return;
		event.preventDefault();
		target.form?.requestSubmit();
	}}
>
	{#if closeButton}
		<div class="title-bar">
			<h2 {id}>{title}</h2>
			<button type="button" class="close" aria-label="Close" title="Close (Esc)" onclick={onclose}>×</button>
		</div>
	{:else}
		<h2 {id}>{title}</h2>
	{/if}
	{@render children()}
</dialog>

<style>
	dialog {
		width: min(32rem, calc(100vw - 2rem));
		max-height: calc(100dvh - 2rem);
		border: 1px solid var(--border);
		border-radius: 0.75rem;
		background: var(--surface);
		color: var(--text);
		padding: 1.25rem;
		overflow: auto;
	}
	dialog.wide {
		width: min(52rem, calc(100vw - 2rem));
	}
	dialog:focus {
		outline: none;
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.4);
	}
	h2 {
		margin: 0 0 1rem;
		font-size: 1.2rem;
		overflow-wrap: anywhere;
	}
	.title-bar {
		position: sticky;
		top: -1.25rem;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin: -1.25rem -1.25rem 1rem;
		padding: 1.25rem 1.25rem 0.5rem;
		background: var(--surface);
	}
	.title-bar h2 {
		margin: 0;
	}
	.close {
		flex: none;
		min-width: 2.75rem;
		min-height: 2.75rem;
		padding: 0;
		font-size: 1.5rem;
		line-height: 1;
	}
	/* phones: full screen, like a native sheet */
	@media (max-width: 40rem) {
		dialog,
		dialog.wide {
			width: 100vw;
			max-width: 100vw;
			height: 100dvh;
			max-height: 100dvh;
			margin: 0;
			border: none;
			border-radius: 0;
			padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom))
				max(1rem, env(safe-area-inset-left));
		}
		.title-bar {
			top: calc(-1 * max(1rem, env(safe-area-inset-top)));
			margin: calc(-1 * max(1rem, env(safe-area-inset-top))) calc(-1 * max(1rem, env(safe-area-inset-right))) 1rem
				calc(-1 * max(1rem, env(safe-area-inset-left)));
			padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) 0.5rem max(1rem, env(safe-area-inset-left));
		}
	}
</style>
