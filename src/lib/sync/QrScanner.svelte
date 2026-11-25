<!--
	Reads a QR code with the camera (the back camera on phones). Calls `onfound` once with the code's
	text when `accept` likes it. The decoder (jsQR) is only loaded while scanning.
-->
<script lang="ts">
	import { onMount } from 'svelte';

	let { onfound, accept }: { onfound: (text: string) => void; accept: (text: string) => boolean } = $props();

	let video = $state<HTMLVideoElement>();
	let problem = $state<string | null>(null);
	let ignored = $state(false);

	onMount(() => {
		let stream: MediaStream | null = null;
		let frame = 0;
		let stopped = false;
		const canvas = document.createElement('canvas');
		const context = canvas.getContext('2d', { willReadFrequently: true })!;
		void (async () => {
			try {
				if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser can’t use the camera here.');
				// (one after the other: if loading the decoder failed, the camera mustn't stay on)
				const { default: jsQR } = await import('jsqr');
				const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
				stream = media;
				if (stopped || !video) return void media.getTracks().forEach((t) => t.stop());
				video.srcObject = media;
				await video.play();
				const scan = () => {
					if (stopped || !video) return;
					if (video.readyState >= 2 && video.videoWidth > 0) {
						canvas.width = video.videoWidth;
						canvas.height = video.videoHeight;
						context.drawImage(video, 0, 0);
						const image = context.getImageData(0, 0, canvas.width, canvas.height);
						const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
						if (code?.data) {
							if (accept(code.data)) {
								stopped = true;
								stream?.getTracks().forEach((t) => t.stop());
								return onfound(code.data);
							}
							ignored = true;
						}
					}
					frame = requestAnimationFrame(scan);
				};
				scan();
			} catch (e) {
				const name = e instanceof Error ? e.name : '';
				problem = name === 'NotAllowedError' ? 'Camera access is blocked. Allow it in the settings, or enter the code.' : `The camera can’t be used: ${e instanceof Error ? e.message : String(e)}`;
			}
		})();
		return () => {
			stopped = true;
			cancelAnimationFrame(frame);
			stream?.getTracks().forEach((t) => t.stop());
		};
	});
</script>

{#if problem}
	<p class="problem" role="alert">{problem}</p>
{:else}
	<!-- svelte-ignore a11y_media_has_caption (a live camera picture) -->
	<video bind:this={video} playsinline muted></video>
	<p class="hint">{ignored ? 'That’s not a Discipline code.' : 'Point the camera at the code the PC shows.'}</p>
{/if}

<style>
	video {
		width: 100%;
		max-height: 50vh;
		border-radius: 0.5rem;
		background: #000;
		object-fit: cover;
	}
	.hint {
		color: var(--muted);
		font-size: 0.9rem;
		margin: 0.25rem 0 0;
	}
	.problem {
		color: var(--negative);
	}
</style>
