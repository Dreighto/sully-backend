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

	import WorkSurfaceCard from '$lib/components/WorkSurfaceCard.svelte';
	import WorkSurfaceIndicator from '$lib/components/WorkSurfaceIndicator.svelte';
	import StageTimeline from '$lib/components/StageTimeline.svelte';
	import WorkGraph from '$lib/components/WorkGraph.svelte';
	import PhaseChecklist from '$lib/components/PhaseChecklist.svelte';
	import WorkerRegistry from '$lib/components/WorkerRegistry.svelte';
	import ProofCard from '$lib/components/ProofCard.svelte';
	import { slide } from 'svelte/transition';
	import {
		spawnSurface,
		attachToSurface,
		setStatus,
		removeSurface,
		running,
		needsYou,
		done as doneList
	} from '$lib/data/surfaces.svelte';
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
	let dockMode = $state<'badge' | 'rail' | 'sheet'>('badge');
	let dockOpenSurfaceId = $state<string | null>(null);

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

	function makeStageProgress(current: PipelineStage): StageStep[] {
		const order: PipelineStage[] = ['Read', 'Research', 'Build', 'Check', 'Approve', 'Reply'];
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
	}): WorkSurfaceTask {
		return {
			traceId: 'sim-helloworld-2026-06-06',
			threadId: null,
			title: 'Make a webpage with a hello world button',
			state: opts.state,
			stage: opts.stage,
			stageProgress: makeStageProgress(opts.stage),
			workers: makeWorkers(opts.activeWorkerId, opts.doneWorkerIds),
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
				dockOpenSurfaceId = surfaceId;
				dockMode = 'sheet';
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

	function start() {
		reset();
		runningScript = true;
		scriptStartMs = Date.now();
		const startedAt = scriptStartMs;

		driverInterval = setInterval(() => {
			elapsedMs.value = Date.now() - startedAt;
			while (nextStepIdx < SCRIPT.length && SCRIPT[nextStepIdx].at <= elapsedMs.value) {
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
			if (nextStepIdx >= SCRIPT.length && elapsedMs.value > 40000) {
				// End-state hold: surface fully Complete, pill in recent-complete fade
				if (driverInterval) clearInterval(driverInterval);
				driverInterval = null;
				runningScript = false;
			}
		}, 150);
	}

	function formatMs(ms: number) {
		const s = (ms / 1000).toFixed(1);
		return `${s}s`;
	}

	const runningCount = $derived(running().length);
	const needsYouCount = $derived(needsYou().length);
	const doneCount = $derived(doneList().length);

	// The current surface to render in the side-by-side view — whichever state
	// it's in. running > needs-you > done so we always show the most-current.
	const currentSurface = $derived.by(() => {
		return running()[0] ?? needsYou()[0] ?? doneList()[0] ?? null;
	});

	// Accordion state — Activity (the graph view) is open by default so the
	// operator sees the per-role node glow as the simulation runs. The other
	// accordions stay collapsed; tap to drill in.
	let openSections = $state<Set<string>>(new Set(['activity']));
	function toggleSection(key: string) {
		if (openSections.has(key)) openSections.delete(key);
		else openSections.add(key);
		openSections = new Set(openSections);
	}
</script>

<div class="flex min-h-screen w-full flex-col overflow-y-auto bg-background text-foreground">
	<div class="border-b border-border px-4 py-4">
		<h1 class="text-lg font-semibold">Work Surface Flow Simulator</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			"Make a webpage with a hello world button" — full lifecycle in ~35s. Watch the surface breathe
			through a real task. Every transition logs to the trajectory panel (right) — that's what the
			local-Sully QLoRA corpus sees during training.
		</p>
		<div class="mt-3 flex flex-wrap items-center gap-2">
			<button
				type="button"
				class="rounded-full border border-brand bg-brand/10 px-4 py-2 text-xs font-semibold text-foreground hover:bg-brand/20 disabled:opacity-40"
				onclick={start}
				disabled={runningScript}
			>
				▶ Start simulation
			</button>
			<button
				type="button"
				class="rounded-full border border-border bg-surface px-4 py-2 text-xs text-foreground hover:bg-card"
				onclick={reset}
			>
				⟲ Reset
			</button>
			<span class="ml-auto font-mono text-xs text-muted-foreground">
				t = {formatMs(elapsedMs.value)} · running:{runningCount} · needs-you:{needsYouCount} · done:{doneCount}
			</span>
		</div>
	</div>

	<div class="flex flex-col gap-4 px-4 py-4 lg:flex-row">
		<!-- The Sully surface (what the operator would see in the chat).
		     Renders the card DIRECTLY (not through the dock's fixed sheet) so the
		     trajectory log stays visible side-by-side. -->
		<div class="min-h-[640px] flex-1">
			<div class="mb-2 flex items-center gap-2">
				<div class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
					Sully surface (what the operator sees)
				</div>
				<div class="ml-auto">
					<WorkSurfaceIndicator bind:mode={dockMode} bind:openSurfaceId={dockOpenSurfaceId} />
				</div>
			</div>
			{#if currentSurface}
				<div class="rounded-xl border border-border bg-card p-4">
					<WorkSurfaceCard task={currentSurface.task} footprint="expanded" />
				</div>

				<!-- Detail accordions — same shape the chat sheet will use. Activity
				     starts OPEN by default so the graph (with per-role node glow) is
				     visible as the simulation runs. -->
				<div class="mt-4 space-y-2">
					<button
						type="button"
						class="flex min-h-[44px] w-full items-center justify-between rounded-lg bg-surface/50 px-4 py-3 text-left text-sm hover:bg-surface"
						aria-expanded={openSections.has('timeline')}
						onclick={() => toggleSection('timeline')}
					>
						<span class="font-semibold text-foreground">
							{openSections.has('timeline') ? '▾' : '▸'} Timeline
						</span>
						<span class="text-xs text-muted-foreground">{currentSurface.task.stage}</span>
					</button>
					{#if openSections.has('timeline')}
						<div transition:slide={{ duration: 200 }} class="px-1 pb-2">
							<StageTimeline task={currentSurface.task} />
						</div>
					{/if}

					<button
						type="button"
						class="flex min-h-[44px] w-full items-center justify-between rounded-lg bg-surface/50 px-4 py-3 text-left text-sm hover:bg-surface"
						aria-expanded={openSections.has('activity')}
						onclick={() => toggleSection('activity')}
					>
						<span class="font-semibold text-foreground">
							{openSections.has('activity') ? '▾' : '▸'} Activity
						</span>
						<span class="text-xs text-muted-foreground">Graph · per-role glow</span>
					</button>
					{#if openSections.has('activity')}
						<div transition:slide={{ duration: 200 }} class="px-1 pb-2">
							<WorkGraph task={currentSurface.task} />
						</div>
					{/if}

					<button
						type="button"
						class="flex min-h-[44px] w-full items-center justify-between rounded-lg bg-surface/50 px-4 py-3 text-left text-sm hover:bg-surface"
						aria-expanded={openSections.has('phases')}
						onclick={() => toggleSection('phases')}
					>
						<span class="font-semibold text-foreground">
							{openSections.has('phases') ? '▾' : '▸'} Routing Phases ({currentSurface.task
								.stageProgress?.length ?? 0})
						</span>
						<span class="text-xs text-muted-foreground">{currentSurface.task.stage}</span>
					</button>
					{#if openSections.has('phases')}
						<div transition:slide={{ duration: 200 }} class="px-1 pb-2">
							<PhaseChecklist task={currentSurface.task} />
						</div>
					{/if}

					<button
						type="button"
						class="flex min-h-[44px] w-full items-center justify-between rounded-lg bg-surface/50 px-4 py-3 text-left text-sm hover:bg-surface"
						aria-expanded={openSections.has('workers')}
						onclick={() => toggleSection('workers')}
					>
						<span class="font-semibold text-foreground">
							{openSections.has('workers') ? '▾' : '▸'} Worker Registry ({currentSurface.task
								.workers?.length ?? 0})
						</span>
						<span class="text-xs text-muted-foreground">
							{currentSurface.task.workers?.[0]?.shortCode ?? '—'}
							{(currentSurface.task.workers?.length ?? 0) > 1
								? `+${(currentSurface.task.workers?.length ?? 1) - 1}`
								: ''}
						</span>
					</button>
					{#if openSections.has('workers')}
						<div transition:slide={{ duration: 200 }} class="px-1 pb-2">
							<WorkerRegistry task={currentSurface.task} />
						</div>
					{/if}

					<button
						type="button"
						class="flex min-h-[44px] w-full items-center justify-between rounded-lg bg-surface/50 px-4 py-3 text-left text-sm hover:bg-surface"
						aria-expanded={openSections.has('proof')}
						onclick={() => toggleSection('proof')}
					>
						<span class="font-semibold text-foreground">
							{openSections.has('proof') ? '▾' : '▸'} Proof
						</span>
						<span class="text-xs text-muted-foreground">
							{currentSurface.task.proof?.verdict ?? 'pending'}
						</span>
					</button>
					{#if openSections.has('proof') && currentSurface.task.proof}
						<div transition:slide={{ duration: 200 }} class="px-1 pb-2">
							<ProofCard task={currentSurface.task} />
						</div>
					{/if}
				</div>
			{:else}
				<div class="rounded-xl border border-border bg-card/40 p-8 text-center">
					<p class="text-sm text-muted-foreground">
						Press <b>Start simulation</b>. The surface will spawn here as Sully decides to dispatch.
					</p>
				</div>
			{/if}
		</div>

		<!-- Trajectory log (what the QLoRA corpus sees) -->
		<div class="min-h-[640px] w-full max-w-md flex-none">
			<div class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
				Trajectory log (QLoRA corpus view)
			</div>
			<div class="rounded-lg border border-border bg-card p-3">
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
