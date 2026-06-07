<script lang="ts">
	import type { WorkSurfaceTask, GraphNode, GraphEdge, WorkerRole } from '$lib/types/workSurface';
	import WorkerIconSprite from './WorkerIconSprite.svelte';

	let { task }: { task: WorkSurfaceTask } = $props();

	const WORK_GRAPH_VIEWBOX = '0 0 340 130';
	const TASK_CORE_POS = { x: 170, y: 65 };
	const CORE_FIELD_RADII = [17, 20, 23, 26, 29, 32];
	const NODE_ICON_SIZE = 22; // For worker icons inside circles
	const PACKET_SIZE = 12;

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

	// §3b. Edge paths (EASY — pure function)
	function pathD(sx: number, sy: number, ex: number, ey: number): string {
		if (sy === ey) {
			// Straight line for horizontal paths
			return `M ${sx} ${sy} L ${ex} ${ey}`;
		} else {
			// Quadratic bezier for curved paths, bowing away from the task core (y=65) by 10px
			const midX = (sx + ex) / 2;
			const ctrlY = sy < TASK_CORE_POS.y ? sy - 10 : sy + 10;
			return `M ${sx} ${sy} Q ${midX} ${ctrlY} ${ex} ${ey}`;
		}
	}

	const workerPositions = $derived(getWorkerPositions(task.workers.length));

	const enrichedWorkers = $derived(
		task.workers.map((worker, i) => ({
			...worker,
			id: worker.identity,
			kind: 'worker' as const,
			pos: workerPositions[i] || { x: 0, y: 0 }, // Fallback for more workers than positions
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
		const id = (identity || '').toLowerCase();
		const code = (shortCode || '').toUpperCase();
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

	// Per-identity brand colour (operator-locked 2026-06-06):
	//   CC=orange · AGY=purple · CDX=gray · DPSK=blue · GMI=light blue · CUR=warm gray
	// The active worker glow on the graph node uses THIS, set inline as
	// the --worker-color custom property. Mirrors WorkerRow's mapping.
	function workerBrandColor(identity?: string, shortCode?: string): string {
		const id = (identity || '').toLowerCase();
		const code = (shortCode || '').toUpperCase();
		if (id === 'claude-code' || code === 'CC') return '#f97316';
		if (id === 'antigravity' || code === 'AGY') return '#a855f7';
		if (id === 'codex' || code === 'CDX') return '#9ca3af';
		if (id === 'deepseek' || code === 'DPSK') return '#3b82f6';
		if (id === 'gemini' || code === 'GMI') return '#60a5fa';
		if (id === 'cursor' || code === 'CUR') return '#a8a29e';
		return 'var(--color-status-blue)';
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
				return {
					id: `${edge.from}-${edge.to}`,
					from: edge.from,
					to: edge.to,
					pathD: currentPathD,
					active: edge.active,
					dispatchActive: isDispatchActive,
					dispatch_active: isDispatchActive,
					isPrimary: isPrimary,
					hasSweep: isPrimary && edge.active && activeMotionType !== undefined, // Sweep only for active primary routes
					motionType: workerInRoute?.motionType,
					packets: packets,
					isInputEdge: false, // Default, handled below
					isSpecialSystemEdge: false, // Default
					fromIcon
				};
			})
			.filter((r): r is NonNullable<typeof r> => r !== null); // Filter out nulls from missing nodes
	});
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
	<!-- 1. Core field rings -->
	{#each CORE_FIELD_RADII as r}
		<circle class="core-field" {r} cx={TASK_CORE_POS.x} cy={TASK_CORE_POS.y} />
	{/each}

	<!-- 2. Routes (backing, base, sweep, packets) -->
	{#each allRoutes as route (route.id)}
		{#if route.isPrimary && route.active}
			<path class="edge-line-backing" d={route.pathD} />
		{/if}
		<path
			class="edge-line {route.isPrimary ? '' : 'secondary-active'} {route.active ? 'active' : ''}"
			d={route.pathD}
		/>
		{#if route.hasSweep && route.motionType && route.dispatch_active}
			<path class="edge-sweep-line {route.motionType}" d={route.pathD} />
		{/if}
		{#if route.dispatch_active}
			{#each route.packets as p, i (i)}
				<g
					class="node-icon-wrapper {p.motionType}"
					style:offset-path={`path("${route.pathD}")`}
					style:animation-delay={p.delay}
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
			class="worker-node node-group status-{worker.status.toLowerCase()}"
			style:transform="translate({worker.pos.x}px, {worker.pos.y}px)"
			style:--worker-color={workerBrandColor(worker.identity, worker.shortCode)}
		>
			<circle class="node-ring" r="23" />
			<circle class="node-circle" r="17" />
			<use
				href="#{worker.icon ?? defaultIconForRole(worker.role, worker.identity, worker.shortCode)}"
				x={-NODE_ICON_SIZE / 2}
				y={-NODE_ICON_SIZE / 2}
				width={NODE_ICON_SIZE}
				height={NODE_ICON_SIZE}
				class="node-icon-placeholder"
				style:color="var(--worker-color, var(--color-st-run))"
			/>
			<text
				class="node-label"
				x="0"
				y={NODE_ICON_SIZE / 2 + 8}
				text-anchor="middle"
				dominant-baseline="hanging">{worker.shortCode}</text
			>
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
			<text
				class="node-label"
				x="0"
				y={NODE_ICON_SIZE / 2 + 8}
				text-anchor="middle"
				dominant-baseline="hanging">{node.role === 'Memory' ? 'Memory' : node.role}</text
			>
		</g>
	{/each}

	<!-- 5. Central TASK group -->
	<g
		class="central-task node-group status-{task.state.toLowerCase()}"
		style:transform="translate({TASK_CORE_POS.x}px, {TASK_CORE_POS.y}px)"
	>
		<circle class="central-task-node" r="20" />
		<use
			href="#icon-system"
			x={-NODE_ICON_SIZE / 2}
			y={-NODE_ICON_SIZE / 2}
			width={NODE_ICON_SIZE}
			height={NODE_ICON_SIZE}
			class="node-icon-placeholder"
			style:color="var(--color-on-brand)"
		/>
		<text
			class="node-label"
			x="0"
			y={NODE_ICON_SIZE / 2 + 8}
			text-anchor="middle"
			dominant-baseline="hanging">TASK</text
		>
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
	.node-label {
		@apply text-xs font-semibold text-white; /* Adjust as needed for specific nodes */
		fill: var(--color-muted-foreground);
		font-size: 8px; /* Matching mock's label size */
	}

	/* Core Fields */
	.core-field {
		fill: none;
		stroke: var(--color-border);
		stroke-width: 1;
		opacity: 0.1;
	}

	/* Edges and Paths */
	.edge-line {
		fill: none;
		stroke: var(--color-border);
		stroke-width: 1px;
		opacity: 0.3;
		transition: opacity 0.3s ease;
	}
	.edge-line.active {
		opacity: 0.7;
		stroke: var(--color-muted-foreground);
	}
	.edge-line.secondary-active {
		opacity: 0.1;
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
		color: var(--color-st-run); /* Default packet color */
		fill: var(--color-st-run);
		width: 10px;
		height: 10px;
	}
	.node-icon-wrapper.researching {
		animation-duration: 7.5s; /* 3 packets * 2.5s delay */
	}
	.node-icon-wrapper.researching .packet-shape {
		fill: #0ea5e9;
	}
	.node-icon-wrapper.building {
		animation-duration: 2s; /* 5 packets * 0.4s delay */
	}
	.node-icon-wrapper.building .packet-shape {
		fill: var(--color-status-blue);
	}
	.node-icon-wrapper.verifying {
		animation-duration: 1s; /* 1 packet * 1.0s delay */
	}
	.node-icon-wrapper.verifying .packet-shape {
		fill: var(--color-status-purple);
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
	.central-task-node + .node-icon-placeholder + .node-label {
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
