<script lang="ts">
	let { children } = $props();
</script>

<!-- Break out of the chat shell's overflow-hidden — this route must scroll on phone. -->
<div class="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain">
	{@render children()}
</div>
