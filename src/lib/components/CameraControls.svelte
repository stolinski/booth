<script lang="ts">
	let {
		video_devices,
		selected_device_id = $bindable(''),
		start_stream,
		session_running
	} = $props<{
		video_devices: MediaDeviceInfo[];
		selected_device_id: string;
		start_stream: () => void;
		session_running: boolean;
	}>();
</script>

<div class="camera-controls">
	<label
		>camera:
		<select bind:value={selected_device_id} onchange={start_stream} disabled={session_running}>
			{#each video_devices as d}
				<option value={d.deviceId}>{d.label || 'camera'}</option>
			{/each}
		</select>
	</label>
	<button onclick={start_stream} disabled={session_running}>start camera</button>
</div>

<style>
	.camera-controls {
		display: flex;
		gap: 1rem;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 1rem;
	}
	select {
		padding: 4px;
	}
</style>
