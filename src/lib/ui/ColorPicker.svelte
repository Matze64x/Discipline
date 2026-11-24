<!--
	A color: picked with the browser's color chooser (the square) or typed as hex ("#3a7", "#33aa77").
	Values are "#rrggbb", like in the data.
-->
<script lang="ts">
	let { value = $bindable(), label = 'Color' }: { value: string; label?: string } = $props();
	const id = `color-${Math.random().toString(36).slice(2)}`;

	/** "#rgb" or "#rrggbb" (the # is optional, any case) as "#rrggbb", or null */
	function parseHex(text: string): string | null {
		const hex = text.trim().replace(/^#/, '').toLowerCase();
		if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(hex)) return null;
		return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`;
	}

	let hexText = $state(value);
	// follow the color chooser, but not while the hex field is being typed in
	let typing = $state(false);
	$effect(() => {
		const current = value;
		if (!typing) hexText = current;
	});
	const hexInvalid = $derived(hexText.trim() !== '' && parseHex(hexText) === null);
</script>

<label for={id}>{label}</label>
<div class="color">
	<input
		type="color"
		aria-label="Choose a color"
		title="Choose a color"
		{value}
		oninput={(e) => (value = e.currentTarget.value.toLowerCase())}
	/>
	<input
		{id}
		class="hex"
		type="text"
		autocomplete="off"
		spellcheck="false"
		aria-invalid={hexInvalid}
		value={hexText}
		onfocus={() => (typing = true)}
		onblur={() => {
			typing = false;
			hexText = value;
		}}
		oninput={(e) => {
			hexText = e.currentTarget.value;
			const parsed = parseHex(hexText);
			if (parsed) value = parsed;
		}}
	/>
</div>
{#if hexInvalid}<p class="error" role="alert">Enter a hex color like #33aa77</p>{/if}

<style>
	label {
		color: var(--muted);
	}
	.color {
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}
	input[type='color'] {
		width: 2.5rem;
		height: 2.5rem;
		padding: 0.2rem;
		cursor: pointer;
	}
	.hex {
		width: 8rem;
		font-family: ui-monospace, monospace;
	}
	.error {
		color: var(--negative);
		font-size: 0.85rem;
		margin: 0;
	}
</style>
