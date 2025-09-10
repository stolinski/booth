<script lang="ts">
	let { root_handle, pick_root } = $props<{
		root_handle: FileSystemDirectoryHandle | null;
		pick_root: () => void;
	}>();
</script>

<div class="root-manager">
	<button onclick={pick_root} disabled={!!root_handle}>
		{root_handle ? 'root picked' : 'pick root folder'}
	</button>
	{#if root_handle}<span> dir: {(root_handle as any).name}</span>{/if}
</div>

<style>
	.root-manager {
		margin-bottom: 1rem;
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: center;
	}
	button[disabled] {
		opacity: 0.6;
		cursor: not-allowed;
	}
</style>
