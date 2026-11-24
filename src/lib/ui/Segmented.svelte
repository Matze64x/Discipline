<!-- A choice between a few options shown side by side (a radio group: Tab in, arrow keys choose). -->
<script lang="ts" generics="T extends string">
	let { value = $bindable(), options, label, disabled = false }: { value: T; options: readonly { value: T; label: string }[]; label: string; disabled?: boolean } = $props();
	const name = `segmented-${Math.random().toString(36).slice(2)}`;
</script>

<div class="segmented" role="radiogroup" aria-label={label}>
	{#each options as option (option.value)}
		<label class:checked={value === option.value} class:disabled>
			<input type="radio" {name} value={option.value} bind:group={value} {disabled} />
			{option.label}
		</label>
	{/each}
</div>

<style>
	.segmented {
		display: inline-flex;
		border: 1px solid var(--control-border);
		border-radius: 0.5rem;
		overflow: hidden;
		font-size: 0.9rem;
	}
	label {
		position: relative;
		padding: 0.3rem 0.7rem;
		cursor: pointer;
		color: var(--muted);
	}
	label + label {
		border-left: 1px solid var(--control-border);
	}
	label.checked {
		background: var(--accent-soft);
		color: var(--text);
		font-weight: 600;
	}
	label.disabled {
		cursor: default;
		opacity: 0.6;
	}
	/* the radio itself is invisible; its label shows the state */
	input {
		position: absolute;
		inset: 0;
		opacity: 0;
		margin: 0;
		min-height: 0;
		cursor: inherit;
	}
	label:has(input:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
</style>
