<script lang="ts">
	import { dateState } from '$lib/DateState.svelte.ts';
	let {
		emotion_list,
		day_photos,
		retake_one,
		session_running,
		current_emotion_index,
		media_stream,
		day_list,
		change_day
	} = $props<{
		emotion_list: string[];
		day_photos: Record<string, { handle: FileSystemFileHandle; url: string }>;
		retake_one: (emotion: string) => void;
		session_running: boolean;
		current_emotion_index: number;
		media_stream: MediaStream | null;
		day_list: string[];
		change_day: (day: string) => void;
	}>();
</script>

<div class="day-feed">
	<select
		bind:value={dateState.selected_day}
		onchange={(e) => change_day((e.target as HTMLSelectElement).value)}
	>
		{#each day_list as d}
			<option value={d}>{d}</option>
		{/each}
	</select>
	{#if dateState.selected_day}
		<ul class="gallery">
			{#each emotion_list as emo, i}
				<li>
					<span>{emo}</span>
					{#if day_photos[emo]}
						<img alt={emo} src={day_photos[emo].url} />
						<button disabled={session_running} onclick={() => retake_one(emo)}>retake</button>
					{:else}
						<span class="missing">missing</span>
						<button disabled={session_running || !media_stream} onclick={() => retake_one(emo)}
							>capture</button
						>
					{/if}
					{#if session_running && current_emotion_index === i}<span class="capturing"
							>(capturing...)</span
						>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.gallery {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		padding: 0;
		list-style: none;
		background: var(--black);
		box-shadow: var(--shadow-screen);
		margin: 0 0 1rem;
	}
	.gallery li {
		color: var(--bg);
		position: relative;
		display: block;
		margin: 0;
		overflow: hidden;
	}
	.gallery li span:first-child {
		background: var(--black);
		position: absolute;
		text-transform: uppercase;
		display: block;
		font-size: 12px;
		inset-inline: 0;
		padding: 2px 5px;
	}
	.gallery img {
		width: 100%;
		display: block;
	}
	button {
		position: absolute;
		bottom: 4px;
		left: 4px;
	}
	.missing {
		position: absolute;
		top: 0;
	}
	.capturing {
		position: absolute;
		bottom: 4px;
		right: 4px;
		font-size: 11px;
	}
</style>
