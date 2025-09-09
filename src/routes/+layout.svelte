<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import './style.css';
	let { children } = $props();
</script>

<svelte:head
	><link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
	<link
		href="https://fonts.googleapis.com/css2?family=Sometype+Mono:ital,wght@0,400..700;1,400..700&display=swap"
		rel="stylesheet"
	/>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children?.()}
