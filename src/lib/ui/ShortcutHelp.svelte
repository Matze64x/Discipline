<script lang="ts">
	import { displayKeys, shortcuts } from '../shortcuts.svelte';
	import Modal from './Modal.svelte';

	let { onclose }: { onclose: () => void } = $props();

	const groups = $derived.by(() => {
		const byGroup = new Map<string, { keys: string; description: string }[]>();
		for (const s of shortcuts.available()) {
			const list = byGroup.get(s.group) ?? [];
			list.push({ keys: s.keys.map(displayKeys).join(' / '), description: s.description });
			byGroup.set(s.group, list);
		}
		return [...byGroup];
	});
</script>

<Modal title="Keyboard shortcuts" {onclose} wide>
	<div class="groups">
		{#each groups as [group, list] (group)}
			<section>
				<h3>{group}</h3>
				<dl>
					{#each list as item (item.keys)}
						<dt><kbd>{item.keys}</kbd></dt>
						<dd>{item.description}</dd>
					{/each}
				</dl>
			</section>
		{/each}
	</div>
	<p class="hint">Tab and Shift+Tab move between fields. <kbd>Esc</kbd> closes.</p>
	<div class="buttons"><button class="primary" onclick={onclose}>Close</button></div>
</Modal>

<style>
	.groups {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
		gap: 0 2rem;
		max-height: 65dvh;
		overflow: auto;
	}
	h3 {
		font-size: 0.95rem;
		margin: 0.5rem 0;
		color: var(--muted);
	}
	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.35rem 1rem;
		margin: 0;
	}
	dt {
		white-space: nowrap;
	}
	dd {
		margin: 0;
	}
	kbd {
		font: 0.85rem ui-monospace, monospace;
		border: 1px solid var(--control-border);
		border-radius: 0.3rem;
		padding: 0 0.3rem;
	}
	.hint {
		color: var(--muted);
		font-size: 0.9rem;
	}
	.buttons {
		display: flex;
		justify-content: flex-end;
	}
</style>
