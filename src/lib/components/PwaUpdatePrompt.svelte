<script lang="ts">
	import { onMount } from 'svelte';
	import { RefreshCw, X } from 'lucide-svelte';

	let waitingWorker = $state<ServiceWorker | null>(null);
	let showPrompt = $state(false);
	let refreshing = false;

	function applyUpdate() {
		if (!waitingWorker) return;
		waitingWorker.postMessage({ type: 'SKIP_WAITING' });
	}

	onMount(() => {
		if (!('serviceWorker' in navigator)) return;

		let registration: ServiceWorkerRegistration | undefined;

		const onControllerChange = () => {
			if (refreshing) return;
			refreshing = true;
			window.location.reload();
		};

		const watchRegistration = (reg: ServiceWorkerRegistration) => {
			registration = reg;
			if (reg.waiting) {
				waitingWorker = reg.waiting;
				showPrompt = true;
			}

			reg.addEventListener('updatefound', () => {
				const worker = reg.installing;
				if (!worker) return;

				worker.addEventListener('statechange', () => {
					if (worker.state === 'installed' && navigator.serviceWorker.controller) {
						waitingWorker = worker;
						showPrompt = true;
					}
				});
			});
		};

		navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
		navigator.serviceWorker.ready.then(watchRegistration).catch(() => {
			/* no-op: PWA update prompt is progressive enhancement */
		});

		return () => {
			navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
			registration?.update().catch(() => {
				/* best-effort stale check before teardown */
			});
		};
	});
</script>

{#if showPrompt}
	<div
		class="fixed top-3 right-3 left-3 z-[110] mx-auto flex max-w-sm items-center gap-2 rounded-[var(--r-md)] border border-[var(--live-line)] bg-zinc-950/95 p-2.5 text-zinc-100 shadow-[var(--shadow-float)] shadow-black/40 backdrop-blur-md"
		style="top: calc(env(safe-area-inset-top, 0px) + 0.75rem);"
		data-testid="pwa-update-prompt"
	>
		<RefreshCw size={16} class="shrink-0 text-[var(--accent)]" aria-hidden="true" />
		<div class="min-w-0 flex-1 text-xs leading-snug font-medium">A Companion update is ready.</div>
		<button
			type="button"
			class="h-9 shrink-0 rounded-[var(--r-sm)] bg-gradient-to-br from-[#7c84e8] to-[#5e6ad2] px-3 text-xs font-semibold text-white transition-transform active:scale-95"
			onclick={applyUpdate}
		>
			Update
		</button>
		<button
			type="button"
			class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-white"
			aria-label="Dismiss update prompt"
			onclick={() => (showPrompt = false)}
		>
			<X size={14} aria-hidden="true" />
		</button>
	</div>
{/if}
