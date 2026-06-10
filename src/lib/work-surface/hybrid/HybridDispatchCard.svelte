<!-- src/lib/work-surface/hybrid/HybridDispatchCard.svelte -->
<!--
  FEATURE FLAG: hybrid-surface
  URL PARAM: ?hybrid-surface=1
  This is the Stage 1 C+B Hybrid Work Surface component.
-->
<script lang="ts">
	import { Collapsible } from 'bits-ui';
	import { crossfade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { base } from '$app/paths';
	import type { SeedSurface } from './hybrid-types';
	import { deriveAggr } from './aggregate';
	import HybridDispatchPill from './HybridDispatchPill.svelte';
	import HybridWorkerCluster from './HybridWorkerCluster.svelte';

	let {
		surface,
		forceExpanded = false,
		onOpenDetail
	}: {
		surface: SeedSurface;
		forceExpanded?: boolean;
		onOpenDetail?: () => void;
	} = $props();

	let expanded = $state(false);
	let cardEl = $state<HTMLElement | null>(null);

	// Stop — abort the running worker. surface.surfaceId IS the trace_id.
	let stopping = $state(false);
	async function stopTask(e: MouseEvent) {
		e.stopPropagation(); // don't toggle the collapsible
		if (stopping) return;
		stopping = true;
		try {
			await fetch(`${base}/api/chat/dispatch/stop`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ trace_id: surface.surfaceId })
			});
		} catch {
			stopping = false;
		}
	}

	const aggr = $derived(deriveAggr(surface.workers));
	const effectiveExpanded = $derived(forceExpanded || expanded);

	const cleanElapsed = $derived(surface.elapsedDisplay.replace(/^[✓✕■]\s*/, ''));
	const showWorkerLanes = $derived(surface.workers.length > 1);

	const hasFiles = $derived(surface.files.length > 0);
	const generatingCount = $derived(surface.files.filter((f) => f.status === 'generating').length);

	const filesSummary = $derived(
		generatingCount > 0 && generatingCount === surface.files.length
			? 'Generating…'
			: (() => {
					const ext: Record<string, number> = {};
					for (const f of surface.files) {
						const e = (f.path.split('.').pop() ?? '?').toUpperCase();
						ext[e] = (ext[e] ?? 0) + 1;
					}
					const top2 = Object.entries(ext)
						.slice(0, 2)
						.map(([k, v]) => `${v} ${k}`)
						.join(', ');
					return `${surface.files.length} file${surface.files.length > 1 ? 's' : ''} — ${top2}`;
				})()
	);

	const isActive = $derived(aggr === 'running' || aggr === 'needs-you');

	const PHASE_LABELS: Record<string, string> = {
		read: 'Read',
		research: 'Research',
		build: 'Build',
		check: 'Check',
		approve: 'Approve',
		reply: 'Reply'
	};

	const AGGR_LABELS: Record<string, string> = {
		running: 'Running',
		'needs-you': 'Needs you',
		blocked: 'Blocked',
		done: 'Done',
		failed: 'Failed',
		stopped: 'Stopped'
	};

	// Devin-style phase lines (step history of active worker)
	const activeWorker = $derived(
		surface.workers.find((w) => w.status === 'running') ??
			surface.workers.find((w) => w.status === 'needs-you') ??
			surface.workers[0]
	);

	const phaseLines = $derived.by(() => {
		// Prefer the humanized activity log from the adapter when present: those
		// descriptions are plain English with file paths / tool names baked in
		// ("CC is reading src/app.css") instead of raw enum names ("reading").
		const fromActivity = (surface.activity ?? [])
			.map((a) => a.description)
			.filter((s, i, arr) => i === 0 || s !== arr[i - 1]); // dedupe consecutive
		if (fromActivity.length > 0) return fromActivity.slice(-5);

		// Fallback to the worker's raw stepHistory (older adapter payloads).
		if (!activeWorker) return [];
		const last = activeWorker.stepHistory[activeWorker.stepHistory.length - 1];
		const lines =
			activeWorker.currentStep && activeWorker.currentStep !== last
				? [...activeWorker.stepHistory, activeWorker.currentStep]
				: [...activeWorker.stepHistory];
		return lines.slice(-5);
	});

	const skippedPhases = $derived(surface.phases.filter((p) => p.status === 'skipped'));

	// Crossfade animation for active worker's step changes
	const [send, receive] = crossfade({
		duration: 220,
		easing: cubicOut
	});

	// View Transitions progressive enhancement on State A ↔ B morph
	function toggleExpanded() {
		const next = !expanded;
		const doc = typeof document !== 'undefined' ? document : null;
		const motionOK = !prefersReducedMotion();
		if (doc && 'startViewTransition' in doc && motionOK) {
			(doc as Document & { startViewTransition(cb: () => void): unknown }).startViewTransition(
				() => {
					expanded = next;
				}
			);
		} else {
			expanded = next;
		}
	}

	function prefersReducedMotion(): boolean {
		if (typeof window === 'undefined') return false;
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	$effect(() => {
		if (forceExpanded) expanded = true;
	});

	// ── One-shot animations (spawn / complete / fail) ──
	let prevAggr = $state<string | null>(null);
	let showRing = $state(false);

	$effect(() => {
		if (!cardEl) return;
		cardEl.classList.add('anim-spawn');
		cardEl.addEventListener('animationend', () => cardEl?.classList.remove('anim-spawn'), {
			once: true
		});
	});

	$effect(() => {
		let ringTimer: ReturnType<typeof setTimeout> | undefined;
		const current = aggr;
		if (prevAggr === null) {
			prevAggr = current;
			return;
		}
		if (prevAggr === current) return;

		if (current === 'done') {
			showRing = true;
			ringTimer = setTimeout(() => {
				showRing = false;
			}, 500);
		}
		if (current === 'failed' && cardEl) {
			cardEl.classList.remove('anim-fail');
			void cardEl.offsetWidth; // force reflow
			cardEl.classList.add('anim-fail');
			cardEl.addEventListener('animationend', () => cardEl?.classList.remove('anim-fail'), {
				once: true
			});
		}
		prevAggr = current;
		return () => clearTimeout(ringTimer);
	});
</script>

<div bind:this={cardEl} class="card-wrap" style="position: relative;" data-testid="hybrid-card">
	{#if showRing}
		<div class="complete-ring-el anim-ring" aria-hidden="true"></div>
	{/if}

	<Collapsible.Root bind:open={expanded} class="collapsible">
		<Collapsible.Trigger
			class="trigger-btn"
			onclick={(e: MouseEvent) => {
				if (forceExpanded) return;
				e.preventDefault();
				toggleExpanded();
			}}
		>
			<HybridDispatchPill {surface} {aggr} expanded={effectiveExpanded} />
		</Collapsible.Trigger>

		<Collapsible.Content class="hybrid-content">
			<div
				class="expanded-container"
				class:expanded-container--needs={aggr === 'needs-you'}
				class:expanded-container--failed={aggr === 'failed'}
				class:expanded-container--done={aggr === 'done'}
				class:expanded-container--stopped={aggr === 'stopped'}
				class:expanded-container--running={aggr === 'running'}
				class:expanded-container--blocked={aggr === 'blocked'}
			>
				<!-- Simpler header (no duplicate title/elapsed between Pill and Expanded header) -->
				<div class="card-header">
					<HybridWorkerCluster workers={surface.workers} />
					<span class="card-title">{surface.title}</span>
					{#if isActive}
						<button
							class="stop-btn"
							type="button"
							onclick={stopTask}
							disabled={stopping}
							data-testid="card-stop"
						>
							{stopping ? 'Stopping…' : 'Stop'}
						</button>
					{/if}
				</div>

				<!-- Stage spine -->
				<div class="stage-spine" aria-hidden="true">
					{#each surface.phases as phase}
						<div
							class="stage-pip stage-pip--{phase.status}"
							title="{PHASE_LABELS[phase.key]}: {phase.status}"
						></div>
					{/each}
				</div>

				<!-- Worker lanes (dimmed done workers, never removed) -->
				{#if showWorkerLanes}
					<div class="worker-lanes" data-testid="worker-lanes">
						{#each surface.workers as worker (worker.id)}
							<div
								class="worker-lane-row"
								class:worker-lane-row--done={worker.status === 'done' ||
									worker.status === 'stopped'}
								data-testid="worker-lane-row"
								data-worker-status={worker.status}
							>
								<div class="lane-dot lane-dot--{worker.status}" aria-hidden="true"></div>
								<svg
									width="12"
									height="12"
									viewBox="0 0 24 24"
									style="color: {worker.color}; flex: none;"
									aria-hidden="true"
								>
									<use href="#{worker.iconId}" />
								</svg>
								<span class="lane-code">{worker.shortcode}</span>
								<span class="lane-step">{worker.currentStep}</span>
							</div>
						{/each}
					</div>
				{/if}

				<!-- Phase lines (Devin-style active worker history) -->
				{#if phaseLines.length > 0}
					<div class="phase-lines-devin">
						{#each phaseLines as line, i (line)}
							<div
								class="phase-line-devin"
								class:phase-line-devin--active={i === phaseLines.length - 1}
								class:phase-line-devin--done={i < phaseLines.length - 1}
								in:receive={{ key: line }}
								out:send={{ key: line }}
							>
								<span class="phase-dot-devin" aria-hidden="true"></span>
								<span class="phase-text-devin">{line}</span>
							</div>
						{/each}
					</div>
				{/if}

				<!-- Skipped phase rows (dashed pip + strike-through label + inline reason) -->
				{#each skippedPhases as phase (phase.key)}
					<div class="skipped-row" data-testid="skipped-row">
						<span class="skipped-pip" aria-hidden="true"></span>
						<span class="skipped-text-wrap">
							<span class="skipped-label">{PHASE_LABELS[phase.key]} skipped</span>
							{#if phase.reason}
								<span class="skipped-reason"> — {phase.reason.slice(0, 60)}</span>
							{/if}
						</span>
					</div>
				{/each}

				<!-- Needs-you banner (amber background + pulsing border + exact action + target path) -->
				{#if aggr === 'needs-you' && surface.needs}
					<div class="needs-banner" data-testid="needs-banner" role="alert">
						<span class="needs-text">
							Waiting — {surface.needs.action} in <strong>{surface.needs.target}</strong>
						</span>
						<button class="needs-approve-btn" type="button" disabled title="Coming soon"
							>Approve</button
						>
					</div>
				{/if}

				<!-- Blocked note (static amber, no pulse) -->
				{#if aggr === 'blocked' && surface.blockedBy}
					<div class="blocked-note" data-testid="blocked-note">
						Blocked — waiting on {surface.blockedBy}
					</div>
				{/if}

				<!-- Result files row (conditional on hasFiles) -->
				{#if hasFiles}
					<div class="result-files-row" data-testid="result-files-row">
						<svg
							width="13"
							height="13"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"
						>
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
							<polyline points="14 2 14 8 20 8" />
						</svg>
						<span class="files-summary">{filesSummary}</span>
						<button class="files-open-btn" type="button" onclick={onOpenDetail}>Open</button>
					</div>
				{/if}

				<!-- Complete row (always present when done, View result only when files exist) -->
				{#if aggr === 'done'}
					<div class="complete-row" data-testid="complete-row">
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							style="color: #4a9a6a;"
							aria-hidden="true"
						>
							<polyline points="20 6 9 17 4 12" />
						</svg>
						<span class="complete-text">Verified · {cleanElapsed}</span>
						{#if hasFiles}
							<button
								class="view-result-btn"
								data-testid="view-result-btn"
								type="button"
								onclick={onOpenDetail}>View result</button
							>
						{/if}
					</div>
				{/if}

				<!-- Failed row -->
				{#if aggr === 'failed'}
					<div class="complete-row complete-row--failed" data-testid="failed-row">
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							style="color: var(--color-st-fail);"
							aria-hidden="true"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
						<span class="complete-text" style="color: var(--color-st-fail);">
							Failed · {cleanElapsed}{surface.workers[0]?.currentStep
								? ' · ' + surface.workers[0].currentStep
								: ''}
						</span>
						<button class="view-result-btn" type="button" onclick={onOpenDetail}>View logs</button>
					</div>
				{/if}

				<!-- Stopped row (operator-initiated — neutral, not an error) -->
				{#if aggr === 'stopped'}
					<div class="complete-row complete-row--stopped" data-testid="stopped-row">
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							style="color: var(--color-edge-active);"
							aria-hidden="true"
						>
							<rect x="6" y="6" width="12" height="12" rx="1.5" />
						</svg>
						<span class="complete-text">Stopped · {cleanElapsed}</span>
						{#if hasFiles}
							<button class="view-result-btn" type="button" onclick={onOpenDetail}
								>View result</button
							>
						{/if}
					</div>
				{/if}

				<!-- Footer -->
				<div class="card-footer">
					<span class="footer-meta">
						{AGGR_LABELS[aggr] ?? aggr} · {surface.workers.length} worker{surface.workers.length > 1
							? 's'
							: ''}
					</span>
					<button class="detail-link" type="button" onclick={onOpenDetail}>
						More detail
						<svg
							width="11"
							height="11"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							aria-hidden="true"
						>
							<polyline points="9 18 15 12 9 6" />
						</svg>
					</button>
				</div>
			</div>
		</Collapsible.Content>
	</Collapsible.Root>
</div>

<style>
	.card-wrap {
		width: 100%;
		max-width: 100%;
		min-width: 0;
		box-sizing: border-box;
	}
	:global(.trigger-btn) {
		display: block !important;
		width: 100% !important;
		max-width: 100% !important;
		min-width: 0 !important;
		box-sizing: border-box !important;
		border: none;
		background: none;
		padding: 0;
		cursor: pointer;
		text-align: left;
	}

	/* ── Slide Animations on Collapsible Content ── */
	:global(.hybrid-content[data-state='open']) {
		animation: slide-in var(--dur-slow) var(--ease-emphasized);
	}
	:global(.hybrid-content[data-state='closed']) {
		animation: slide-out var(--dur-base) ease;
	}
	@keyframes slide-in {
		from {
			opacity: 0;
			transform: translateY(-6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@keyframes slide-out {
		from {
			opacity: 1;
		}
		to {
			opacity: 0;
			transform: translateY(-4px);
		}
	}

	/* ── Expanded container ── */
	.expanded-container {
		margin-top: 8px;
		background: var(--color-surface);
		border: 1px solid var(--color-edge);
		border-radius: var(--r-md);
		overflow: hidden;
		font-size: 13px;
	}
	.expanded-container--running {
		border-color: color-mix(in srgb, var(--color-st-run) 30%, var(--color-edge));
	}
	.expanded-container--needs {
		border-color: var(--color-st-needs);
	}
	.expanded-container--failed {
		border-color: var(--color-st-fail);
	}
	.expanded-container--done {
		opacity: 0.78;
	}

	/* ── Card header ── */
	.card-header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px 8px;
		border-bottom: 1px solid var(--color-edge);
	}
	.card-title {
		flex: 1;
		font-weight: 500;
		font-size: 13.5px;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--color-text, #e8eaf0);
	}
	.stop-btn {
		font-size: 11.5px;
		color: var(--color-st-fail);
		border: 1px solid var(--color-st-fail);
		background: transparent;
		border-radius: var(--r-xs);
		padding: 4px 10px;
		cursor: pointer;
		min-height: 44px; /* iOS hygiene */
		white-space: nowrap;
	}

	/* ── Stage spine ── */
	.stage-spine {
		display: flex;
		align-items: center;
		gap: 3px;
		padding: 6px 14px 8px;
	}
	.stage-pip {
		flex: 1;
		height: 3px;
		border-radius: var(--r-xs);
		background: var(--color-surface-raised);
		transition: background var(--dur-slow) var(--ease-standard);
	}
	.stage-pip--done {
		background: var(--color-st-done);
	}
	.stage-pip--active {
		background: var(--color-brand);
	}
	.stage-pip--failed {
		background: var(--color-st-fail);
	}
	.stage-pip--needs-you {
		background: var(--color-st-needs);
	}
	.stage-pip--blocked {
		background: var(--color-st-needs);
		opacity: 0.5;
	}
	.stage-pip--skipped {
		background: transparent;
		border: 1.5px dashed var(--color-edge-active);
		opacity: 0.4;
	}

	/* ── Worker lanes ── */
	.worker-lanes {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 8px 14px 4px;
		border-bottom: 1px solid var(--color-edge);
	}
	.worker-lane-row {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 4px 0;
		font-size: 12px;
		color: var(--color-st-done);
	}
	.worker-lane-row--done {
		opacity: 0.45;
	}
	.lane-dot {
		width: 5px;
		height: 5px;
		border-radius: var(--r-pill);
		flex: none;
	}
	.lane-dot--running {
		background: var(--color-st-run);
		animation: breath 1.8s ease-in-out infinite;
	}
	.lane-dot--needs-you {
		background: var(--color-st-needs);
	}
	.lane-dot--done {
		background: var(--color-st-done);
	}
	.lane-dot--failed {
		background: var(--color-st-fail);
	}
	.lane-code {
		font-size: 10px;
		font-weight: 700;
		padding: 1px 4px;
		border-radius: var(--r-xs);
		background: var(--color-surface-raised);
		color: var(--color-st-done);
		flex: none;
	}
	.lane-step {
		flex: 1;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	/* ── Devin-style active worker step history ── */
	.phase-lines-devin {
		padding: 10px 14px;
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.phase-line-devin {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		color: var(--color-st-done);
	}
	.phase-line-devin--active {
		color: var(--color-text, #e8eaf0);
	}
	.phase-line-devin--active .phase-text-devin::after {
		content: '▌';
		animation: blink 0.9s step-start infinite;
		color: var(--color-brand);
		margin-left: 2px;
	}
	.phase-dot-devin {
		width: 6px;
		height: 6px;
		border-radius: var(--r-pill);
		flex: none;
		background: var(--color-st-done);
	}
	.phase-line-devin--active .phase-dot-devin {
		background: var(--color-st-run);
	}

	/* ── Skipped row ── */
	.skipped-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 14px;
		opacity: 0.38;
	}
	.skipped-pip {
		width: 6px;
		height: 6px;
		border-radius: var(--r-pill);
		border: 1.5px dashed var(--color-edge-active);
		flex: none;
	}
	.skipped-text-wrap {
		font-size: 12.5px;
		display: inline-flex;
		align-items: baseline;
	}
	.skipped-label {
		text-decoration: line-through;
		text-decoration-color: rgba(255, 255, 255, 0.2);
		color: var(--color-st-done);
	}
	.skipped-reason {
		font-style: italic;
		font-size: 11px;
		color: var(--color-st-done);
		margin-left: 2px;
	}

	/* ── Needs-you banner ── */
	.needs-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		background: rgba(201, 163, 78, 0.07);
		border-top: 1px solid rgba(201, 163, 78, 0.2);
		animation: needs-border-pulse 1.1s ease-in-out infinite;
	}
	.needs-text {
		flex: 1;
		font-size: 12.5px;
		color: var(--color-st-needs);
		line-height: 1.4;
	}
	.needs-approve-btn {
		font-size: 12px;
		font-weight: 600;
		color: var(--color-background, #0a0a0b);
		background: var(--color-st-needs);
		border: none;
		border-radius: var(--r-sm);
		padding: 6px 14px;
		cursor: pointer;
		min-height: 44px; /* iOS hygiene */
		white-space: nowrap;
	}

	/* ── Blocked note ── */
	.blocked-note {
		padding: 8px 14px;
		font-size: 12px;
		color: var(--color-st-needs);
		border-top: 1px solid rgba(201, 163, 78, 0.15);
	}

	/* ── Result files row ── */
	.result-files-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 14px;
		border-top: 1px solid var(--color-edge);
		font-size: 12px;
		color: var(--color-st-done);
	}
	.files-summary {
		flex: 1;
	}
	.files-open-btn {
		font-size: 11.5px;
		border: 1px solid var(--color-edge);
		background: transparent;
		color: var(--color-st-done);
		border-radius: var(--r-xs);
		padding: 3px 10px;
		cursor: pointer;
		min-height: 44px; /* iOS hygiene */
	}

	/* ── Complete / Failed rows ── */
	.complete-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		border-top: 1px solid var(--color-edge);
	}
	.complete-text {
		flex: 1;
		font-size: 12px;
		color: var(--color-st-done);
	}
	.view-result-btn {
		font-size: 12px;
		border: 1px solid var(--color-edge);
		background: transparent;
		color: var(--color-st-done);
		border-radius: var(--r-xs);
		padding: 4px 10px;
		cursor: pointer;
		min-height: 44px; /* iOS hygiene */
	}

	/* ── Footer ── */
	.card-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 14px;
		border-top: 1px solid var(--color-edge);
	}
	.footer-meta {
		font-size: 11.5px;
		color: var(--color-st-done);
	}
	.detail-link {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11.5px;
		color: var(--color-st-done);
		background: none;
		border: none;
		cursor: pointer;
		padding: 4px 0;
		min-height: 44px; /* iOS hygiene */
	}

	/* ── Animations ── */
	@keyframes breath {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}
	@keyframes blink {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0;
		}
	}
	@keyframes card-spawn {
		from {
			opacity: 0;
			transform: scale(0.94);
		}
		to {
			opacity: 1;
			transform: scale(1);
		}
	}
	@keyframes complete-ring {
		from {
			transform: scale(1);
			opacity: 0.7;
		}
		to {
			transform: scale(1.55);
			opacity: 0;
		}
	}
	@keyframes failure-shake {
		0% {
			transform: translateX(0);
		}
		20% {
			transform: translateX(-3px);
		}
		40% {
			transform: translateX(3px);
		}
		60% {
			transform: translateX(-2px);
		}
		80% {
			transform: translateX(2px);
		}
		100% {
			transform: translateX(0);
		}
	}
	@keyframes needs-border-pulse {
		0%,
		100% {
			border-color: rgba(201, 163, 78, 0.2);
		}
		50% {
			border-color: rgba(201, 163, 78, 0.6);
		}
	}

	.card-wrap:global(.anim-spawn) {
		animation: card-spawn var(--dur-slow) var(--ease-emphasized) both;
	}
	.card-wrap:global(.anim-fail) {
		animation: failure-shake var(--dur-med) ease-out both;
	}

	.complete-ring-el {
		position: absolute;
		inset: -1px;
		border-radius: inherit;
		border: 1.5px solid var(--color-st-done);
		pointer-events: none;
	}
	.complete-ring-el.anim-ring {
		animation: complete-ring var(--dur-panel) ease-out both;
	}

	@media (prefers-reduced-motion: reduce) {
		.lane-dot--running,
		.phase-line-devin--active .phase-text-devin::after,
		.needs-banner {
			animation: none !important;
		}
		.card-wrap:global(.anim-spawn),
		.card-wrap:global(.anim-fail),
		.complete-ring-el.anim-ring {
			animation: none !important;
		}
	}
</style>
