<script lang="ts">
	import type { WorkSurfaceTask, GraphNode, GraphEdge, WorkerRole } from '$lib/types/workSurface';
	import {
		packetGlideDuration,
		workerBrandColor,
		workerBreathDelay,
		workerBreathFinishing
	} from '$lib/utils/workerVisual';
	import WorkerIconSprite from './WorkerIconSprite.svelte';

	let { task }: { task: WorkSurfaceTask } = $props();

	const WORK_GRAPH_VIEWBOX = '0 0 340 130';
	const TASK_CORE_POS = { x: 170, y: 65 };
	const CORE_FIELD_RADII = [17, 20, 23, 26, 29, 32];
	const NODE_ICON_SIZE = 22; // For worker icons inside circles
	const PACKET_SIZE = 12;
	const WORKER_EDGE_R = 18; // trim routes to node rim (node-circle r=17)
	const CORE_EDGE_R = 21; // trim routes to TASK rim (central-task-node r=20)

	// §3a. Layout (EASY — port the lookup table verbatim)
	function getWorkerPositions(count: number) {
		if (count === 1) return [{ x: 60, y: 65 }];
		if (count === 2)
			return [
				{ x: 60, y: 35 },
				{ x: 60, y: 95 }
			];
		if (count === 3)
			return [
				{ x: 60, y: 35 },
				{ x: 60, y: 95 },
				{ x: 280, y: 65 }
			];
		if (count === 4)
			return [
				{ x: 60, y: 35 },
				{ x: 60, y: 95 },
				{ x: 280, y: 35 },
				{ x: 280, y: 95 }
			];
		// > 4 workers: 3 on left, 2 on right (total 5 positions shown)
		// This matches the JS mock's behavior for 5+ workers
		return [
			{ x: 60, y: 25 },
			{ x: 60, y: 65 },
			{ x: 60, y: 105 },
			{ x: 280, y: 45 },
			{ x: 280, y: 85 }
		];
	}

	// Trim a center-to-center segment so the lane terminates on node rims (reads as connect,
	// not lines piercing circles).
	function trimEndpoints(
		sx: number,
		sy: number,
		ex: number,
		ey: number,
		startR: number,
		endR: number
	): { sx: number; sy: number; ex: number; ey: number } {
		const dx = ex - sx;
		const dy = ey - sy;
		const len = Math.hypot(dx, dy);
		if (len <= startR + endR) {
			return { sx, sy, ex, ey };
		}
		const ux = dx / len;
		const uy = dy / len;
		return {
			sx: sx + ux * startR,
			sy: sy + uy * startR,
			ex: ex - ux * endR,
			ey: ey - uy * endR
		};
	}

	// §3b. Edge paths (EASY — pure function)
	function pathD(sx: number, sy: number, ex: number, ey: number): string {
		const trimmed = trimEndpoints(sx, sy, ex, ey, WORKER_EDGE_R, CORE_EDGE_R);
		sx = trimmed.sx;
		sy = trimmed.sy;
		ex = trimmed.ex;
		ey = trimmed.ey;

		if (sy === ey) {
			return `M ${sx} ${sy} L ${ex} ${ey}`;
		}
		const midX = (sx + ex) / 2;
		const ctrlY = sy < TASK_CORE_POS.y ? sy - 10 : sy + 10;
		return `M ${sx} ${sy} Q ${midX} ${ctrlY} ${ex} ${ey}`;
	}

	const workerPositions = $derived(getWorkerPositions(task.workers.length));

	const enrichedWorkers = $derived(
		task.workers.map((worker, i) => ({
			...worker,
			id: worker.identity,
			kind: 'worker' as const,
			pos: workerPositions[i] || { x: 0, y: 0 }, // Fallback for more workers than positions
			isBreathing: worker.status === 'active',
			isBreathFinishing: workerBreathFinishing(worker),
			breathDelay: workerBreathDelay(i),
			motionType: ((): 'researching' | 'building' | 'verifying' | 'idle' => {
				switch (worker.role) {
					case 'Research':
						return 'researching';
					case 'Build':
						return 'building';
					case 'Review':
						return 'verifying';
					default:
						return 'idle';
				}
			})()
		}))
	);

	const activeMotionType = $derived.by((): 'researching' | 'building' | 'verifying' | undefined => {
		switch (task.stage) {
			case 'Research':
				return 'researching';
			case 'Build':
				return 'building';
			case 'Check':
				return 'verifying';
			default:
				return undefined;
		}
	});

	const coreNode: GraphNode & { pos: { x: number; y: number } } = {
		id: 'core',
		kind: 'core',
		status: 'active',
		pos: TASK_CORE_POS
	};

	const systemNodes = $derived.by(() => {
		const nodes: (GraphNode & { pos: { x: number; y: number } })[] = [];
		if (task.workers.length === 1) {
			if (task.stage === 'Research') {
				nodes.push({
					id: 'system-memory',
					kind: 'worker', // Mock uses 'system', but WorkSurfaceTask has 'core' | 'worker'
					role: 'Memory',
					status: 'idle',
					pos: { x: 280, y: 65 }
				});
			} else if (task.stage === 'Check') {
				nodes.push({
					id: 'system-verify',
					kind: 'worker', // Mock uses 'system', but WorkSurfaceTask has 'core' | 'worker'
					role: 'Review',
					status: 'idle',
					pos: { x: 280, y: 65 }
				});
			}
		}
		return nodes;
	});

	const allGraphNodes = $derived([...enrichedWorkers, ...systemNodes, coreNode]);

	function defaultIconForRole(role?: WorkerRole, identity?: string, shortCode?: string): string {
		// Identity-first: a known worker identity ALWAYS gets its brand mark
		// regardless of role. Role-based mapping is only the fallback for
		// unknown identities. Without this, a CC worker with role='Build'
		// would render the AGY mark — caught live 2026-06-07.
		const id = (identity || '').toLowerCase();
		const code = (shortCode || '').toUpperCase();
		if (id === 'claude-code' || code === 'CC') return 'icon-claude';
		if (id === 'antigravity' || code === 'AGY') return 'icon-antigravity';
		if (id === 'codex' || code === 'CDX') return 'icon-cdx';
		if (id === 'gemini' || code === 'GMI') return 'icon-gmi';
		if (id === 'deepseek' || code === 'DPSK') return 'icon-deepseek';
		if (id === 'cursor' || code === 'CUR') return 'icon-cursor';
		if (!role) return 'icon-system';
		switch (role) {
			case 'Research':
				return 'icon-claude';
			case 'Build':
				return 'icon-antigravity';
			case 'Review':
				return 'icon-cdx';
			case 'Memory':
			case 'Vision':
			case 'Voice':
			default:
				return 'icon-system';
		}
	}

	const allRoutes = $derived.by(() => {
		if (task.state === 'Complete' || task.state === 'Stopped' || task.state === 'Failed') {
			return []; // No active routes or packets when settled
		}

		return task.routing.edges
			.map((edge) => {
				const fromNode = allGraphNodes.find((n) => n.id === edge.from);
				const toNode = allGraphNodes.find((n) => n.id === edge.to);

				if (!fromNode || !toNode) {
					console.warn(`Missing node for edge: ${edge.from} -> ${edge.to}`);
					return null;
				}

				const sx = fromNode.pos.x;
				const sy = fromNode.pos.y;
				const ex = toNode.pos.x;
				const ey = toNode.pos.y;

				const currentPathD = pathD(sx, sy, ex, ey);

				const isCoreToWorker = fromNode.kind === 'core' && toNode.kind === 'worker';
				const isWorkerToCore = fromNode.kind === 'worker' && toNode.kind === 'core';

				// A route is primary if it's the only worker, or if the worker's role matches the active task stage
				const workerInRoute = enrichedWorkers.find(
					(w) => w.id === fromNode.id || w.id === toNode.id
				);
				const isPrimary =
					task.workers.length === 1 ||
					(workerInRoute && workerInRoute.motionType === activeMotionType);

				let packets: { delay: string; motionType: string }[] = [];
				let packetDelay: number;
				let numPackets: number;

				switch (activeMotionType) {
					case 'researching':
						packetDelay = 2.5;
						numPackets = 3;
						break;
					case 'building':
						packetDelay = 0.4;
						numPackets = 5;
						break;
					case 'verifying':
						packetDelay = 1.0;
						numPackets = 1;
						break;
					default:
						packetDelay = 0;
						numPackets = 0;
						break;
				}

				if (isPrimary && packetDelay > 0 && edge.active) {
					for (let i = 0; i < numPackets; i++) {
						packets.push({ delay: `${i * packetDelay}s`, motionType: activeMotionType! });
					}
				}

				const sourceWorker = enrichedWorkers.find((w) => w.id === edge.from);
				const sourceSystemNode = systemNodes.find((n) => n.id === edge.from);
				const fromIcon = sourceWorker
					? (sourceWorker.icon ??
						defaultIconForRole(sourceWorker.role, sourceWorker.identity, sourceWorker.shortCode))
					: sourceSystemNode
						? defaultIconForRole(sourceSystemNode.role)
						: 'icon-system';

				const isDispatchActive = edge.dispatchActive ?? edge.dispatch_active ?? false;
				const workerColor = sourceWorker
					? workerBrandColor(sourceWorker.identity, sourceWorker.shortCode)
					: 'var(--color-muted-foreground)';
				return {
					id: `${edge.from}-${edge.to}`,
					from: edge.from,
					to: edge.to,
					pathD: currentPathD,
					x1: sx,
					y1: sy,
					x2: ex,
					y2: ey,
					active: edge.active,
					dispatchActive: isDispatchActive,
					dispatch_active: isDispatchActive,
					isPrimary: isPrimary,
					isWorkerToCore,
					hasSweep: isPrimary && edge.active && activeMotionType !== undefined, // Sweep only for active primary routes
					motionType: workerInRoute?.motionType,
					packets: packets,
					isInputEdge: false, // Default, handled below
					isSpecialSystemEdge: false, // Default
					fromIcon,
					workerColor
				};
			})
			.filter((r): r is NonNullable<typeof r> => r !== null); // Filter out nulls from missing nodes
	});

	const activeDispatchRoute = $derived(
		allRoutes.find((route) => route.isPrimary && route.dispatch_active && route.isWorkerToCore)
	);
	const taskLandDuration = $derived(packetGlideDuration(activeDispatchRoute?.motionType));
	const taskReceiverColor = $derived(activeDispatchRoute?.workerColor ?? 'var(--color-st-run)');
</script>

<div
	style="position: absolute; width: 0; height: 0; overflow: hidden; pointer-events: none;"
	aria-hidden="true"
>
	<WorkerIconSprite />
</div>

<svg
	class="work-graph"
	class:idle={task.state === 'Waiting' ||
		task.state === 'Stopped' ||
		task.state === 'Failed' ||
		task.state === 'Complete' ||
		(task.state as string) === 'Idle'}
	viewBox={WORK_GRAPH_VIEWBOX}
>
	<defs>
		<marker
			id="edge-flow-arrow"
			viewBox="0 0 10 10"
			refX="8"
			refY="5"
			markerWidth="5"
			markerHeight="5"
			orient="auto"
		>
			<path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" opacity="0.9" />
		</marker>
		{#each allRoutes as route (route.id)}
			{#if route.isWorkerToCore}
				<linearGradient
					id="edge-grad-{route.id}"
					gradientUnits="userSpaceOnUse"
					x1={route.x1}
					y1={route.y1}
					x2={route.x2}
					y2={route.y2}
				>
					<stop offset="0%" stop-color={route.workerColor} stop-opacity="0.25" />
					<stop offset="72%" stop-color={route.workerColor} stop-opacity="0.55" />
					<stop offset="100%" stop-color="var(--color-st-run)" stop-opacity="0.95" />
				</linearGradient>
			{/if}
		{/each}
	</defs>

	<!-- 1. Core field rings -->
	{#each CORE_FIELD_RADII as r}
		<circle class="core-field" {r} cx={TASK_CORE_POS.x} cy={TASK_CORE_POS.y} />
	{/each}

	<!-- 2. Routes (backing, base, sweep, packets) -->
	{#each allRoutes as route (route.id)}
		{#if route.isWorkerToCore}
			<!-- Static lane: every worker shows a faint directed path into TASK -->
			<path
				class="edge-lane {route.isPrimary && route.active ? 'lane-primary' : 'lane-idle'}"
				d={route.pathD}
				marker-end="url(#edge-flow-arrow)"
			/>
		{/if}
		{#if route.isPrimary && route.active}
			<path class="edge-line-backing" d={route.pathD} />
		{/if}
		<path
			class="edge-line {route.isPrimary ? 'primary-route' : 'secondary-active'} {route.active
				? 'active'
				: ''} {route.isWorkerToCore ? 'worker-to-core' : ''}"
			d={route.pathD}
			style:stroke={route.isWorkerToCore && route.isPrimary && route.active
				? `url(#edge-grad-${route.id})`
				: undefined}
			marker-end={route.isWorkerToCore ? 'url(#edge-flow-arrow)' : undefined}
		/>
		{#if route.hasSweep && route.motionType && route.dispatch_active}
			<path
				class="edge-sweep-line {route.motionType}"
				d={route.pathD}
				style:stroke={route.workerColor}
			/>
		{/if}
		{#if route.dispatch_active}
			{#each route.packets as p, i (i)}
				<g
					class="node-icon-wrapper {p.motionType}"
					style:offset-path={`path("${route.pathD}")`}
					style:animation-delay={p.delay}
					style:--packet-color={route.workerColor}
				>
					<use href="#{route.fromIcon}" x={-5} y={-5} width={10} height={10} class="packet-shape" />
				</g>
			{/each}
		{/if}
	{/each}

	<!-- 3. Worker Nodes — per-role colour via --worker-color (matches WorkerRow waveform palette).
	     Research/Memory/Vision = cyan; Build = purple; else (Review/Verify/etc.) = orange. -->
	{#each enrichedWorkers as worker (worker.id)}
		<g
			class="worker-node node-group status-{worker.status.toLowerCase()} {worker.isBreathing
				? 'worker-breath'
				: ''} {worker.isBreathFinishing ? 'worker-surface-breath--finishing' : ''}"
			style:transform="translate({worker.pos.x}px, {worker.pos.y}px)"
			style:--worker-color={workerBrandColor(worker.identity, worker.shortCode)}
			style:--breath-delay={worker.breathDelay}
		>
			<circle class="node-ring {worker.isBreathing ? 'worker-surface-ring-breath' : ''}" r="23" />
			<circle class="node-circle" r="17" />
			<use
				href="#{worker.icon ?? defaultIconForRole(worker.role, worker.identity, worker.shortCode)}"
				x={-NODE_ICON_SIZE / 2}
				y={-NODE_ICON_SIZE / 2}
				width={NODE_ICON_SIZE}
				height={NODE_ICON_SIZE}
				class="node-icon-placeholder {worker.isBreathing ? 'worker-surface-breath' : ''}"
				style:color="var(--worker-color, var(--color-st-run))"
			/>
		</g>
	{/each}

	<!-- 4. System Nodes -->
	{#each systemNodes as node (node.id)}
		<g
			class="system-node node-group status-{node.status.toLowerCase()}"
			style:transform="translate({node.pos.x}px, {node.pos.y}px)"
		>
			<circle class="node-ring" r="23" />
			<circle class="node-circle" r="17" />
			<use
				href="#{defaultIconForRole(node.role)}"
				x={-NODE_ICON_SIZE / 2}
				y={-NODE_ICON_SIZE / 2}
				width={NODE_ICON_SIZE}
				height={NODE_ICON_SIZE}
				class="node-icon-placeholder"
				style:color="var(--color-muted-foreground)"
			/>
		</g>
	{/each}

	<!-- 5. Central TASK group -->
	<g
		class="central-task node-group status-{task.state.toLowerCase()}"
		class:task-receiving={taskLandDuration !== null}
		style:transform="translate({TASK_CORE_POS.x}px, {TASK_CORE_POS.y}px)"
		style:--land-duration={taskLandDuration ?? undefined}
		style:--receiver-color={taskReceiverColor}
	>
		{#if taskLandDuration}
			<circle class="task-land-ripple" r="20" />
		{/if}
		<circle
			class="central-task-node"
			class:task-land-core-pulse={taskLandDuration !== null}
			r="20"
		/>
		<use
			href="#icon-task"
			x={-NODE_ICON_SIZE / 2}
			y={-NODE_ICON_SIZE / 2}
			width={NODE_ICON_SIZE}
			height={NODE_ICON_SIZE}
			class="node-icon-placeholder"
			style:color="var(--color-on-brand)"
		/>
	</g>
</svg>

<style lang="postcss">
	@reference "../../app.css";

	.work-graph {
		@apply h-full w-full;
		overflow: visible; /* Allow pulse/ripple/packet animations to escape viewBox */
	}

	.node-group {
		transform-origin: center center;
	}

	.node-ring {
		fill: none;
		stroke: var(--color-border);
		stroke-width: 1;
		opacity: 0.3;
	}

	.node-circle {
		fill: var(--color-surface);
		stroke: var(--color-border);
		stroke-width: 1;
	}
	.node-icon-placeholder {
		transform-origin: center center;
	}

	/* Core Fields */
	.core-field {
		fill: none;
		stroke: var(--color-border);
		stroke-width: 1;
		opacity: 0.1;
	}

	/* Edges and Paths — worker → TASK lanes read as directed flow */
	.edge-lane {
		fill: none;
		stroke: var(--color-border);
		stroke-width: 1.25px;
		stroke-linecap: round;
		pointer-events: none;
	}
	.edge-lane.lane-idle {
		stroke-dasharray: 3 5;
		opacity: 0.14;
	}
	.edge-lane.lane-primary {
		stroke-dasharray: none;
		opacity: 0.22;
	}

	.edge-line {
		fill: none;
		stroke: var(--color-border);
		stroke-width: 1.25px;
		stroke-linecap: round;
		opacity: 0.22;
		transition:
			opacity 0.3s ease,
			stroke-width 0.3s ease;
	}
	.edge-line.worker-to-core.active.primary-route {
		stroke-width: 2px;
		opacity: 1;
	}
	.edge-line.active:not(.primary-route) {
		opacity: 0.35;
		stroke: var(--color-muted-foreground);
	}
	.edge-line.secondary-active {
		opacity: 0.08;
	}
	.edge-line.edge-input {
		stroke-dasharray: 4 4;
		opacity: 0.5;
	}

	.edge-line-backing {
		fill: none;
		stroke: var(--color-surface); /* Similar to background for a subtle effect */
		stroke-width: 4px;
		opacity: 0.7;
		transition: opacity 0.3s ease;
	}

	.edge-sweep-line {
		fill: none;
		stroke-width: 2px;
		stroke-linecap: round;
		stroke-dasharray: 0 100%;
		animation: sweepMotion 3s linear infinite;
	}
	.edge-sweep-line.researching {
		stroke: #0ea5e9; /* #0ea5e9 */
		animation-duration: 3s;
	}
	.edge-sweep-line.building {
		stroke: var(--color-status-blue); /* #3b82f6 */
		animation-duration: 2s;
	}
	.edge-sweep-line.verifying {
		stroke: var(--color-status-purple); /* #8b5cf6 */
		animation-duration: 2.5s;
	}

	/* Packets */
	.node-icon-wrapper {
		offset-path: path('M 0 0'); /* Will be overridden inline */
		offset-distance: 0%;
		animation: glidePacket 3s linear infinite; /* Base animation */
		position: absolute; /* Important for offset-path to work */
		left: 0;
		top: 0;
	}

	.node-icon-wrapper .packet-shape {
		color: var(--packet-color, var(--color-st-run));
		fill: var(--packet-color, var(--color-st-run));
		filter: drop-shadow(
			0 0 4px color-mix(in srgb, var(--packet-color, var(--color-st-run)) 55%, transparent)
		);
		width: 10px;
		height: 10px;
	}
	.node-icon-wrapper.researching {
		animation-duration: 7.5s; /* 3 packets * 2.5s delay */
	}
	.node-icon-wrapper.building {
		animation-duration: 2s; /* 5 packets * 0.4s delay */
	}
	.node-icon-wrapper.verifying {
		animation-duration: 1s; /* 1 packet * 1.0s delay */
	}

	/* Central Task Node */
	.central-task-node {
		fill: var(--color-st-run);
		stroke: var(--color-st-run);
		stroke-width: 1;
		transform-box: fill-box; /* Crucial for transform-origin: center center; */
	}
	.central-task-node + .node-icon-placeholder {
		fill: var(--color-on-brand);
	}

	/* Per-role colour on the active worker node — mirrors the WorkerRow waveform
	   palette so the surface speaks one consistent visual vocabulary. Without
	   this rule, an active worker rendered identical to default/pending; the
	   operator could not see WHERE work was being routed. The --worker-color
	   custom property is set inline on each <g class="worker-node"> from the
	   worker.role at line ~257. Fallback = --color-st-run if role is unknown. */
	/* Mobile-glow note: WebKit on iOS renders filter:drop-shadow with weaker
	   presence than Chromium. At the small graph node scale on a 390px viewport,
	   a 6px shadow barely reads. Two compensating signals so the active worker
	   pops on both platforms: (a) bigger 12px drop-shadow (stronger halo), AND
	   (b) a brighter, thicker, more opaque ring stroke (drop-shadow-independent
	   colour signal). Whichever the renderer favours, the active worker shows. */
	.work-graph .worker-node.status-active .node-icon-placeholder {
		fill: var(--worker-color, var(--color-st-run));
		filter: drop-shadow(0 0 12px var(--worker-color, var(--color-st-run)));
	}
	.work-graph .worker-node.status-active .node-ring {
		stroke: var(--worker-color, var(--color-st-run));
		stroke-width: 2.5;
		opacity: 0.75;
	}
	.work-graph .worker-node.status-active .node-circle {
		stroke: var(--worker-color, var(--color-st-run));
		stroke-width: 1;
		opacity: 0.5;
	}

	/* worker-active: shared heartbeat classes live in app.css; stagger delay here. */
	.work-graph .worker-node.worker-breath .node-icon-placeholder,
	.work-graph .worker-node.worker-breath .node-ring {
		animation-delay: var(--breath-delay, 0s);
	}
	.work-graph .worker-node.worker-breath.worker-surface-breath--finishing .node-icon-placeholder,
	.work-graph .worker-node.worker-breath.worker-surface-breath--finishing .node-ring {
		animation-duration: var(--worker-breath-duration-finishing, 1.05s);
	}

	.task-land-ripple {
		fill: none;
		stroke: var(--receiver-color, var(--color-st-run));
		stroke-width: 2;
		transform-box: fill-box;
		transform-origin: center;
		pointer-events: none;
		animation: task-land-ripple var(--land-duration, 2s) ease-out infinite;
	}

	.central-task-node.task-land-core-pulse {
		transform-box: fill-box;
		transform-origin: center;
		animation: task-land-core var(--land-duration, 2s) ease-out infinite;
	}

	/* Settle States for Graph Elements */
	.work-graph .central-task.status-complete .central-task-node,
	.work-graph .worker-node.status-done .node-icon-placeholder {
		fill: var(--color-status-green);
	}
	.work-graph .central-task.status-complete .central-task-node {
		stroke: var(--color-status-green);
	}

	.work-graph .central-task.status-waiting .central-task-node,
	.work-graph .worker-node.status-idle .node-icon-placeholder,
	.work-graph .central-task.status-stopped .central-task-node {
		fill: var(--color-status-amber);
	}
	.work-graph .central-task.status-waiting .central-task-node,
	.work-graph .central-task.status-stopped .central-task-node {
		stroke: #fcd34d;
		stroke-width: 1px;
	}

	.work-graph .central-task.status-failed .central-task-node,
	.work-graph .worker-node.status-failed .node-icon-placeholder {
		fill: var(--color-status-red);
	}
	.work-graph .central-task.status-failed .central-task-node {
		stroke: #fca5a5;
		stroke-width: 1px;
	}

	/* Keyframes */
	@keyframes sweepMotion {
		0% {
			stroke-dasharray: 0 100%;
			stroke-dashoffset: 0;
		}
		100% {
			stroke-dasharray: 100% 0;
			stroke-dashoffset: 0;
		}
	}

	@keyframes glidePacket {
		0% {
			offset-distance: 0%;
		}
		100% {
			offset-distance: 100%;
		}
	}

	/* Reduced motion */
	@media (prefers-reduced-motion: reduce) {
		.work-graph * {
			animation-duration: 0.01ms !important;
			animation-iteration-count: 1 !important;
			transition-duration: 0.01ms !important;
		}
	}

	.work-graph.idle {
		opacity: 0.4;
	}
	.work-graph.idle * {
		animation: none !important;
	}
</style>
