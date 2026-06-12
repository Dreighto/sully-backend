<script lang="ts">
	import type { WorkSurfaceTask, PipelineStage, TaskState } from '$lib/types/workSurface';
	import StageTimeline from '$lib/components/StageTimeline.svelte';
	import StageActIcon from '$lib/components/StageActIcon.svelte';
	import WorkGraph from '$lib/components/WorkGraph.svelte';
	import WorkerRegistry from './WorkerRegistry.svelte';
	import ProofCard from './ProofCard.svelte';
	import { Check, X, Repeat } from 'lucide-svelte';
	import { slide } from 'svelte/transition';
	import { workerBrandColor, workerBreathFinishing } from '$lib/utils/workerVisual';
	import { compactGlanceTitle, compactLiveStep } from '$lib/utils/glanceText';

	let {
		task,
		footprint = 'compact',
		onapprove,
		onstop,
		onretry
	}: {
		task: WorkSurfaceTask;
		footprint?: 'collapsed' | 'compact' | 'expanded';
		onapprove?: () => void;
		onstop?: () => void;
		onretry?: () => void;
	} = $props();

	let confirmApprove = $state(false);
	let approveTimeout: ReturnType<typeof setTimeout> | null = null;

	// Unified shell: drill-down rows live inside the card (default collapsed).
	let openSections = $state<Set<string>>(new Set());
	function toggleSection(key: string) {
		if (openSections.has(key)) openSections.delete(key);
		else openSections.add(key);
		openSections = new Set(openSections);
	}

	// Cursor audit 2026-06-06: clear the approve-confirm timeout if the card is
	// destroyed mid-confirm so the timer doesn't leak.
	$effect(() => {
		return () => {
			if (approveTimeout) clearTimeout(approveTimeout);
		};
	});

	const activeWorker = $derived(task.workers.find((w) => w.status === 'active'));

	const rawWorkerStep = $derived(
		activeWorker?.step ||
			task.workers[0]?.step ||
			(task.state === 'Waiting' ? 'Awaiting operator action' : 'Awaiting instructions')
	);

	const glanceTitle = $derived(compactGlanceTitle(task.title));
	const glanceStep = $derived(compactLiveStep(rawWorkerStep));

	const ownershipColor = $derived(
		activeWorker
			? workerBrandColor(activeWorker.identity, activeWorker.shortCode)
			: 'var(--color-st-run)'
	);
	const ownershipFinishing = $derived(activeWorker ? workerBreathFinishing(activeWorker) : false);

	const isInMotion = $derived(
		task.state !== 'Complete' && task.state !== 'Stopped' && task.state !== 'Failed'
	);

	const displayApproveButton = $derived(
		task.state === 'Waiting' && task.block?.kind === 'approval'
	);
	const displayStopButton = $derived(isInMotion);
	const displayRetryButton = $derived(task.state === 'Failed' || task.state === 'Stopped');

	const showSurfaceActions = $derived(
		displayApproveButton || displayStopButton || displayRetryButton
	);

	const activeWorkerCount = $derived(task.workers.filter((w) => w.status === 'active').length);

	function handleApprove() {
		if (task.isDestructive && !confirmApprove) {
			confirmApprove = true;
			if (approveTimeout) clearTimeout(approveTimeout);
			approveTimeout = setTimeout(() => {
				confirmApprove = false;
				approveTimeout = null;
			}, 3000); // Reset confirm state after 3 seconds
		} else {
			if (approveTimeout) clearTimeout(approveTimeout);
			onapprove?.();
			confirmApprove = false;
		}
	}

	function handleStop() {
		onstop?.();
	}

	function handleRetry() {
		onretry?.();
	}

	const percent = $derived.by(() => {
		if (task.state === 'Complete') return 100;

		const stages = task.stageProgress.filter((s) => s.status !== 'skipped');
		if (stages.length === 0) return 0;

		const done = stages.filter((s) => s.status === 'done').length;
		const active = stages.find((s) => s.status === 'active');
		if (!active) {
			return Math.min(100, Math.round((done / stages.length) * 100));
		}

		// Partial credit on the live stage — full weight when it's the final Reply handoff.
		const activeWeight = active.stage === 'Reply' ? 0.85 : 0.4;
		const progress = (done + activeWeight) / stages.length;
		return Math.min(100, Math.round(progress * 100));
	});

	const progressBarClass = $derived.by(() => {
		if (task.state === 'Waiting' || task.state === 'Stopped') return 'progress-needs';
		if (task.state === 'Complete') return 'progress-done';
		if (task.state === 'Failed') return 'progress-fail';
		return 'progress-run';
	});

	let stageActPulse = $state(false);
	let prevStage: PipelineStage = task.stage;
	$effect(() => {
		const stage = task.stage;
		if (stage !== prevStage) {
			stageActPulse = true;
			prevStage = stage;
			const t = setTimeout(() => {
				stageActPulse = false;
			}, 900);
			return () => clearTimeout(t);
		}
	});

	const dotColorClass = $derived.by(() => {
		if (
			task.state === 'Working' ||
			task.state === 'Reading' ||
			task.state === 'Planning' ||
			task.state === 'Reviewing' ||
			task.state === 'Delivering'
		) {
			return 'bg-st-run';
		} else if (task.state === 'Waiting') {
			return 'bg-st-needs';
		} else if (task.state === 'Complete') {
			return 'bg-st-done';
		} else if (task.state === 'Failed') {
			return 'bg-st-fail';
		} else {
			return 'bg-st-done';
		}
	});
</script>

<div
	class="work-surface-card state-{footprint} status-{task.state.toLowerCase()}"
	class:has-active-worker={activeWorker != null}
	style:--active-worker-color={ownershipColor}
>
	<!-- 1. COLLAPSED VIEW -->
	<div class="sully-collapsed-view" class:active={footprint === 'collapsed'}>
		<div class="collapsed-content">
			<span class="pulse-indicator status-{task.state.toLowerCase()}" class:in-motion={isInMotion}
			></span>
			<span class="collapsed-title">{task.state}</span>
			{#if task.workers.length > 0}
				<span class="collapsed-meta">{task.workers[0].shortCode}</span>
			{/if}
		</div>
	</div>

	<!-- 2. COMPACT CARD VIEW -->
	<div class="sully-compact-card" class:active={footprint === 'compact'}>
		<div class="card-header">
			<div class="header-left">
				<div class="header-text">
					<h1 class="task-title ws-title-compact" title={task.title}>{glanceTitle}</h1>
				</div>
			</div>
			<div class="header-right">
				<span class="status-pill status-{task.state.toLowerCase()}">{task.state}</span>
				{#if showSurfaceActions}
					<div class="surface-action-chips">
						{#if displayApproveButton}
							<button
								type="button"
								class="action-chip action-chip-approve ws-chip-label"
								onclick={handleApprove}
							>
								{#if confirmApprove && task.isDestructive}
									Confirm?
								{:else}
									<Check size="13" strokeWidth={2.5} /> Approve
								{/if}
							</button>
						{/if}
						{#if displayStopButton}
							<button
								type="button"
								class="action-chip action-chip-stop ws-chip-label"
								onclick={handleStop}
							>
								<X size="13" strokeWidth={2.5} /> Stop
							</button>
						{/if}
						{#if displayRetryButton}
							<button
								type="button"
								class="action-chip action-chip-retry ws-chip-label"
								onclick={handleRetry}
							>
								<Repeat size="13" strokeWidth={2.5} /> Retry
							</button>
						{/if}
					</div>
				{/if}
			</div>
		</div>

		<StageTimeline {task} />

		<!-- Central SVG Graph (Dynamic Worker-Task Layout) -->
		<div class="work-graph-slot">
			<WorkGraph {task} />
		</div>

		<!-- Active Ownership Banner — hero glance line (Package A heartbeat) -->
		{#if isInMotion}
			<div
				class="active-ownership-banner"
				class:banner-finishing={ownershipFinishing}
				style:--worker-color={ownershipColor}
			>
				<span
					class="ownership-pulse"
					class:worker-surface-dot-breath={isInMotion}
					class:worker-surface-breath--finishing={ownershipFinishing && isInMotion}
					style:background-color={ownershipColor}
				></span>
				<span class="ownership-text ws-live" title={rawWorkerStep}>{glanceStep}</span>
			</div>
		{/if}
	</div>

	<!-- 3. EXPANDED — unified shell: glance layer + inset drill-down -->
	<div class="sully-expanded-wrapper" class:active={footprint === 'expanded'}>
		<div class="surface-glance-layer">
			<div class="sully-expanded-card">
				<!-- 1. Status row + inline surface actions (iPhone glance — no chunky footer bar) -->
				<div class="expanded-top-row">
					<div class="expanded-status-line ws-eyebrow select-none">
						<span class="h-1.5 w-1.5 rounded-[var(--r-pill)] {dotColorClass}"></span>
						<span>{task.state} · {activeWorkerCount} active</span>
					</div>
					{#if showSurfaceActions}
						<div class="surface-action-chips">
							{#if displayApproveButton}
								<button
									type="button"
									class="action-chip action-chip-approve ws-chip-label"
									onclick={handleApprove}
								>
									{#if confirmApprove && task.isDestructive}
										Confirm?
									{:else}
										<Check size="13" strokeWidth={2.5} /> Approve
									{/if}
								</button>
							{/if}
							{#if displayStopButton}
								<button
									type="button"
									class="action-chip action-chip-stop ws-chip-label"
									onclick={handleStop}
								>
									<X size="13" strokeWidth={2.5} /> Stop
								</button>
							{/if}
							{#if displayRetryButton}
								<button
									type="button"
									class="action-chip action-chip-retry ws-chip-label"
									onclick={handleRetry}
								>
									<Repeat size="13" strokeWidth={2.5} /> Retry
								</button>
							{/if}
						</div>
					{/if}
				</div>

				<!-- 2. Title + slim stage rail -->
				<h2 class="expanded-title ws-title" title={task.title}>{glanceTitle}</h2>
				<div
					class="stage-progress-strip"
					class:strip-lively={isInMotion}
					role="progressbar"
					aria-valuenow={percent}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-label="{percent}% complete · {task.stage} stage"
				>
					<div class="stage-progress-meta ws-meta">
						<div class="stage-progress-meta-left">
							<StageActIcon stage={task.stage} pulse={stageActPulse} />
							<span>{task.stage}</span>
						</div>
						<span class="ws-meta-tabular">{percent}%</span>
					</div>
					<div
						class="stage-progress-track"
						class:track-lively={isInMotion && progressBarClass === 'progress-run'}
					>
						<div
							class="stage-progress-fill {progressBarClass}"
							class:fill-lively={isInMotion && progressBarClass === 'progress-run'}
							style:width="{percent}%"
						></div>
						{#if isInMotion && progressBarClass === 'progress-run'}
							<div
								class="progress-comet"
								style:left="clamp(4px, calc({percent}% - 1px), calc(100% - 4px))"
							></div>
						{/if}
					</div>
				</div>

				<!-- 3. Live routing graph — primary glance real estate -->
				{#if isInMotion}
					<div class="work-graph-slot work-graph-slot--inset">
						<WorkGraph {task} />
					</div>
				{/if}

				<!-- 4. Next banner — same heartbeat as graph nodes -->
				{#if isInMotion}
					<div
						class="active-ownership-banner"
						class:banner-finishing={ownershipFinishing}
						style:--worker-color={ownershipColor}
					>
						<span
							class="ownership-pulse"
							class:worker-surface-dot-breath={isInMotion}
							class:worker-surface-breath--finishing={ownershipFinishing && isInMotion}
							style:background-color={ownershipColor}
						></span>
						<span class="ownership-text ws-live" title={rawWorkerStep}>{glanceStep}</span>
					</div>
				{/if}
			</div>
		</div>

		<div class="surface-drill-layer" style:--worker-color={ownershipColor}>
			<p class="drill-rail-label ws-section-label">More detail</p>

			<button
				type="button"
				class="drill-accordion-btn"
				aria-expanded={openSections.has('pipeline')}
				onclick={() => toggleSection('pipeline')}
			>
				<span class="drill-accordion-title">
					{openSections.has('pipeline') ? '▾' : '▸'} Pipeline
				</span>
				<span class="drill-accordion-meta ws-meta ws-meta-tabular">
					{task.stage} · {percent}%
				</span>
			</button>
			{#if openSections.has('pipeline')}
				<div transition:slide={{ duration: 200 }} class="drill-accordion-body">
					<p class="pipeline-hint ws-meta">Stages march toward Reply — the delivery handoff.</p>
					<StageTimeline {task} showDurations />
				</div>
			{/if}

			<button
				type="button"
				class="drill-accordion-btn"
				aria-expanded={openSections.has('workers')}
				onclick={() => toggleSection('workers')}
			>
				<span class="drill-accordion-title">
					{openSections.has('workers') ? '▾' : '▸'} Worker registry ({task.workers.length})
				</span>
				<span class="drill-accordion-meta ws-meta ws-meta-tabular">
					{task.workers[0]?.shortCode ?? '—'}
					{task.workers.length > 1 ? `+${task.workers.length - 1}` : ''}
				</span>
			</button>
			{#if openSections.has('workers')}
				<div transition:slide={{ duration: 200 }} class="drill-accordion-body">
					<WorkerRegistry {task} />
				</div>
			{/if}

			<button
				type="button"
				class="drill-accordion-btn"
				aria-expanded={openSections.has('proof')}
				onclick={() => toggleSection('proof')}
			>
				<span class="drill-accordion-title">
					{openSections.has('proof') ? '▾' : '▸'} Proof
				</span>
				<span class="drill-accordion-meta ws-meta ws-meta-tabular"
					>{task.proof?.verdict ?? 'pending'}</span
				>
			</button>
			{#if openSections.has('proof') && task.proof}
				<div transition:slide={{ duration: 200 }} class="drill-accordion-body">
					<ProofCard {task} />
				</div>
			{/if}
		</div>
	</div>
</div>

<style lang="postcss">
	@reference "../../app.css";
	.work-surface-card {
		--ws-hairline: rgb(255 255 255 / 0.09);
		--ws-panel: rgb(255 255 255 / 0.035);
		--ws-panel-raised: rgb(255 255 255 / 0.055);
		--ws-radius: 0.75rem;

		@apply relative w-full overflow-hidden;
		min-height: 40px;
		border-radius: var(--ws-radius);
		border: 1px solid var(--ws-hairline);
		background:
			linear-gradient(
				165deg,
				rgb(255 255 255 / 0.075) 0%,
				rgb(255 255 255 / 0.02) 22%,
				rgb(0 0 0 / 0.15) 100%
			),
			rgb(10 10 12 / 0.78);
		-webkit-backdrop-filter: blur(22px) saturate(145%);
		backdrop-filter: blur(22px) saturate(145%);
		box-shadow:
			inset 0 1px 0 rgb(255 255 255 / 0.1),
			0 0 0 1px rgb(0 0 0 / 0.45),
			0 1px 2px rgb(0 0 0 / 0.28),
			0 18px 44px -28px rgb(0 0 0 / 0.9);
		transition:
			min-height 0.32s cubic-bezier(0.22, 1, 0.36, 1),
			box-shadow 0.32s cubic-bezier(0.22, 1, 0.36, 1),
			border-color 0.32s ease;
	}

	.state-expanded.work-surface-card {
		border-radius: var(--ws-radius);
	}

	.work-surface-card.has-active-worker {
		border-color: color-mix(
			in srgb,
			var(--active-worker-color, var(--color-st-run)) 28%,
			var(--ws-hairline)
		);
		box-shadow:
			inset 0 1px 0 rgb(255 255 255 / 0.1),
			0 0 0 1px
				color-mix(in srgb, var(--active-worker-color, var(--color-st-run)) 18%, rgb(0 0 0 / 0.5)),
			0 0 28px -14px
				color-mix(in srgb, var(--active-worker-color, var(--color-st-run)) 42%, transparent),
			0 18px 44px -28px rgb(0 0 0 / 0.9);
	}

	.work-surface-card.status-waiting,
	.work-surface-card.status-stopped {
		border-color: color-mix(in srgb, var(--color-st-needs) 24%, var(--ws-hairline));
		box-shadow:
			inset 0 1px 0 color-mix(in srgb, var(--color-st-needs) 14%, transparent),
			0 0 0 1px rgb(0 0 0 / 0.45),
			0 0 22px -14px color-mix(in srgb, var(--color-st-needs) 35%, transparent),
			0 18px 44px -28px rgb(0 0 0 / 0.9);
	}

	.work-surface-card.status-failed {
		border-color: color-mix(in srgb, var(--color-st-fail) 24%, var(--ws-hairline));
		box-shadow:
			inset 0 1px 0 color-mix(in srgb, var(--color-st-fail) 12%, transparent),
			0 0 0 1px rgb(0 0 0 / 0.45),
			0 0 22px -14px color-mix(in srgb, var(--color-st-fail) 32%, transparent),
			0 18px 44px -28px rgb(0 0 0 / 0.9);
	}

	.work-surface-card.status-complete {
		border-color: color-mix(in srgb, var(--color-status-green) 22%, var(--ws-hairline));
		box-shadow:
			inset 0 1px 0 color-mix(in srgb, var(--color-status-green) 12%, transparent),
			0 0 0 1px rgb(0 0 0 / 0.45),
			0 0 24px -12px color-mix(in srgb, var(--color-status-green) 38%, transparent),
			0 18px 44px -28px rgb(0 0 0 / 0.9);
		animation: rest-glow 4s ease-in-out infinite;
	}
	@keyframes rest-glow {
		0%,
		100% {
			box-shadow: 0 0 18px -10px var(--color-status-green);
		}
		50% {
			box-shadow: 0 0 28px -6px var(--color-status-green);
		}
	}

	/* Inner views — controlled by the .state-{footprint} class on the parent
	   .work-surface-card. Specificity is load-bearing here: each inner section
	   defines its own `@apply flex|grid|block` further down for content
	   layout, which has class-level specificity (0,1,0). If the hide rule
	   also has class-level specificity, the later-defined inner rule wins,
	   and ALL three footprints render simultaneously (caught 2026-06-07
	   when DispatchCard exposed it — operator saw 2 work-graphs). Prefixing
	   with .work-surface-card bumps the hide/show rules to (0,2,0) / (0,3,0)
	   so they always beat the inner layout rules. */
	.work-surface-card .sully-collapsed-view,
	.work-surface-card .sully-compact-card,
	.work-surface-card .sully-expanded-wrapper {
		display: none;
	}
	.work-surface-card.state-collapsed .sully-collapsed-view {
		display: flex;
	}
	.work-surface-card.state-compact .sully-compact-card {
		display: block;
	}
	.work-surface-card.state-expanded .sully-expanded-wrapper {
		display: flex;
	}

	/* 1. COLLAPSED VIEW */
	.sully-collapsed-view {
		@apply flex items-center justify-center p-3;
		height: 40px;
	}

	.collapsed-content {
		@apply flex items-center gap-2;
		font-size: 11px;
		font-weight: 500;
		color: var(--color-muted-foreground);
	}

	.pulse-indicator {
		@apply h-2 w-2 rounded-[var(--r-pill)];
	}
	.pulse-indicator.in-motion {
		animation: pulse 1.5s infinite ease-in-out;
	}
	.pulse-indicator:not(.in-motion) {
		animation: none;
	}

	.pulse-indicator.status-reading,
	.pulse-indicator.status-planning,
	.pulse-indicator.status-working,
	.pulse-indicator.status-reviewing,
	.pulse-indicator.status-delivering {
		background-color: var(--color-st-run);
	}
	.pulse-indicator.status-waiting,
	.pulse-indicator.status-stopped {
		background-color: var(--color-st-needs);
	}
	.pulse-indicator.status-failed {
		background-color: var(--color-st-fail);
	}
	.pulse-indicator.status-complete {
		background-color: var(--color-status-green);
	}

	@keyframes pulse {
		0% {
			transform: scale(0.8);
			opacity: 0.7;
		}
		50% {
			transform: scale(1);
			opacity: 1;
		}
		100% {
			transform: scale(0.8);
			opacity: 0.7;
		}
	}

	/* 2. COMPACT CARD VIEW */
	.sully-compact-card {
		@apply space-y-3 p-3;
		height: auto;
	}

	.card-header {
		@apply flex items-start justify-between gap-2;
	}

	.header-right {
		@apply flex flex-shrink-0 flex-col items-end gap-1.5;
	}

	.header-left {
		@apply flex min-w-0 flex-1 items-center gap-2;
	}

	.system-badge-icon {
		@apply flex-shrink-0 text-muted-foreground;
	}

	.header-text {
		@apply flex flex-col;
	}

	.card-label {
		@apply text-xs font-medium text-muted-foreground;
	}

	.task-title {
		@apply line-clamp-1;
	}

	.status-pill {
		@apply flex h-[22px] flex-shrink-0 items-center gap-1.5 rounded-[var(--r-pill)] border px-2.5 text-[10px] font-medium whitespace-nowrap;
		border-color: var(--ws-hairline);
		background: var(--ws-panel);
		color: rgb(255 255 255 / 0.82);
		box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.06);
	}

	.status-pill::before {
		content: '';
		width: 6px;
		height: 6px;
		border-radius: var(--r-pill);
		background: currentColor;
		opacity: 0.9;
		box-shadow: 0 0 8px currentColor;
	}

	.status-pill.status-reading,
	.status-pill.status-planning,
	.status-pill.status-working,
	.status-pill.status-reviewing,
	.status-pill.status-delivering {
		color: var(--color-st-run);
		border-color: color-mix(in srgb, var(--color-st-run) 28%, var(--ws-hairline));
		background: color-mix(in srgb, var(--color-st-run) 10%, var(--ws-panel));
	}
	.status-pill.status-waiting,
	.status-pill.status-stopped {
		color: var(--color-st-needs);
		border-color: color-mix(in srgb, var(--color-st-needs) 28%, var(--ws-hairline));
		background: color-mix(in srgb, var(--color-st-needs) 10%, var(--ws-panel));
	}
	.status-pill.status-failed {
		color: var(--color-st-fail);
		border-color: color-mix(in srgb, var(--color-st-fail) 28%, var(--ws-hairline));
		background: color-mix(in srgb, var(--color-st-fail) 10%, var(--ws-panel));
	}
	.status-pill.status-complete {
		color: var(--color-status-green);
		border-color: color-mix(in srgb, var(--color-status-green) 28%, var(--ws-hairline));
		background: color-mix(in srgb, var(--color-status-green) 10%, var(--ws-panel));
	}

	.work-graph-slot {
		@apply w-full;
		min-height: 108px;
	}

	.work-graph-slot--inset {
		@apply rounded-[var(--r-md)] border px-1.5 py-2;
		border-color: var(--ws-hairline);
		background:
			radial-gradient(120% 80% at 50% 0%, rgb(255 255 255 / 0.04), transparent 58%),
			rgb(0 0 0 / 0.35);
		box-shadow:
			inset 0 1px 0 rgb(255 255 255 / 0.05),
			inset 0 -12px 24px rgb(0 0 0 / 0.22);
		min-height: 100px;
	}

	.active-ownership-banner {
		@apply flex items-center gap-2 rounded-[var(--r-md)] border px-2.5 py-2;
		border-color: color-mix(
			in srgb,
			var(--worker-color, var(--color-st-run)) 22%,
			var(--ws-hairline)
		);
		background: linear-gradient(
			180deg,
			color-mix(in srgb, var(--worker-color, var(--color-st-run)) 10%, var(--ws-panel-raised)) 0%,
			var(--ws-panel) 100%
		);
		box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.06);
	}

	.ownership-pulse {
		@apply h-2.5 w-2.5 flex-shrink-0 rounded-[var(--r-pill)];
		box-shadow: 0 0 10px
			color-mix(in srgb, var(--worker-color, var(--color-st-run)) 55%, transparent);
	}

	.ownership-text {
		@apply line-clamp-1 min-w-0 flex-1;
	}

	.active-ownership-banner.banner-finishing .ownership-pulse {
		box-shadow: 0 0 14px
			color-mix(in srgb, var(--worker-color, var(--color-st-run)) 80%, transparent);
	}

	.surface-action-chips {
		@apply flex flex-shrink-0 flex-wrap items-center justify-end gap-1;
	}

	.action-chip {
		@apply inline-flex min-h-[32px] min-w-[32px] items-center justify-center gap-1 rounded-[var(--r-sm)] border px-2.5 transition-all select-none;
		border-color: var(--ws-hairline);
		background: var(--ws-panel);
		color: rgb(255 255 255 / 0.86);
		box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.06);
		-webkit-tap-highlight-color: transparent;
	}
	.action-chip:active {
		transform: scale(0.97);
		background: var(--ws-panel-raised);
	}

	.action-chip-approve {
		border-color: color-mix(in srgb, var(--color-st-needs) 32%, var(--ws-hairline));
		background: color-mix(in srgb, var(--color-st-needs) 11%, var(--ws-panel));
		color: color-mix(in srgb, var(--color-st-needs) 82%, white);
	}

	.action-chip-stop {
		border-color: color-mix(in srgb, var(--color-st-fail) 28%, var(--ws-hairline));
		background: color-mix(in srgb, var(--color-st-fail) 8%, var(--ws-panel));
		color: color-mix(in srgb, var(--color-st-fail) 82%, white);
	}

	.action-chip-retry {
		border-color: color-mix(in srgb, var(--color-st-needs) 24%, var(--ws-hairline));
		background: transparent;
		color: color-mix(in srgb, var(--color-st-needs) 78%, white);
	}

	/* 3. EXPANDED — unified shell layers */
	.sully-expanded-wrapper {
		@apply flex flex-col;
	}

	.surface-glance-layer {
		@apply px-3 pt-3 pb-2.5;
		background: linear-gradient(180deg, rgb(255 255 255 / 0.045) 0%, transparent 70%);
	}

	.sully-expanded-card {
		@apply space-y-2;
	}

	.expanded-top-row {
		@apply flex items-start justify-between gap-2;
	}

	.expanded-status-line {
		@apply flex min-w-0 flex-1 items-center gap-1.5;
	}

	.expanded-title {
		@apply line-clamp-1;
	}

	.stage-progress-strip {
		@apply mb-1 space-y-1.5;
	}

	.stage-progress-meta {
		@apply flex items-center justify-between gap-2;
	}

	.stage-progress-meta-left {
		@apply flex min-w-0 items-center gap-1.5;
	}

	.stage-progress-track {
		@apply relative h-1.5 w-full overflow-hidden rounded-[var(--r-pill)];
		background: rgb(255 255 255 / 0.05);
		box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.48);
	}

	.stage-progress-track.track-lively::before {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: repeating-linear-gradient(
			90deg,
			transparent,
			transparent calc(16.666% - 1px),
			rgb(255 255 255 / 0.07) calc(16.666% - 1px),
			rgb(255 255 255 / 0.07) 16.666%
		);
		pointer-events: none;
	}

	.stage-progress-fill {
		@apply relative z-[1] h-full rounded-[var(--r-pill)] transition-[width] duration-[var(--dur-long)] ease-out;
	}
	.stage-progress-fill.progress-run {
		background: linear-gradient(
			90deg,
			rgb(255 255 255 / 0.06) 0%,
			rgb(255 255 255 / 0.32) 52%,
			var(--color-progress-beam) 100%
		);
	}
	.stage-progress-fill.fill-lively {
		box-shadow:
			0 0 8px var(--color-progress-glow),
			0 0 18px rgb(255 255 255 / 0.12);
	}
	.stage-progress-fill.fill-lively::before {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: linear-gradient(
			90deg,
			transparent 0%,
			rgb(255 255 255 / 0.35) 48%,
			transparent 92%
		);
		background-size: 42% 100%;
		animation: progress-shimmer 2.2s ease-in-out infinite;
	}
	.progress-comet {
		position: absolute;
		top: 50%;
		z-index: 2;
		width: 9px;
		height: 9px;
		border-radius: var(--r-pill);
		transform: translate(-50%, -50%);
		background: var(--color-progress-beam);
		box-shadow:
			0 0 6px 1px var(--color-progress-glow),
			0 0 16px 3px rgb(255 255 255 / 0.22);
		pointer-events: none;
		animation: progress-comet-breathe 1.8s ease-in-out infinite alternate;
	}
	.strip-lively .stage-progress-track {
		box-shadow:
			inset 0 1px 2px rgb(0 0 0 / 0.35),
			0 0 12px rgb(255 255 255 / 0.06);
	}

	@keyframes progress-shimmer {
		0% {
			background-position: -40% 0;
		}
		100% {
			background-position: 140% 0;
		}
	}

	@keyframes progress-comet-breathe {
		from {
			opacity: 0.78;
			transform: translate(-50%, -50%) scale(0.9);
		}
		to {
			opacity: 1;
			transform: translate(-50%, -50%) scale(1.08);
		}
	}
	.stage-progress-fill.progress-needs {
		background: var(--color-st-needs);
	}
	.stage-progress-fill.progress-done {
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--color-st-done) 88%, #000),
			var(--color-st-done)
		);
	}
	.stage-progress-fill.progress-fail {
		background: var(--color-st-fail);
	}

	.surface-drill-layer {
		border-top: 1px solid var(--ws-hairline);
		background: linear-gradient(180deg, rgb(0 0 0 / 0.22) 0%, rgb(0 0 0 / 0.38) 100%);
		box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.04);
	}

	.drill-rail-label {
		@apply px-4 pt-2.5 pb-1;
	}

	.drill-accordion-btn {
		@apply flex min-h-[44px] w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors;
		border-top: 1px solid rgb(255 255 255 / 0.05);
		color: rgb(255 255 255 / 0.9);
	}
	.drill-accordion-btn:hover {
		background: rgb(255 255 255 / 0.03);
	}
	.drill-accordion-btn[aria-expanded='true'] {
		background: color-mix(
			in srgb,
			var(--worker-color, var(--color-st-run)) 7%,
			rgb(255 255 255 / 0.02)
		);
		box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.05);
	}

	.drill-accordion-title {
		@apply text-[13px] font-medium tracking-[-0.01em] text-foreground/95;
	}

	.drill-accordion-meta {
		@apply rounded-[var(--r-pill)] border px-2 py-0.5;
		border-color: rgb(255 255 255 / 0.07);
		background: rgb(255 255 255 / 0.03);
	}

	.pipeline-hint {
		@apply mb-2 leading-snug;
	}

	.drill-accordion-body {
		@apply px-4 pt-2 pb-4;
		background: rgb(0 0 0 / 0.28);
		border-top: 1px solid rgb(255 255 255 / 0.05);
		box-shadow: inset 0 8px 24px rgb(0 0 0 / 0.28);
	}

	.expanded-header {
		@apply flex items-start justify-between gap-3;
	}

	.close-expanded-btn {
		@apply text-muted-foreground transition-colors hover:text-white;
	}

	.expanded-details-layout {
		@apply grid grid-cols-1 gap-4 md:grid-cols-2;
	}

	.expanded-viewport.work-graph-slot {
		/* Specific styles for expanded graph slot if needed */
	}

	.details-section {
		@apply space-y-1;
	}
	.details-section h4 {
		@apply text-sm font-semibold text-white;
	}
	.details-section p {
		@apply text-xs;
	}

	.proof-card {
		@apply rounded-[var(--r-xs)] bg-surface/50 p-3;
		grid-column: span 1; /* Default to one column */
	}
	.expanded-details-layout > .proof-card {
		@apply md:col-span-2; /* Make proof card span two columns on md screens */
	}
</style>
