<script lang="ts">
	// Monster avatar showcase: transparent + alive. Demonstrates (1) transparency
	// on multiple backgrounds and (2) CSS-driven movement (bob/sway + breathing
	// glow) over the static state sprites. Assets: static/avatars/monster/<state>.png
	import { base } from '$app/paths';

	const STATES = [
		'idle',
		'listening',
		'thinking',
		'speaking',
		'working',
		'done',
		'greeting',
		'sleepy'
	] as const;

	let idx = $state(0);
	let playing = $state(true);
	const current = $derived(STATES[idx]);

	$effect(() => {
		if (!playing) return;
		const t = setInterval(() => {
			idx = (idx + 1) % STATES.length;
		}, 1400);
		return () => clearInterval(t);
	});

	const img = (s: string) => `${base}/avatars/monster/${s}.png`;
</script>

<div class="flex min-h-[100dvh] flex-col items-center gap-8 bg-[#050505] p-5 text-zinc-200">
	<header class="text-center">
		<h1 class="text-lg font-semibold text-brand-soft">Sully — alive &amp; transparent</h1>
		<p class="text-xs text-zinc-500">she's moving · cycling states · drop her on any background</p>
	</header>

	<!-- HERO: animated sprite + breathing ambient glow -->
	<div class="relative flex h-64 w-64 items-center justify-center">
		<div class="sully-glow absolute h-48 w-48 rounded-[var(--r-pill)]"></div>
		<img
			src={img(current)}
			alt={current}
			class="sully-alive relative z-10 h-56 w-56 object-contain"
		/>
	</div>
	<span
		class="-mt-4 rounded-[var(--r-pill)] bg-brand/20 px-3 py-1 text-sm font-medium text-brand-soft"
		>{current}</span
	>

	<div class="flex flex-wrap justify-center gap-2">
		{#each STATES as s, n (s)}
			<button
				onclick={() => {
					idx = n;
					playing = false;
				}}
				class="rounded-[var(--r-sm)] border px-3 py-1 text-xs transition active:scale-95 {current ===
				s
					? 'border-brand bg-brand/10 text-brand-soft'
					: 'border-zinc-800 text-zinc-400'}">{s}</button
			>
		{/each}
		<button
			onclick={() => (playing = !playing)}
			class="rounded-[var(--r-sm)] border border-zinc-700 px-3 py-1 text-xs text-zinc-300"
			>{playing ? 'pause' : 'play'}</button
		>
	</div>

	<!-- TRANSPARENCY PROOF -->
	<div class="w-full max-w-md">
		<div class="mb-2 text-center text-xs text-zinc-500">
			transparency check — no box on any background:
		</div>
		<div class="grid grid-cols-3 gap-3">
			<div class="flex flex-col items-center gap-1">
				<div
					class="flex h-28 w-full items-center justify-center rounded-[var(--r-md)] bg-[#050505] ring-1 ring-zinc-800"
				>
					<img src={img(current)} alt="" class="h-24 w-24 object-contain" />
				</div>
				<span class="text-[10px] text-zinc-600">app dark</span>
			</div>
			<div class="flex flex-col items-center gap-1">
				<div
					class="flex h-28 w-full items-center justify-center rounded-[var(--r-md)]"
					style="background:linear-gradient(135deg,#c4186a,#3a0a22)"
				>
					<img src={img(current)} alt="" class="h-24 w-24 object-contain" />
				</div>
				<span class="text-[10px] text-zinc-600">magenta</span>
			</div>
			<div class="flex flex-col items-center gap-1">
				<div class="flex h-28 w-full items-center justify-center rounded-[var(--r-md)] bg-zinc-200">
					<img src={img(current)} alt="" class="h-24 w-24 object-contain" />
				</div>
				<span class="text-[10px] text-zinc-600">light</span>
			</div>
		</div>
	</div>

	<!-- STATE BOARD -->
	<div class="w-full max-w-md">
		<div class="mb-2 text-xs text-zinc-500">all 8 states (transparent)</div>
		<div class="grid grid-cols-4 gap-2">
			{#each STATES as s (s)}
				<div
					class="flex flex-col items-center gap-1 rounded-[var(--r-sm)] border border-zinc-900 p-2"
				>
					<img src={img(s)} alt={s} class="h-16 w-16 object-contain" />
					<span class="text-[9px] text-zinc-600">{s}</span>
				</div>
			{/each}
		</div>
	</div>
</div>

<style>
	.sully-alive {
		animation: sully-bob 3s ease-in-out infinite;
		transform-origin: center bottom;
	}
	.sully-glow {
		background: radial-gradient(circle, rgba(255, 77, 148, 0.55) 0%, rgba(255, 77, 148, 0) 70%);
		animation: sully-glow 3s ease-in-out infinite;
	}
	@keyframes sully-bob {
		0%,
		100% {
			transform: translateY(0) rotate(0deg);
		}
		25% {
			transform: translateY(-7px) rotate(-2.5deg);
		}
		50% {
			transform: translateY(-2px) rotate(0deg);
		}
		75% {
			transform: translateY(-7px) rotate(2.5deg);
		}
	}
	@keyframes sully-glow {
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
</style>
