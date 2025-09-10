<script lang="ts">
	let {
		video_el = $bindable<HTMLVideoElement | null>(null),
		countdown_value,
		flash_active,
		current_emotion,
		run_session,
		retake_all_for_day,
		root_handle,
		session_running,
		process_day_cutouts,
		processing_cutouts
	} = $props<{
		video_el: HTMLVideoElement | null;
		countdown_value: number;
		flash_active: boolean;
		current_emotion: string;
		run_session: () => void;
		retake_all_for_day: () => void;
		root_handle: FileSystemDirectoryHandle | null;
		session_running: boolean;
		process_day_cutouts: () => void;
		processing_cutouts: boolean;
	}>();

	import { dateState } from '$lib/DateState.svelte';
</script>

<div class="video-wrapper">
	<video bind:this={video_el} autoplay playsinline></video>
	{#if countdown_value > 0}
		<div class="overlay countdown">
			<h2>{countdown_value}</h2>
			{#if current_emotion}<p>pose: {current_emotion}</p>{/if}
		</div>
	{/if}
	{#if flash_active}
		<div class="overlay flash"></div>
	{/if}
</div>
<div class="session-buttons">
	<button onclick={run_session} disabled={session_running || !root_handle}
		>capture all emotions (today)</button
	>
	<button onclick={retake_all_for_day} disabled={session_running || !dateState.selected_day}
		>retake all for selected day</button
	>
	<button
		onclick={process_day_cutouts}
		disabled={session_running || !dateState.selected_day || processing_cutouts}
	>
		{processing_cutouts ? 'processing...' : 'process cutouts'}
	</button>
</div>

<style>
	.video-wrapper {
		position: relative;
		max-width: 500px;
		padding: 5px;
		background: var(--black);
		margin: 1rem auto;
		box-shadow: var(--shadow-screen);
	}
	video {
		display: block;
		width: 100%;
	}
	.overlay {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		color: white;
		font-size: 3rem;
		pointer-events: none;
	}
	.countdown h2 {
		font-family: 'Calculator';
		margin: 0;
	}
	.flash {
		background: white;
		animation: flash 120ms ease;
	}
	@keyframes flash {
		from {
			opacity: 1;
		}
		to {
			opacity: 0;
		}
	}
	.session-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}
</style>
