<script lang="ts">
	import type { PipelineStage } from '$lib/types/workSurface';
	import {
		BookOpen,
		Search,
		Hammer,
		ClipboardCheck,
		ShieldCheck,
		MessageCircle,
		type Icon
	} from 'lucide-svelte';

	let {
		stage,
		pulse = false,
		size = 13
	}: {
		stage: PipelineStage;
		pulse?: boolean;
		size?: number;
	} = $props();

	const STAGE_ICONS: Record<PipelineStage, typeof Icon> = {
		Read: BookOpen,
		Research: Search,
		Build: Hammer,
		Check: ClipboardCheck,
		Approve: ShieldCheck,
		Reply: MessageCircle
	};

	const IconCmp = $derived(STAGE_ICONS[stage]);
</script>

<span class="stage-act-icon" class:stage-act-icon--pulse={pulse} aria-hidden="true">
	{#if IconCmp}
		<IconCmp {size} strokeWidth={2.25} />
	{/if}
</span>

<style lang="postcss">
	.stage-act-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.375rem;
		height: 1.375rem;
		border-radius: var(--r-xs);
		border: 1px solid rgb(255 255 255 / 0.1);
		background: rgb(255 255 255 / 0.04);
		color: rgb(255 255 255 / 0.78);
		box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.06);
		transition:
			transform 0.28s cubic-bezier(0.22, 1, 0.36, 1),
			box-shadow 0.28s ease,
			border-color 0.28s ease,
			color 0.28s ease;
	}

	.stage-act-icon--pulse {
		animation: stage-act-pop 0.85s cubic-bezier(0.22, 1, 0.36, 1);
		border-color: rgb(255 255 255 / 0.22);
		color: rgb(255 255 255 / 0.96);
		box-shadow:
			inset 0 1px 0 rgb(255 255 255 / 0.12),
			0 0 16px rgb(255 255 255 / 0.14);
	}

	@keyframes stage-act-pop {
		0% {
			transform: scale(0.82);
			opacity: 0.55;
		}
		45% {
			transform: scale(1.08);
			opacity: 1;
		}
		100% {
			transform: scale(1);
			opacity: 1;
		}
	}
</style>
