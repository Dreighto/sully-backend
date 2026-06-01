<script lang="ts">
	// The "● Sully" name-tag pill — a rounded brand-colored chip with a radial-
	// gradient dot + a label. Extracted from chat/+page.svelte where this exact
	// markup was duplicated in three places (assistant message header, thinking
	// indicator, tool-call row). Markup + classes + the dot's inline gradient
	// style are copied VERBATIM from the original so appearance is byte-for-byte
	// identical; only the label text varies per usage.
	let { label }: { label: string } = $props();
</script>

<div
	class="mb-1.5 flex w-fit items-center gap-1.5 rounded-full border border-brand/30 bg-brand/[0.08] px-2.5 py-0.5 font-sans text-[11px] font-semibold tracking-wide text-brand-soft select-none"
>
	<span
		class="h-2 w-2 shrink-0 rounded-full"
		style="background: radial-gradient(circle at 30% 25%, #ff8fc0, #ec2d78 55%, #c4186a); box-shadow: 0 0 6px rgba(236, 45, 120, 0.6);"
	></span>
	<span>{label}</span>
</div>
