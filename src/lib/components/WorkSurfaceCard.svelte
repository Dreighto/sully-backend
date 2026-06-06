<script lang="ts">
	import type { WorkSurfaceTask, PipelineStage, TaskState } from '$lib/types/workSurface';
	import StageTimeline from '$lib/components/StageTimeline.svelte';
	import WorkGraph from '$lib/components/WorkGraph.svelte';
	import PhaseChecklist from '$lib/components/PhaseChecklist.svelte';
	import WorkerRegistry from '$lib/components/WorkerRegistry.svelte';
	import ProofCard from '$lib/components/ProofCard.svelte';
	import { Send, Check, X, Repeat } from 'lucide-svelte';

	let {
		task,
		footprint = 'compact',
		suppressInlinePanels = false, // New prop to control inline panel rendering
		onapprove,
		onstop,
		onretry
	}: {
		task: WorkSurfaceTask;
		footprint?: 'collapsed' | 'compact' | 'expanded';
		suppressInlinePanels?: boolean; // New prop type definition
		onapprove?: () => void;
		onstop?: () => void;
		onretry?: () => void;
	} = $props();

	let confirmApprove = $state(false);
	let approveTimeout: ReturnType<typeof setTimeout> | null = null;

	const firstWorkerStep = $derived(
		task.workers[0]?.step ||
			(task.state === 'Waiting' ? 'Awaiting operator action' : 'Awaiting instructions')
	);

	const displayApproveButton = $derived(
		task.state === 'Waiting' && task.block?.kind === 'approval'
	);
	const displayStopButton = $derived(
		task.state !== 'Complete' && task.state !== 'Stopped' && task.state !== 'Failed'
	);
	const displayRetryButton = $derived(task.state === 'Failed' || task.state === 'Stopped');

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
</script>

<div class="work-surface-card state-{footprint} status-{task.state.toLowerCase()}">
	<!-- 1. COLLAPSED VIEW -->
	<div class="sully-collapsed-view" class:active={footprint === 'collapsed'}>
		<div class="collapsed-content">
			<span class="pulse-indicator status-{task.state.toLowerCase()}"></span>
			<span class="collapsed-title">Sully: {task.state}</span>
			{#if task.workers.length > 0}
				<span class="collapsed-meta">{task.workers[0].shortCode}</span>
			{/if}
		</div>
	</div>

	<!-- 2. COMPACT CARD VIEW -->
	<div class="sully-compact-card" class:active={footprint === 'compact'}>
		<div class="card-header">
			<div class="header-left">
				<span class="system-badge-icon"><Send size="18" /></span>
				<div class="header-text">
					<span class="card-label">Sully Work Surface</span>
					<h1 class="task-title">{task.title}</h1>
				</div>
			</div>
			<span class="status-pill status-{task.state.toLowerCase()}">{task.state}</span>
		</div>

		<StageTimeline {task} />

		<!-- Central SVG Graph (Dynamic Worker-Task Layout) -->
		<div class="work-graph-slot">
			<WorkGraph {task} />
		</div>

		<!-- Active Ownership Banner -->
		{#if task.state !== 'Complete' && task.state !== 'Stopped' && task.state !== 'Failed'}
			<div class="active-ownership-banner">
				<span class="ownership-pulse"></span>
				<span class="ownership-text">Now: {firstWorkerStep}</span>
			</div>
		{/if}

		<!-- Inline Actions -->
		<div class="actions-container">
			{#if displayApproveButton}
				<button class="action-btn action-approve" onclick={handleApprove}>
					{#if confirmApprove && task.isDestructive}
						Confirm?
					{:else}
						<Check size="16" /> Approve
					{/if}
				</button>
			{/if}
			{#if displayStopButton}
				<button class="action-btn action-stop" onclick={handleStop}>
					<X size="16" /> Stop
				</button>
			{/if}
			{#if displayRetryButton}
				<button class="action-btn action-retry" onclick={handleRetry}>
					<Repeat size="16" /> Retry
				</button>
			{/if}
		</div>
	</div>

	<!-- 3. EXPANDED DETAIL VIEW -->
	<div class="sully-expanded-wrapper" class:active={footprint === 'expanded'}>
		<div class="sully-expanded-card">
			<div class="expanded-header">
				<div class="header-left">
					<span class="system-badge-icon"><Send size="18" /></span>
					<div class="header-text">
						<span class="card-label">Detailed Telemetry</span>
						<h2 class="task-title">{task.title}</h2>
					</div>
				</div>
				<!-- Close button handled by parent in preview, or not needed for always-expanded -->
			</div>

			<StageTimeline {task} />

			{#if !suppressInlinePanels}
				<div class="expanded-details-layout">
					<div class="work-graph-slot expanded-viewport">
						<WorkGraph {task} />
					</div>

					{#if task.state !== 'Complete' && task.state !== 'Stopped' && task.state !== 'Failed'}
						<div class="active-ownership-banner">
							<span class="ownership-pulse"></span>
							<span class="ownership-text">Now: {firstWorkerStep}</span>
						</div>
					{/if}

					<div class="details-section">
						<h4>Routing Phases</h4>
						<PhaseChecklist {task} />
					</div>

					<div class="details-section">
						<h4>Worker Registry</h4>
						<WorkerRegistry {task} />
					</div>

					<ProofCard {task} />
				</div>
			{:else}
				<!-- If inline panels are suppressed, just show the graph and ownership banner directly -->
				<div class="work-graph-slot expanded-viewport">
					<WorkGraph {task} />
				</div>

				{#if task.state !== 'Complete' && task.state !== 'Stopped' && task.state !== 'Failed'}
					<div class="active-ownership-banner">
						<span class="ownership-pulse"></span>
						<span class="ownership-text">Now: {firstWorkerStep}</span>
					</div>
				{/if}
			{/if}

			<div class="actions-container">
				{#if displayApproveButton}
					<button class="action-btn action-approve" onclick={handleApprove}>
						{#if confirmApprove && task.isDestructive}
							Confirm?
						{:else}
							<Check size="16" /> Approve
						{/if}
					</button>
				{/if}
				{#if displayStopButton}
					<button class="action-btn action-stop" onclick={handleStop}>
						<X size="16" /> Stop
					</button>
				{/if}
				{#if displayRetryButton}
					<button class="action-btn action-retry" onclick={handleRetry}>
						<Repeat size="16" /> Retry
					</button>
				{/if}
			</div>
		</div>
	</div>
</div>

<style lang="postcss">
	@reference "../../app.css";
	.work-surface-card {
		@apply relative w-full overflow-hidden rounded-lg border border-border shadow-xl;
		min-height: 40px; /* Base for collapsed */
		transition:
			min-height 0.3s ease,
			background-color 0.3s ease;
	}

	/* Settle Colors (from real_assets_v4_final.css) */
	.work-surface-card.status-reading,
	.work-surface-card.status-planning,
	.work-surface-card.status-working,
	.work-surface-card.status-reviewing,
	.work-surface-card.status-delivering {
		background-color: var(--color-surface); /* Original was --color-grey-800, using surface */
		border-color: var(--color-border);
	}

	.work-surface-card.status-waiting,
	.work-surface-card.status-stopped {
		background-color: var(--color-status-amber-10); /* Light amber background */
		border-color: var(--color-status-amber);
	}

	.work-surface-card.status-failed {
		background-color: var(--color-status-red-10); /* Light red background */
		border-color: var(--color-status-red);
	}

	.work-surface-card.status-complete {
		background-color: var(--color-status-green-10); /* Light green background */
		border-color: var(--color-status-green);
	}

	/* Inner views - controlled by parent .state-{footprint} */
	.sully-collapsed-view,
	.sully-compact-card,
	.sully-expanded-wrapper {
		@apply hidden;
	}
	.state-collapsed .sully-collapsed-view,
	.state-compact .sully-compact-card,
	.state-expanded .sully-expanded-wrapper {
		@apply block;
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
		@apply h-2 w-2 rounded-full;
		animation: pulse 1.5s infinite ease-in-out;
	}

	.pulse-indicator.status-reading,
	.pulse-indicator.status-planning,
	.pulse-indicator.status-working,
	.pulse-indicator.status-reviewing,
	.pulse-indicator.status-delivering {
		background-color: var(--color-brand);
	}
	.pulse-indicator.status-waiting,
	.pulse-indicator.status-stopped {
		background-color: var(--color-status-amber);
	}
	.pulse-indicator.status-failed {
		background-color: var(--color-status-red);
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
		@apply flex items-start justify-between gap-3;
	}

	.header-left {
		@apply flex items-center gap-2;
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
		@apply text-sm leading-tight font-semibold text-white;
	}

	.status-pill {
		@apply flex h-[18px] min-w-[55px] flex-shrink-0 items-center justify-center rounded-[9px] px-2 text-[9px] font-bold whitespace-nowrap uppercase transition-colors;
	}

	.status-pill.status-reading,
	.status-pill.status-planning,
	.status-pill.status-working,
	.status-pill.status-reviewing,
	.status-pill.status-delivering {
		background-color: var(--color-brand);
		color: var(--color-on-brand);
	}
	.status-pill.status-waiting,
	.status-pill.status-stopped {
		background-color: var(--color-status-amber);
		color: var(--color-on-brand);
	}
	.status-pill.status-failed {
		background-color: var(--color-status-red);
		color: var(--color-on-brand);
	}
	.status-pill.status-complete {
		background-color: var(--color-status-green);
		color: var(--color-on-brand);
	}

	.work-graph-slot {
		@apply w-full bg-transparent;
		min-height: 130px;
	}

	.active-ownership-banner {
		@apply flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs font-medium text-muted-foreground;
	}
	.ownership-pulse {
		@apply h-2 w-2 rounded-full bg-brand;
		animation: pulse 1.5s infinite ease-in-out;
	}

	.actions-container {
		@apply flex gap-2 pt-2;
	}

	.action-btn {
		@apply flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors;
		color: white;
		background-color: var(--color-brand); /* Default for all actions */
	}
	.action-btn:hover {
		@apply opacity-90;
	}
	.action-btn.action-stop {
		background-color: var(--color-status-red);
	}
	.action-btn.action-retry {
		background-color: var(--color-status-amber);
	}

	/* 3. EXPANDED DETAIL VIEW */
	.sully-expanded-wrapper {
		@apply p-3;
	}

	.sully-expanded-card {
		@apply space-y-3;
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
		@apply rounded-md border border-border bg-surface p-3;
		grid-column: span 1; /* Default to one column */
	}
	.expanded-details-layout > .proof-card {
		@apply md:col-span-2; /* Make proof card span two columns on md screens */
	}
</style>
