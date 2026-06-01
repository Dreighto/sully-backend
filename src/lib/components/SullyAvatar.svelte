<script lang="ts">
	// Sully's avatar. Renders the locked monster sprite for a given state, with
	// per-state CSS motion (so she's alive, not a flat sticker) + an optional
	// breathing magenta glow. Frame-animation can later swap the static <img>
	// for a sprite-strip player without changing this component's API.
	import { base } from '$app/paths';

	export type AvatarState =
		| 'idle'
		| 'listening'
		| 'thinking'
		| 'speaking'
		| 'working'
		| 'done'
		| 'greeting'
		| 'sleepy';

	let {
		state = 'idle',
		size = 112,
		glow = true
	}: { state?: AvatarState; size?: number; glow?: boolean } = $props();

	const src = $derived(`${base}/avatars/monster/${state}.png`);
</script>

<div class="wrap" style="--sz:{size}px">
	{#if glow}<div class="glow"></div>{/if}
	<img {src} alt="Sully" class="sprite s-{state}" draggable="false" />
</div>

<style>
	.wrap {
		position: relative;
		width: var(--sz);
		height: var(--sz);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.glow {
		position: absolute;
		inset: 6%;
		border-radius: 9999px;
		background: radial-gradient(circle, rgba(255, 77, 148, 0.5) 0%, rgba(255, 77, 148, 0) 70%);
		animation: g 3.2s ease-in-out infinite;
	}
	.sprite {
		position: relative;
		z-index: 1;
		width: 100%;
		height: 100%;
		object-fit: contain;
		transform-origin: center bottom;
		will-change: transform;
	}

	.s-idle {
		animation: bob 3.4s ease-in-out infinite;
	}
	.s-listening {
		animation: perk 1.8s ease-in-out infinite;
	}
	.s-thinking {
		animation: sway 2.6s ease-in-out infinite;
	}
	.s-speaking {
		animation: talk 0.9s ease-in-out infinite;
	}
	.s-working {
		animation: work 1.4s ease-in-out infinite;
	}
	.s-done {
		animation: pop 1.1s ease-out;
	}
	.s-greeting {
		animation: wave 1.6s ease-in-out infinite;
	}
	.s-sleepy {
		animation: sleep 4.5s ease-in-out infinite;
	}

	@keyframes bob {
		0%,
		100% {
			transform: translateY(0) rotate(0);
		}
		25% {
			transform: translateY(-6px) rotate(-2deg);
		}
		50% {
			transform: translateY(-1px);
		}
		75% {
			transform: translateY(-6px) rotate(2deg);
		}
	}
	@keyframes perk {
		0%,
		100% {
			transform: translateY(0) scale(1);
		}
		50% {
			transform: translateY(-4px) scale(1.04);
		}
	}
	@keyframes sway {
		0%,
		100% {
			transform: rotate(-3deg);
		}
		50% {
			transform: rotate(3deg);
		}
	}
	@keyframes talk {
		0%,
		100% {
			transform: translateY(0) scale(1, 1);
		}
		50% {
			transform: translateY(-2px) scale(1.03, 0.97);
		}
	}
	@keyframes work {
		0%,
		100% {
			transform: translateY(0) rotate(0);
		}
		30% {
			transform: translateY(-8px) rotate(-3deg);
		}
		60% {
			transform: translateY(-2px) rotate(3deg);
		}
	}
	@keyframes pop {
		0% {
			transform: scale(0.8);
		}
		50% {
			transform: scale(1.12);
		}
		100% {
			transform: scale(1);
		}
	}
	@keyframes wave {
		0%,
		100% {
			transform: rotate(-6deg);
		}
		50% {
			transform: rotate(6deg);
		}
	}
	@keyframes sleep {
		0%,
		100% {
			transform: translateY(0) scale(1, 1);
		}
		50% {
			transform: translateY(2px) scale(1.02, 0.98);
		}
	}
	@keyframes g {
		0%,
		100% {
			opacity: 0.3;
			transform: scale(0.92);
		}
		50% {
			opacity: 0.6;
			transform: scale(1.08);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.sprite,
		.glow {
			animation: none !important;
		}
	}
</style>
