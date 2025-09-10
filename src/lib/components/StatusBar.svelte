<script lang="ts">
	import type { Snippet } from 'svelte';

	let { status_msg, children } = $props<{ status_msg: string; children: Snippet }>();
</script>

<div class="status">
	<div class="glare"></div>
	<p>status: {status_msg}</p>
	{@render children?.()}
</div>

<style>
	.status {
		box-shadow: var(--shadow-screen);
		background: var(--black);
		color: white;
		font-size: 14px;
		padding: 5px 20px;
		overflow: hidden;
		position: relative;
	}
</style>
