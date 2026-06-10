<script lang="ts">
	// WORK SURFACE FLOW SIMULATOR
	//
	// Scripts a real "make a webpage with a hello world button" task end-to-end
	// through the Surface store. Drives the same Sully card the chat will use,
	// with realistic timing (~35s compressed). The operator watches the surface
	// breathe through a real task lifecycle and judges if it reads cohesive
	// BEFORE we wire the indicator into the Composer.
	//
	// Doctrine evidence the operator can verify by eye during the loop:
	//   t=0     pill ABSENT (idle store)
	//   t=2s    pill appears + working pulse rate
	//   t=5-12  CC active (cyan node + waveform), hero ring 20% → 40%
	//   t=12-22 AGY active (purple), ring 40% → 60%
	//   t=22-27 CDX active (orange), ring 60% → 80%
	//   t=27-32 Waiting state → ring amber, Approve button appears
	//   t=32-35 Approved → Working briefly → Complete (green, pulse stops)
	//   t=35+   recent-complete green dot on indicator (6s)
	//   t=42+   surface moves to Done group; pill returns to absence
	//
	// Every transition is emitted to the trajectory log on the right — that's
	// what the local-Sully QLoRA corpus would see during training.

	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import {
		WorkSurfaceComposerChrome,
		createWorkSurfaceView,
		spawnSurface,
		attachToSurface,
		setStatus,
		removeSurface,
		type WorkSurfaceDockMode
	} from '$lib/work-surface';
	import type {
		WorkSurfaceTask,
		TaskWorker,
		StageStep,
		RoutingGraph,
		PipelineStage,
		TaskState
	} from '$lib/types/workSurface';

	// ─── Trajectory log (the QLoRA corpus view) ────────────────────────────

	type TrajectoryEvent = {
		tMs: number;
		label: string;
		emit:
			| 'surface_spawn'
			| 'state_change'
			| 'stage_change'
			| 'worker_change'
			| 'edge_active'
			| 'surface_done';
		data: Record<string, unknown>;
	};

	let trajectory = $state<TrajectoryEvent[]>([]);
	let scriptStartMs = $state(0);
	let runningScript = $state(false);
	let surfaceId = $state<string | null>(null);

	// Start in 'badge' so the dock is dormant until the script spawns the
	// first surface; the script flips to 'sheet' at t=0 in the first step.
	let dockMode = $state<WorkSurfaceDockMode>('badge');
	let dockOpenSurfaceId = $state<string | null>(null);
	let dockSheetReturnMode = $state<WorkSurfaceDockMode>('badge');

	const elapsedMs = $state({ value: 0 });

	function logEvent(ev: TrajectoryEvent) {
		trajectory = [...trajectory, ev];
	}

	// ─── Worker templates (matches kernel worker roster) ──────────────────

	const CC: TaskWorker = {
		identity: 'claude-code',
		shortCode: 'CC',
		display: 'Claude Code',
		role: 'Research',
		status: 'queued',
		step: 'queued'
	};
	const AGY: TaskWorker = {
		identity: 'antigravity',
		shortCode: 'AGY',
		display: 'Antigravity (Gemini 3.1)',
		role: 'Build',
		status: 'queued',
		step: 'queued'
	};
	const CDX: TaskWorker = {
		identity: 'codex',
		shortCode: 'CDX',
		display: 'Codex',
		role: 'Review',
		status: 'queued',
		step: 'queued'
	};

	function makeStageProgress(current: PipelineStage, state: TaskState): StageStep[] {
		const order: PipelineStage[] = ['Read', 'Research', 'Build', 'Check', 'Approve', 'Reply'];
		if (state === 'Complete') {
			return order.map((s) => ({ stage: s, status: 'done' as const }));
		}
		const ci = order.indexOf(current);
		return order.map((s, i) => ({
			stage: s,
			status: i < ci ? ('done' as const) : i === ci ? ('active' as const) : ('pending' as const)
		}));
	}

	function makeRouting(activeWorkerId: string | null): RoutingGraph {
		return {
			nodes: [
				{ id: 'core', kind: 'core', status: 'active' },
				{
					id: 'claude-code',
					kind: 'worker',
					role: 'Research',
					status: activeWorkerId === 'claude-code' ? 'active' : 'idle'
				},
				{
					id: 'antigravity',
					kind: 'worker',
					role: 'Build',
					status: activeWorkerId === 'antigravity' ? 'active' : 'idle'
				},
				{
					id: 'codex',
					kind: 'worker',
					role: 'Review',
					status: activeWorkerId === 'codex' ? 'active' : 'idle'
				}
			],
			edges: [
				{
					from: 'claude-code',
					to: 'core',
					active: activeWorkerId === 'claude-code',
					dispatch_active: activeWorkerId === 'claude-code'
				},
				{
					from: 'antigravity',
					to: 'core',
					active: activeWorkerId === 'antigravity',
					dispatch_active: activeWorkerId === 'antigravity'
				},
				{
					from: 'codex',
					to: 'core',
					active: activeWorkerId === 'codex',
					dispatch_active: activeWorkerId === 'codex'
				}
			]
		};
	}

	function makeWorkers(activeId: string | null, doneIds: string[]): TaskWorker[] {
		return [CC, AGY, CDX].map((w) => ({
			...w,
			status: doneIds.includes(w.identity)
				? ('done' as const)
				: activeId === w.identity
					? ('active' as const)
					: ('idle' as const),
			step: doneIds.includes(w.identity)
				? 'done'
				: activeId === w.identity
					? w.role === 'Research'
						? 'Reading existing button components'
						: w.role === 'Build'
							? 'Writing hello-world.html'
							: 'Validating output renders'
					: 'queued'
		}));
	}

	function makeTask(opts: {
		state: TaskState;
		stage: PipelineStage;
		activeWorkerId: string | null;
		doneWorkerIds: string[];
		activeStepOverride?: string;
	}): WorkSurfaceTask {
		const workers = makeWorkers(opts.activeWorkerId, opts.doneWorkerIds).map((w) =>
			opts.activeStepOverride && opts.activeWorkerId === w.identity
				? { ...w, step: opts.activeStepOverride }
				: w
		);
		return {
			traceId: 'sim-helloworld-2026-06-06',
			threadId: null,
			title: 'Make a webpage with a hello world button',
			state: opts.state,
			stage: opts.stage,
			stageProgress: makeStageProgress(opts.stage, opts.state),
			workers,
			routing: makeRouting(opts.activeWorkerId),
			block: opts.state === 'Waiting' ? { kind: 'approval', targetPath: 'hello-world.html' } : null,
			proof: opts.state === 'Complete' ? { verdict: 'go', checks: [] } : null,
			result: null,
			isDestructive: false,
			startedAt: new Date(scriptStartMs).toISOString(),
			endedAt: opts.state === 'Complete' ? new Date(scriptStartMs + 35000).toISOString() : null,
			ticketId: null
		};
	}

	// ─── The script ────────────────────────────────────────────────────────

	type Step = {
		at: number;
		label: string;
		apply: () => void;
		emit?: TrajectoryEvent['emit'];
		data?: Record<string, unknown>;
	};

	const SCRIPT: Step[] = [
		{
			at: 0,
			label: 'Operator: "make a webpage with a hello world button"',
			apply: () => {
				// Sully decides → spawn surface in Reading state, no worker yet
				const t = makeTask({
					state: 'Reading',
					stage: 'Read',
					activeWorkerId: null,
					doneWorkerIds: []
				});
				surfaceId = spawnSurface('sim-msg', t);
				setStatus(surfaceId, 'running');
				// Stay collapsed — operator opens the sheet only when they want to look.
				dockOpenSurfaceId = null;
				dockMode = 'badge';
			},
			emit: 'surface_spawn',
			data: { surfaceId: 'spawned', state: 'Reading' }
		},
		{
			at: 2000,
			label: 'CC dispatched · Research stage',
			apply: () => {
				if (!surfaceId) return;
				attachToSurface(surfaceId, {
					task: makeTask({
						state: 'Working',
						stage: 'Research',
						activeWorkerId: 'claude-code',
						doneWorkerIds: []
					})
				});
			},
			emit: 'state_change',
			data: { state: 'Working', stage: 'Research', activeWorker: 'CC' }
		},
		{
			at: 6500,
			label: 'CC validating research · faster breath',
			apply: () => {
				if (!surfaceId) return;
				attachToSurface(surfaceId, {
					task: makeTask({
						state: 'Working',
						stage: 'Research',
						activeWorkerId: 'claude-code',
						doneWorkerIds: [],
						activeStepOverride: 'Validating research coverage'
					})
				});
			},
			emit: 'state_change',
			data: { stage: 'Research', activeWorker: 'CC', step: 'finishing' }
		},
		{
			at: 8000,
			label: 'CC done · AGY dispatched · Build stage',
			apply: () => {
				if (!surfaceId) return;
				attachToSurface(surfaceId, {
					task: makeTask({
						state: 'Working',
						stage: 'Build',
						activeWorkerId: 'antigravity',
						doneWorkerIds: ['claude-code']
					})
				});
			},
			emit: 'worker_change',
			data: { stage: 'Build', activeWorker: 'AGY', doneWorkers: ['CC'] }
		},
		{
			at: 14000,
			label: 'AGY running final build checks · faster breath',
			apply: () => {
				if (!surfaceId) return;
				attachToSurface(surfaceId, {
					task: makeTask({
						state: 'Working',
						stage: 'Build',
						activeWorkerId: 'antigravity',
						doneWorkerIds: ['claude-code'],
						activeStepOverride: 'Running final build checks'
					})
				});
			},
			emit: 'state_change',
			data: { stage: 'Build', activeWorker: 'AGY', step: 'finishing' }
		},
		{
			at: 16000,
			label: 'AGY done · CDX dispatched · Check stage',
			apply: () => {
				if (!surfaceId) return;
				attachToSurface(surfaceId, {
					task: makeTask({
						state: 'Working',
						stage: 'Check',
						activeWorkerId: 'codex',
						doneWorkerIds: ['claude-code', 'antigravity']
					})
				});
			},
			emit: 'worker_change',
			data: { stage: 'Check', activeWorker: 'CDX', doneWorkers: ['CC', 'AGY'] }
		},
		{
			at: 22000,
			label: 'CDX done · awaiting operator Approve',
			apply: () => {
				if (!surfaceId) return;
				attachToSurface(surfaceId, {
					status: 'needs-you',
					needs: { kind: 'approval', prompt: 'Push hello-world page?' },
					task: makeTask({
						state: 'Waiting',
						stage: 'Approve',
						activeWorkerId: null,
						doneWorkerIds: ['claude-code', 'antigravity', 'codex']
					})
				});
				// Needs-you earns attention — expand inline in chat (not full sheet).
				dockOpenSurfaceId = surfaceId;
				dockMode = 'inline';
			},
			emit: 'state_change',
			data: { state: 'Waiting', requires: 'operator_approve' }
		},
		{
			at: 28000,
			label: 'Operator approves (simulated)',
			apply: () => {
				if (!surfaceId) return;
				attachToSurface(surfaceId, {
					status: 'running',
					needs: undefined,
					task: makeTask({
						state: 'Delivering',
						stage: 'Reply',
						activeWorkerId: null,
						doneWorkerIds: ['claude-code', 'antigravity', 'codex']
					})
				});
			},
			emit: 'state_change',
			data: { state: 'Delivering', action: 'operator_approved' }
		},
		{
			at: 32000,
			label: 'Complete · hello-world.html shipped',
			apply: () => {
				if (!surfaceId) return;
				attachToSurface(surfaceId, {
					status: 'done',
					task: makeTask({
						state: 'Complete',
						stage: 'Reply',
						activeWorkerId: null,
						doneWorkerIds: ['claude-code', 'antigravity', 'codex']
					})
				});
			},
			emit: 'surface_done',
			data: { state: 'Complete', proof: 'go' }
		}
	];

	// ─── Driver ────────────────────────────────────────────────────────────

	let driverInterval: ReturnType<typeof setInterval> | null = null;
	let nextStepIdx = $state(0);

	function reset() {
		if (driverInterval) clearInterval(driverInterval);
		driverInterval = null;
		runningScript = false;
		if (surfaceId) removeSurface(surfaceId);
		surfaceId = null;
		trajectory = [];
		elapsedMs.value = 0;
		nextStepIdx = 0;
		scriptStartMs = 0;
		dockMode = 'badge';
		dockOpenSurfaceId = null;
	}

	function runDueSteps(elapsed: number) {
		while (nextStepIdx < SCRIPT.length && SCRIPT[nextStepIdx].at <= elapsed) {
			const step = SCRIPT[nextStepIdx];
			step.apply();
			if (step.emit) {
				logEvent({
					tMs: step.at,
					label: step.label,
					emit: step.emit,
					data: step.data ?? {}
				});
			}
			nextStepIdx++;
		}
	}

	function start() {
		reset();
		runningScript = true;
		scriptStartMs = Date.now();
		const startedAt = scriptStartMs;

		// Spawn the card immediately on tap — don't wait for the first interval tick.
		elapsedMs.value = 0;
		runDueSteps(0);

		driverInterval = setInterval(() => {
			elapsedMs.value = Date.now() - startedAt;
			runDueSteps(elapsedMs.value);
			if (nextStepIdx >= SCRIPT.length && elapsedMs.value > 40000) {
				// End-state hold: surface fully Complete, pill in recent-complete fade
				if (driverInterval) clearInterval(driverInterval);
				driverInterval = null;
				runningScript = false;
			}
		}, 150);
	}

	onMount(() => {
		const autostart =
			$page.url.searchParams.get('autostart') === '1' || $page.url.searchParams.get('run') === '1';
		if (autostart) start();
	});

	function formatMs(ms: number) {
		const s = (ms / 1000).toFixed(1);
		return `${s}s`;
	}

	const wsView = createWorkSurfaceView(() => null);
	const runningCount = $derived(wsView.runningList.length);
	const needsYouCount = $derived(wsView.needsYouList.length);
	const doneCount = $derived(wsView.doneList.length);
</script>

<div class="flex w-full flex-col bg-background text-foreground">
	<div class="border-b border-border px-4 py-3">
		<h1 class="text-base font-semibold sm:text-lg">Work Surface Flow Simulator</h1>
		<p class="mt-1 hidden text-sm text-muted-foreground sm:block">
			"Make a webpage with a hello world button" — full lifecycle in ~35s. Watch the surface breathe
			through a real task. Every transition logs to the trajectory panel (right) — that's what the
			local-Sully QLoRA corpus sees during training.
		</p>
		<p class="mt-1 text-xs text-muted-foreground sm:hidden">
			Tap Start → pill above composer. Tap pill → card expands in chat. More detail → full view.
		</p>
		<div class="mt-3 flex flex-wrap items-center gap-2">
			<button
				type="button"
				class="rounded-[var(--r-pill)] border border-brand bg-brand/10 px-4 py-2 text-xs font-semibold text-foreground hover:bg-brand/20 disabled:opacity-40"
				onclick={start}
				disabled={runningScript}
			>
				▶ Start simulation
			</button>
			<button
				type="button"
				class="rounded-[var(--r-pill)] border border-border bg-surface px-4 py-2 text-xs text-foreground hover:bg-card"
				onclick={reset}
			>
				⟲ Reset
			</button>
			<span class="ml-auto font-mono text-xs text-muted-foreground">
				t = {formatMs(elapsedMs.value)} · running:{runningCount} · needs-you:{needsYouCount} · done:{doneCount}
			</span>
		</div>
	</div>

	<div class="flex flex-col gap-4 px-3 py-3 sm:px-4 sm:py-4 lg:flex-row">
		<!-- Chat chrome mock — same collapse ladder as /companion/chat -->
		<div class="flex-1">
			<p class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
				Chat (simulated)
			</p>
			<div
				class="iphone-glance-frame mx-auto flex min-h-[420px] w-full max-w-[393px] flex-col rounded-[var(--r-lg)] border border-border bg-card/30"
			>
				<p
					class="mb-1.5 pt-3 text-center font-mono text-[9px] tracking-widest text-muted-foreground uppercase"
				>
					iPhone glance width (393px)
				</p>
				<div class="flex flex-1 flex-col justify-end px-3 pb-3">
					<div
						class="mb-3 rounded-[var(--r-lg)] border border-border/60 bg-surface/40 px-3 py-2 text-xs text-muted-foreground"
					>
						{#if runningCount > 0 || needsYouCount > 0}
							Chat continues here while work runs in the background.
						{:else}
							Press <b>Start simulation</b>. When work starts, a pill appears above the composer.
						{/if}
					</div>
					<WorkSurfaceComposerChrome
						embedded
						elevated={false}
						bind:mode={dockMode}
						bind:openSurfaceId={dockOpenSurfaceId}
						bind:sheetReturnMode={dockSheetReturnMode}
					/>
					<div
						class="rounded-[var(--r-pill)] border border-border bg-surface/80 px-4 py-3 text-sm text-muted-foreground"
					>
						Message Sully…
					</div>
				</div>
			</div>
		</div>

		<!-- Trajectory log (desktop / wide only — hidden on phone so the card stays in view) -->
		<div class="hidden min-h-[320px] w-full max-w-md flex-none lg:block">
			<div class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
				Trajectory log (QLoRA corpus view)
			</div>
			<div class="rounded-[var(--r-sm)] border border-border bg-card p-3">
				{#if trajectory.length === 0}
					<p class="text-xs text-muted-foreground">
						Press Start. Each transition will land here with a timestamp, an emit type, and a
						labeled data payload — the exact shape a routing/training example takes.
					</p>
				{:else}
					<ol class="space-y-2 font-mono text-[11px] text-foreground">
						{#each trajectory as ev (ev.tMs)}
							<li class="border-l-2 border-brand/40 pl-3">
								<div class="flex items-baseline gap-2">
									<span class="text-muted-foreground">{formatMs(ev.tMs)}</span>
									<span class="rounded bg-surface/60 px-1.5 py-0.5 text-[10px] uppercase">
										{ev.emit}
									</span>
								</div>
								<div class="mt-0.5 text-foreground">{ev.label}</div>
								<div class="mt-0.5 text-[10px] text-muted-foreground">
									{JSON.stringify(ev.data)}
								</div>
							</li>
						{/each}
					</ol>
				{/if}
			</div>
		</div>
	</div>
</div>
