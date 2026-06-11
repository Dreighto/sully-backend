<script lang="ts">
	// PILL & ANIMATION GALLERY (replaces the pre-LOS-192 flow simulator, which
	// drove the RETIRED Sully-card Surface store — the operator opened it
	// 2026-06-11 and saw the old chrome with zero Lotties).
	//
	// Fixture-driven showcase of the CURRENT production components:
	//   A. live WorkerPill per worker — the real mount chain plays (brand
	//      reveal intro → working-state animation), labels via the LOS-205
	//      resolver (incl. glm/ki and the honest-unknown fallback);
	//   B. every brand-reveal Lottie from static/anim/manifest.json;
	//   C. every working-state Lottie from the manifest.
	// Tap a pill to open the real RunSheet on its fixture rows (LOS-193).
	import { base } from '$app/paths';
	import { onMount } from 'svelte';
	import WorkerPill from '$lib/work-surface/pill/WorkerPill.svelte';
	import WorkerStateAnim from '$lib/work-surface/pill/WorkerStateAnim.svelte';
	import type { StreamRow } from '$lib/chat/dispatchReconcile';

	const FIXTURE_WORKERS = [
		'claude-code',
		'gmi',
		'dpsk',
		'agy',
		'cdx',
		'glm',
		'ki',
		'mystery-bot'
	];

	const FIXTURE_ROWS: StreamRow[] = [
		{ seq: 1, action: 'reading', target: 'src/lib/work-surface/pill/pillModel.ts' },
		{ seq: 2, action: 'tool_invoked', target: 'npm run check' },
		{ seq: 3, action: 'writing_code', target: 'src/routes/+page.svelte' }
	];

	// Started 90s ago: live elapsed ticks, trust derives 'trusted', the intro
	// reveal plays once on mount — the same chain a real dispatch produces.
	const startedAtIso = new Date(Date.now() - 90_000).toISOString();

	interface Manifest {
		workerStates: Record<string, string>;
		workerBrands: Record<string, { primary: string; arrival?: string; ambient?: string }>;
	}
	let manifest = $state<Manifest | null>(null);
	let loadError = $state('');

	onMount(async () => {
		try {
			const r = await fetch(`${base}/anim/manifest.json`);
			if (!r.ok) throw new Error(`manifest ${r.status}`);
			manifest = await r.json();
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
		}
	});

	const brandEntries = $derived(
		manifest
			? Object.entries(manifest.workerBrands).flatMap(([worker, files]) =>
					Object.entries(files).map(([variant, file]) => ({
						label: variant === 'primary' ? worker : `${worker} — ${variant}`,
						file: `brand/${file}`
					}))
				)
			: []
	);
	const stateEntries = $derived(
		manifest
			? Object.entries(manifest.workerStates).map(([state, file]) => ({
					label: state,
					file: file.split('#')[0].trim()
				}))
			: []
	);
</script>

<div class="gallery">
	<header>
		<h1>Pill &amp; animation gallery</h1>
		<p>
			Fixture-driven, current production components. Pills below run the real mount chain —
			brand-reveal intro, then the working-state animation. Tap one for the run sheet.
		</p>
	</header>

	<h2>Live pills (one per worker — labels via the LOS-205 resolver)</h2>
	<div class="pills">
		{#each FIXTURE_WORKERS as w (w)}
			<div class="pill-row">
				<span class="worker-id">{w}</span>
				<WorkerPill
					traceId={`gallery-${w}`}
					rows={FIXTURE_ROWS}
					status="working"
					worker={w}
					brief={`Gallery fixture run for ${w}`}
					{startedAtIso}
					durationLabel={null}
				/>
			</div>
		{/each}
	</div>

	{#if loadError}
		<p class="err">manifest failed to load: {loadError}</p>
	{:else if manifest}
		<h2>Brand reveals</h2>
		<div class="grid">
			{#each brandEntries as e (e.file)}
				<figure>
					<WorkerStateAnim file={e.file} loop={true} size={56} />
					<figcaption>{e.label}</figcaption>
				</figure>
			{/each}
		</div>

		<h2>Working states</h2>
		<div class="grid">
			{#each stateEntries as e (e.file)}
				<figure>
					<WorkerStateAnim file={e.file} loop={true} size={56} />
					<figcaption>{e.label}</figcaption>
				</figure>
			{/each}
		</div>
		<p class="note">
			Gallery loops everything for inspection; in the app, done/failed play once and hold, and
			reduced-motion renders no animation at all (tint + stage dots carry the state).
		</p>
	{/if}
</div>

<style>
	.gallery {
		min-height: 100dvh;
		background: var(--bg0);
		color: var(--t1);
		padding: calc(env(safe-area-inset-top) + 16px) 16px calc(env(safe-area-inset-bottom) + 32px);
		font-family: var(--font-body);
	}
	header p {
		color: var(--t3);
		font-size: var(--text-sm);
		line-height: var(--leading-sm);
		max-width: 40rem;
	}
	h1 {
		font-family: var(--font-display);
		font-weight: var(--disp-weight);
		letter-spacing: var(--disp-track);
		font-size: var(--text-2xl);
		margin: 0 0 4px;
	}
	h2 {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		margin: 28px 0 12px;
	}
	.pills {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.pill-row {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.worker-id {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--t3);
		width: 6.5rem;
		flex-shrink: 0;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
		gap: 14px;
	}
	figure {
		margin: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 12px 6px;
		background: var(--surface-card);
		border: 1px solid var(--line);
		border-radius: var(--r-md);
	}
	figcaption {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--t3);
		text-align: center;
	}
	.err {
		color: var(--red);
	}
	.note {
		color: var(--t4);
		font-size: var(--text-xs);
		margin-top: 16px;
	}
</style>
