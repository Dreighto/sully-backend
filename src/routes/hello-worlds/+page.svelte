<script lang="ts">
	const GREETINGS = [
		{ lang: 'English', text: 'Hello, World!' },
		{ lang: 'Spanish', text: '¡Hola, Mundo!' },
		{ lang: 'French', text: 'Bonjour, Monde!' },
		{ lang: 'Japanese', text: 'こんにちは、世界！' },
		{ lang: 'Arabic', text: 'مرحبا، عالم!' },
		{ lang: 'Russian', text: 'Привет, Мир!' },
		{ lang: 'Mandarin', text: '你好，世界！' },
		{ lang: 'Portuguese', text: 'Olá, Mundo!' },
		{ lang: 'Hindi', text: 'नमस्ते, दुनिया!' },
		{ lang: 'Swahili', text: 'Habari, Dunia!' },
		{ lang: 'Korean', text: '안녕하세요, 세계!' },
		{ lang: 'Greek', text: 'Γεια σου, Κόσμε!' }
	] as const;

	let active = $state(0);

	$effect(() => {
		const t = setInterval(() => {
			active = (active + 1) % GREETINGS.length;
		}, 2200);
		return () => clearInterval(t);
	});

	const current = $derived(GREETINGS[active]);
</script>

<div
	class="flex min-h-[100dvh] flex-col items-center justify-center gap-10 bg-[#050505] p-6 text-zinc-200"
>
	<header class="text-center">
		<h1 class="text-2xl font-semibold text-brand-soft">Hello, Worlds</h1>
		<p class="mt-1 text-xs text-zinc-500">one greeting, every language</p>
	</header>

	<!-- Hero greeting -->
	<div
		class="flex min-h-28 flex-col items-center justify-center gap-2 rounded-2xl border border-brand/20 bg-brand/5 px-8 py-6 text-center transition-all duration-500"
	>
		<span class="text-3xl font-bold tracking-tight text-brand-soft">{current.text}</span>
		<span class="text-xs text-zinc-500">{current.lang}</span>
	</div>

	<!-- Grid of all greetings -->
	<div class="grid w-full max-w-lg grid-cols-2 gap-2 sm:grid-cols-3">
		{#each GREETINGS as g, i (g.lang)}
			<button
				onclick={() => (active = i)}
				class="rounded-xl border px-3 py-2 text-left transition-all active:scale-95 {active === i
					? 'border-brand/50 bg-brand/10 text-brand-soft'
					: 'border-zinc-800 text-zinc-400 hover:border-zinc-700'}"
			>
				<div class="text-sm font-medium">{g.text}</div>
				<div class="text-[10px] text-zinc-600">{g.lang}</div>
			</button>
		{/each}
	</div>
</div>
