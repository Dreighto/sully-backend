/* ==========================================================================
   SULLY WORK SURFACE MOTION MOCKUP ENGINE - v3.1 VISIBILITY PASS
   ========================================================================== */

// 1. INLINED SVG DEFINITIONS FOR LOCAL FILE STANDALONE RENDERING
const SVG_DEFS = `
<defs>
  <!-- Worker: Claude -->
  <g id="icon-claude"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M19 9h2v2h-2v2h-1v2h-1v-2h-1v2h-1v-2h-4v2H9v-2H8v2H7v-2H6v-2H4V9h2V5h13v4zM8 9h1V7H8v2zm7 0h1V7h-1v2z"/></g>
  <!-- Worker: Antigravity -->
  <g id="icon-antigravity"><path fill="currentColor" d="M19.5 19.5c1 .8 2.5.3 1-.8-4.2-4.1-3.3-15.3-8.5-15.3S8.7 14.6 4.5 18.7c-1.5 1.1 0 1.5 1 .8 3.9-2.7 3.6-7.4 7.3-7.4s6.7 4.7 6.7 7.4z"/></g>
  <!-- Worker: Codex -->
  <g id="icon-codex"><path fill="currentColor" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm-2.8 11.2a1 1 0 0 1-1.6 1l-2-3.4a1 1 0 0 1 0-1l2-3.4a1 1 0 0 1 1.6 1L8 12.3zm6.8 1.8h-4a1 1 0 0 1 0-2h4a1 1 0 0 1 0 2z"/></g>
  <!-- Worker: Gemini -->
  <g id="icon-gemini"><path fill="currentColor" d="M11 18.2q.9 2 .9 4.3 0-2.3.9-4.3t2.6-3.6 3.6-2.5q2-.9 4.3-.9-2.3 0-4.3-.9a11 11 0 0 1-3.6-2.6 11 11 0 0 1-2.6-3.6Q12 2.3 12 0q0 2.3-1 4.3-.9 2-2.5 3.6a11 11 0 0 1-3.6 2.6Q2.3 11 0 11q2.3 0 4.3 1 2 .9 3.6 2.5t2.5 3.6"/></g>
  <!-- Worker: DeepSeek -->
  <g id="icon-deepseek"><path fill="currentColor" d="M22 6.5c-.2-.1-.3.1-.4.2 0 .1 0 .1-.1.2-.3.3-.6.5-1.1.5-.7-.1-1.3.1-1.8.7-.1-.7-.5-1.1-1.1-1.4-.3-.1-.6-.2-.8-.5-.1-.2-.2-.4-.3-.6-.1-.2-.2-.4-.3-.6-.1-.2-.2-.4-.3-.6-.1-.2-.2-.4-.3-.6-.1-.2-.2-.4-.3-.6-.1-.2-.2-.4-.3-.6-.1-.2-.2-.4-.3-.6-.1-.2-.2-.4-.3-.6-.1-.2-.2-.4-.3-.6-.1-.2-.2-.4-.3-.6-.1-.2-.2-.4-.3-.6L12 18c-1.7-1.3-2.5-1.8-2.9-1.8-.3 0-.3.4-.2.6v.7c.1.2.2.5-.1.7-.5.3-1.5-.1-1.5-.1-1.1-.7-2-1.5-2.6-2.7-.6-1.2-1-2.4-1.1-3.7 0-.3.1-.4.4-.5.4-.1.8-.1 1.2-.1 1.7.3 3.1 1.1 4.3 2.3.7.7 1.2 1.5 1.8 2.3.6.9 1.2 1.7 2 2.4.3.2.5.4.7.6-.6.1-1.6.1-2.3-.7z"/></g>
  <!-- System: Memory -->
  <g id="icon-memory"><path fill="currentColor" d="M12 2A10 10 0 1 0 22 12A10 10 0 0 0 12 2zm1 14h-2v-2h2zm0-4h-2V7h2z"/></g>
  <!-- System: Verify -->
  <g id="icon-verify"><path fill="currentColor" d="M12 2L4 5v7c0 5.2 3.4 10.1 8 11.3 4.6-1.2 8-6.1 8-11.3V5l-8-3zm-1 15l-4-4 1.4-1.4 2.6 2.6 6.6-6.6 1.4 1.4-8 8z"/></g>
  <!-- System: Approval -->
  <g id="icon-approval"><path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zM8 12h8v2H8v-2zm0 4h8v2H8v-2z"/></g>
  <!-- System: Dispatch -->
  <g id="icon-dispatch"><circle cx="5" cy="12" r="2.5" fill="currentColor"/><circle cx="19" cy="5" r="2.5" fill="currentColor"/><circle cx="19" cy="12" r="2.5" fill="currentColor"/><circle cx="19" cy="19" r="2.5" fill="currentColor"/><path d="M8 10.5l8-3.5M8 12h8M8 13.5l8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></g>
  <!-- System: Blocked -->
  <g id="icon-blocked"><path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8 0-1.8.6-3.5 1.7-4.9L16.9 18.3c-1.4 1.1-3.1 1.7-4.9 1.7zm5.3-3.1L6.7 6.7C8.1 5.6 9.8 5 12 5c4.4 0 8 3.6 8 8 0 1.8-.6 3.5-1.7 4.9z"/></g>
  <!-- System: Task -->
  <g id="icon-task"><path fill="currentColor" d="M19 3h-4.2a3 3 0 0 0-5.6 0H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-7 0a1 1 0 1 1-1 1 1 1 0 0 1 1-1zm2 14H8v-2h6zm4-4H8v-2h10z"/></g>
  <!-- System: Packet -->
  <g id="icon-packet"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5M12 12v10"/></g>
</defs>
`;

// 2. SIMULATION PRESETS
const PRESETS = {
	'cc-only': {
		title: 'CC Schema Analysis',
		prompt: 'Assess database migrations index layout.',
		systemStatus: 'Sully has dispatched the Coordinator to analyze schemas.',
		status: 'working',
		statusText: 'Working',
		bannerText: "Next: <span class='banner-highlight'>Optimizing database lookup speed</span>",
		bannerIcon: '⚡',
		headerIcon: 'icon-dispatch',
		activeOwnershipLabel: 'Now: CC researching database indexes',
		activeClass: 'working',
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'active',
				desc: 'Researching index tables'
			}
		],
		phases: [
			{ name: 'Reading user payload', state: 'done', time: '0.2s' },
			{ name: 'Mapping tables & indexing schemas', state: 'active', time: 'Running' },
			{ name: 'Compiling optimization queries', state: 'pending', time: '--' }
		],
		proofScore: 'Active',
		proofDetail: 'Coordinator verifying index bounds. Graph edges active.'
	},
	'cc-verify': {
		title: 'Handshake Diagnostic',
		prompt: 'Verify secure SSL certificate handshake bindings.',
		systemStatus: 'Sully Coordinator ports verified; Verify QA running handshake tests.',
		status: 'checking',
		statusText: 'Checking',
		bannerText: "Next: <span class='banner-highlight'>Submitting validation report</span>",
		bannerIcon: '🔍',
		headerIcon: 'icon-verify',
		activeOwnershipLabel: 'Now: Verify checking TLS connection handshake',
		activeClass: 'checking',
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'complete',
				desc: 'Ports checked'
			},
			{
				key: 'Ver',
				icon: 'icon-verify',
				role: 'QA Verify',
				state: 'active-checking',
				desc: 'Running TLS v1.3 scans'
			}
		],
		phases: [
			{ name: 'Scanning open gateway ports', state: 'done', time: '0.4s' },
			{ name: 'Checking handshake security profiles', state: 'active', time: 'Checking' },
			{ name: 'Waiting for operator approval', state: 'pending', time: '--' }
		],
		proofScore: '96% Confidence',
		proofDetail: 'SSL negotiation test run matches standard cryptographic validation profiles.'
	},
	'agy-verify': {
		title: 'Deck Handler Refinements',
		prompt: 'Apply mobile-first drag handling routines.',
		systemStatus: 'Antigravity writing gesture code; QA suite checks queued.',
		status: 'working',
		statusText: 'Working',
		bannerText: "Next: <span class='banner-highlight'>Running gesture telemetry scripts</span>",
		bannerIcon: '⚡',
		headerIcon: 'icon-antigravity',
		activeOwnershipLabel: 'Now: AGY building touch gesture handlers',
		activeClass: 'working',
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'complete',
				desc: 'Scope verified'
			},
			{
				key: 'AGY',
				icon: 'icon-antigravity',
				role: 'Antigravity Agent',
				state: 'active',
				desc: 'Writing drag handlers'
			},
			{
				key: 'Ver',
				icon: 'icon-verify',
				role: 'QA Verify',
				state: 'waiting',
				desc: 'Queued behind build'
			}
		],
		phases: [
			{ name: 'Ingesting touch specifications', state: 'done', time: '0.1s' },
			{ name: 'Injecting drag logic modules', state: 'active', time: 'Writing' },
			{ name: 'Verifying coordinate boundary limits', state: 'pending', time: '--' }
		],
		proofScore: 'Queued',
		proofDetail: 'Gesture test blocks built. Awaiting Touch Handlers compilation.'
	},
	'dpsk-verify': {
		title: 'Sully is checking schema logic',
		prompt: 'Verify database constraints and triggers.',
		systemStatus: 'DeepSeek active verifying constraints logic; QA queued.',
		status: 'checking',
		statusText: 'Checking',
		bannerText: "Next: <span class='banner-highlight'>Reviewing logic constraint rules</span>",
		bannerIcon: '🔍',
		headerIcon: 'icon-deepseek',
		activeOwnershipLabel: 'Now: DeepSeek verifying schema constraints logic',
		activeClass: 'checking',
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'complete',
				desc: 'Routing complete'
			},
			{
				key: 'DPSK',
				icon: 'icon-deepseek',
				role: 'DeepSeek',
				state: 'active-checking',
				desc: 'Verifying trigger constraints'
			},
			{
				key: 'Ver',
				icon: 'icon-verify',
				role: 'QA Verify',
				state: 'waiting',
				desc: 'Awaiting constraints'
			}
		],
		phases: [
			{ name: 'Mapping model keys', state: 'done', time: '0.3s' },
			{ name: 'Evaluating check triggers', state: 'active', time: 'Verifying' },
			{ name: 'Running integration validation', state: 'pending', time: '--' }
		],
		proofScore: 'Active',
		proofDetail: 'DeepSeek scanning database model mappings. 12 triggers validated.'
	},
	'multi-worker': {
		title: 'Similarity Index Build',
		prompt: 'Process embeddings archive logs context search.',
		systemStatus: 'Antigravity generating vectors; Memory indexes resolved.',
		status: 'working',
		statusText: 'Working',
		bannerText: "Next: <span class='banner-highlight'>Deploying neural similarity matrix</span>",
		bannerIcon: '⚡',
		headerIcon: 'icon-memory',
		activeOwnershipLabel: 'Now: AGY compiling logs similarity arrays',
		activeClass: 'working',
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'complete',
				desc: 'Workflow mapped'
			},
			{
				key: 'AGY',
				icon: 'icon-antigravity',
				role: 'Antigravity Agent',
				state: 'active',
				desc: 'Synthesizing similarity matrices'
			},
			{
				key: 'Mem',
				icon: 'icon-memory',
				role: 'Memory',
				state: 'complete',
				desc: 'Log indices mapped'
			},
			{
				key: 'Ver',
				icon: 'icon-verify',
				role: 'QA Verify',
				state: 'waiting',
				desc: 'Awaiting final index'
			}
		],
		phases: [
			{ name: 'Reading log history logs', state: 'done', time: '0.3s' },
			{ name: 'Indexing embeddings with vector logic', state: 'active', time: 'Embedding' },
			{ name: 'Validating index latency tests', state: 'pending', time: '--' }
		],
		proofScore: '89% Confidence',
		proofDetail: 'Referencing five memory blocks. Minimum match threshold validated at >= 0.81.'
	},
	blocked: {
		title: 'Approval Needed',
		prompt: 'Delete production migration backup folder logs.',
		systemStatus: 'Sully has paused work. Operator override is required.',
		status: 'blocked',
		statusText: 'Waiting on You',
		bannerText: 'Operator verification required to execute folder deletion.',
		bannerIcon: '⚠️',
		headerIcon: 'icon-blocked',
		activeOwnershipLabel: 'Now: Halted - waiting on operator override',
		activeClass: 'blocked',
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'active-blocked',
				desc: 'Halted at Gate'
			},
			{ key: 'Ver', icon: 'icon-verify', role: 'QA Verify', state: 'idle', desc: 'Halted' }
		],
		phases: [
			{ name: 'Scanning backup files', state: 'done', time: '0.2s' },
			{ name: 'Checking directory protection rules', state: 'done', time: '0.4s' },
			{ name: 'Awaiting manual operator signature', state: 'active', time: 'Halted' }
		],
		proofScore: 'Override Req.',
		proofDetail:
			'Action matches protected pattern: DELETE PRODUCTION LOGS. Halted for operator safety.'
	},
	complete: {
		title: 'Pipeline Verified',
		prompt: 'Deploy sandbox gateway hotfix v1.4.3.',
		systemStatus: 'Hotfix deployment complete. Verification runs successful.',
		status: 'complete',
		statusText: 'Complete',
		bannerText: 'Execution successful. Sandbox environment cleaned.',
		bannerIcon: '✓',
		headerIcon: 'icon-verify',
		activeOwnershipLabel: 'Now: Settled - execution successful',
		activeClass: 'complete',
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'complete',
				desc: 'Successful'
			},
			{ key: 'Ver', icon: 'icon-verify', role: 'QA Verify', state: 'complete', desc: 'Validated' }
		],
		phases: [
			{ name: 'Reading deployment schema', state: 'done', time: '0.1s' },
			{ name: 'Spawning gateway containers', state: 'done', time: '0.8s' },
			{ name: 'Running socket handshake QA checks', state: 'done', time: '1.2s' },
			{ name: 'Compiling response package', state: 'done', time: '0.2s' }
		],
		proofScore: '100% Success',
		proofDetail: 'All four testing suites compiled and executed successfully with zero failures.'
	}
};

// Layout coordinates
const WORKER_POSITIONS = {
	1: [{ x: 60, y: 65 }],
	2: [
		{ x: 60, y: 65 },
		{ x: 280, y: 65 }
	],
	3: [
		{ x: 60, y: 30 },
		{ x: 60, y: 100 },
		{ x: 280, y: 65 }
	],
	4: [
		{ x: 60, y: 30 },
		{ x: 60, y: 100 },
		{ x: 280, y: 30 },
		{ x: 280, y: 100 }
	]
};

// State trackers
let currentPreset = 'cc-only';
let currentState = 'compact';
let confirmApprove = false;
let confirmStop = false;
let currentIntensity = 'normal';

function logTelemetry(msg) {
	const logBox = document.getElementById('telemetryLog');
	if (logBox) {
		const logSpan = document.createElement('span');
		logSpan.innerText = `\n[V3.1 INT:${currentIntensity.toUpperCase()}] ${msg}`;
		logBox.appendChild(logSpan);
		logBox.scrollTop = logBox.scrollHeight;
	}
}

// GRAPH DRAWING
function renderGraph(svgId, preset) {
	const svg = document.getElementById(svgId);
	if (!svg) return;

	svg.innerHTML = '';
	svg.insertAdjacentHTML('afterbegin', SVG_DEFS);

	const workers = preset.workers;
	const count = workers.length;
	const layout = WORKER_POSITIONS[count] || WORKER_POSITIONS[4];

	// 1. Draw paths
	workers.forEach((w, idx) => {
		const pos = layout[idx];
		const targetX = 170;
		const targetY = 65;

		let pathD;
		if (pos.y === targetY) {
			pathD = `M ${pos.x} ${pos.y} L ${targetX} ${targetY}`;
		} else {
			const ctrlX = (pos.x + targetX) / 2;
			const ctrlY = pos.y < targetY ? pos.y - 12 : pos.y + 12;
			pathD = `M ${pos.x} ${pos.y} Q ${ctrlX} ${ctrlY} ${targetX} ${targetY}`;
		}

		const isActiveWorkerRoute =
			w.state === 'active' || w.state === 'active-checking' || w.state === 'active-blocked';

		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', pathD);

		let routeClass = 'edge-line';
		if (isActiveWorkerRoute) {
			if (preset.status === 'checking') routeClass += ' active-route-checking';
			else routeClass += ' active-route';
		}
		path.setAttribute('class', routeClass);
		svg.appendChild(path);

		// 2. Draw packets ONLY on active routes (packets are always flowing in v3.1 unless motion reduced maybe)
		if (isActiveWorkerRoute && preset.status !== 'complete' && preset.status !== 'blocked') {
			for (let i = 0; i < 3; i++) {
				const packetGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
				packetGroup.setAttribute('class', 'node-icon-wrapper');

				const packetUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
				packetUse.setAttribute('href', '#icon-packet');
				packetUse.setAttribute('x', '-8');
				packetUse.setAttribute('y', '-8');
				packetUse.setAttribute('width', '16');
				packetUse.setAttribute('height', '16');

				let activePacketClass = 'data-packet animating';
				if (preset.status === 'checking') activePacketClass += ' active-packet-checking';
				else activePacketClass += ' active-packet-working';

				packetUse.setAttribute('class', activePacketClass);
				packetUse.style.offsetPath = `path("${pathD}")`;
				packetUse.style.animation = `glidePacket 3.6s cubic-bezier(0.25, 0.8, 0.25, 1) infinite`;
				packetUse.style.animationDelay = `${i * 1.2}s`;

				packetGroup.appendChild(packetUse);
				svg.appendChild(packetGroup);
			}
		}
	});

	// 3. Draw Worker Nodes
	workers.forEach((w, idx) => {
		const pos = layout[idx];
		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		g.setAttribute('class', `node-group-animated stagger-${(idx % 4) + 1}`);

		const isActiveWorker =
			w.state === 'active' || w.state === 'active-checking' || w.state === 'active-blocked';

		const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		circle.setAttribute('cx', pos.x);
		circle.setAttribute('cy', pos.y);
		circle.setAttribute('r', '16');

		let nodeClass = 'node-circle';
		if (isActiveWorker) {
			if (w.state === 'active-checking') nodeClass += ' active-worker-checking breath-delay-1';
			else if (w.state === 'active-blocked') nodeClass += ' active-worker-blocked breath-delay-1';
			else nodeClass += ' active-worker breath-delay-1';
		} else {
			nodeClass += ` status-${w.state}`;
		}

		circle.setAttribute('class', nodeClass);
		g.appendChild(circle);

		const iconG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		iconG.setAttribute('class', 'node-icon-wrapper');

		const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
		use.setAttribute('href', `#${w.icon}`);
		use.setAttribute('x', pos.x - 10);
		use.setAttribute('y', pos.y - 10);
		use.setAttribute('width', '20');
		use.setAttribute('height', '20');
		use.setAttribute('style', 'color: var(--sully-text);');

		iconG.appendChild(use);
		g.appendChild(iconG);

		const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		label.setAttribute('x', pos.x);
		label.setAttribute('y', pos.y + 24);
		label.setAttribute('text-anchor', 'middle');
		label.setAttribute('fill', isActiveWorker ? '#fff' : 'var(--sully-text-muted)');
		label.setAttribute('font-size', '8.5px');
		label.setAttribute('font-weight', 'bold');
		label.textContent = w.key;
		g.appendChild(label);

		svg.appendChild(g);
	});

	// 4. Central Task Node
	const centralG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
	centralG.setAttribute('class', 'node-group-animated stagger-3');

	const centralCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
	centralCircle.setAttribute('cx', '170');
	centralCircle.setAttribute('cy', '65');
	centralCircle.setAttribute('r', '20');
	centralCircle.setAttribute('class', `node-circle central-task-node status-${preset.status}`);
	centralG.appendChild(centralCircle);

	const centralIconUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
	centralIconUse.setAttribute('href', '#icon-task');
	centralIconUse.setAttribute('x', '159');
	centralIconUse.setAttribute('y', '54');
	centralIconUse.setAttribute('width', '22');
	centralIconUse.setAttribute('height', '22');
	centralIconUse.setAttribute('style', 'color: var(--sully-text);');
	centralG.appendChild(centralIconUse);

	const centralLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
	centralLabel.setAttribute('x', '170');
	centralLabel.setAttribute('y', '97');
	centralLabel.setAttribute('text-anchor', 'middle');
	centralLabel.setAttribute('fill', '#fff');
	centralLabel.setAttribute('font-size', '9px');
	centralLabel.setAttribute('font-weight', 'bold');
	centralLabel.textContent = 'TASK';
	centralG.appendChild(centralLabel);

	svg.appendChild(centralG);
}

function updateUI() {
	const data = PRESETS[currentPreset];
	const card = document.getElementById('sullyCard');

	card.className = `sully-card state-${currentState} status-${data.status}`;

	document.getElementById('collapsedTitle').innerText = data.title;
	document.getElementById('collapsedMeta').innerText = data.workers.map((w) => w.key).join(' + ');

	document.getElementById('compactTaskTitle').innerText = data.title;
	document.getElementById('compactStatusBadge').innerText = data.statusText;
	document.getElementById('compactStatusBadge').className = `status-pill status-${data.status}`;

	const banner = document.getElementById('compactBanner');
	banner.innerHTML = `<span class="banner-icon">${data.bannerIcon}</span><span class="banner-text">${data.bannerText}</span>`;

	const headerIconWrapper = document.getElementById('systemHeaderIcon');
	headerIconWrapper.innerHTML = `<svg><use href="#${data.headerIcon}"/></svg>`;

	const expandedHeaderIconWrapper = document.getElementById('expandedHeaderIcon');
	expandedHeaderIconWrapper.innerHTML = `<svg><use href="#${data.headerIcon}"/></svg>`;

	document.getElementById('userBubble').innerText = data.prompt;
	document.getElementById('systemBubble').innerText = data.systemStatus;

	renderGraph('graphSvg', data);
	renderGraph('expandedGraphSvg', data);

	const compactOwnershipLabel = document.getElementById('compactOwnershipLabel');
	const expandedOwnershipLabel = document.getElementById('expandedOwnershipLabel');

	compactOwnershipLabel.className = `active-ownership-banner ${data.activeClass}`;
	expandedOwnershipLabel.className = `active-ownership-banner ${data.activeClass}`;

	const labelContent = `Now: ${data.activeOwnershipLabel}`;
	compactOwnershipLabel.querySelector('.ownership-text').innerText = labelContent;
	expandedOwnershipLabel.querySelector('.ownership-text').innerText = labelContent;

	const checklist = document.getElementById('phasesChecklist');
	checklist.innerHTML = data.phases
		.map(
			(p) => `
    <div class="phase-row ${p.state}">
      <div class="phase-left">
        <span class="phase-dot"></span>
        <span>${p.name}</span>
      </div>
      <span class="phase-time">${p.time}</span>
    </div>
  `
		)
		.join('');

	const workersGrid = document.getElementById('workersGrid');
	workersGrid.innerHTML = data.workers
		.map((w) => {
			const isActive =
				w.state === 'active' || w.state === 'active-checking' || w.state === 'active-blocked';
			let rowClass = 'worker-row';
			let badgeHtml = '';

			if (isActive) {
				if (w.state === 'active-checking') {
					rowClass += ' row-active-highlight-checking';
					badgeHtml = `<span class="worker-badge-pill badge-now-checking">Verifying</span>`;
				} else if (w.state === 'active-blocked') {
					rowClass += ' row-active-highlight-blocked';
					badgeHtml = `<span class="worker-badge-pill badge-blocked">Blocked</span>`;
				} else {
					rowClass += ' row-active-highlight';
					badgeHtml = `<span class="worker-badge-pill badge-now">Now working</span>`;
				}
			} else if (w.state === 'complete') {
				rowClass += ' complete';
				badgeHtml = `<span class="worker-badge-pill badge-done">Done</span>`;
			} else if (w.state === 'waiting') {
				rowClass += ' idle';
				badgeHtml = `<span class="worker-badge-pill badge-waiting">Waiting</span>`;
			} else {
				rowClass += ' idle';
				badgeHtml = `<span class="worker-badge-pill badge-waiting">Idle</span>`;
			}

			return `
      <div class="${rowClass}">
        <div class="worker-left">
          <span class="worker-dot"></span>
          <span class="worker-identity">${w.key} <span class="worker-role">(${w.role})</span></span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="worker-status">${w.desc}</span>
          ${badgeHtml}
        </div>
      </div>
    `;
		})
		.join('');

	const proofContainer = document.getElementById('proofContainer');
	proofContainer.innerHTML = `
    <div class="proof-header">
      <span>QA Cryptographic Proof</span>
      <span class="proof-conf">${data.proofScore}</span>
    </div>
    <p class="proof-log">${data.proofDetail}</p>
  `;

	renderActionButtons(data);
}

function renderActionButtons(data) {
	const compactActions = document.getElementById('compactActions');
	const expandedActions = document.getElementById('expandedActions');

	let buttonHtml = '';

	if (data.status === 'blocked') {
		buttonHtml = `
      <button class="sully-btn btn-secondary" id="btnStop">
        ${confirmStop ? 'Confirm stopping?' : 'Stop Task'}
      </button>
      <button class="sully-btn ${confirmApprove ? 'btn-danger-confirm' : 'btn-approve'}" id="btnApprove">
        ${confirmApprove ? 'Confirm deletion?' : 'Approve Override'}
      </button>
    `;
		compactActions.style.display = 'flex';
	} else if (data.status === 'working' || data.status === 'checking') {
		buttonHtml = `
      <button class="sully-btn ${confirmStop ? 'btn-stop-confirm' : 'btn-secondary'}" id="btnStop" style="width: 100%;">
        ${confirmStop ? 'Confirm stopping active task?' : 'Stop Pipeline'}
      </button>
    `;
		compactActions.style.display = 'none';
	} else if (data.status === 'complete') {
		buttonHtml = `
      <button class="sully-btn btn-complete-view" id="btnComplete" style="width: 100%;">
        View Sandbox Deployment Logs
      </button>
    `;
		compactActions.style.display = 'none';
	} else {
		compactActions.style.display = 'none';
	}

	if (compactActions.style.display === 'flex') {
		compactActions.innerHTML = buttonHtml;
	}
	expandedActions.innerHTML = buttonHtml;

	bindActionListeners();
}

function bindActionListeners() {
	const btnApprove = document.querySelectorAll('#btnApprove');
	btnApprove.forEach((btn) => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (!confirmApprove) {
				confirmApprove = true;
				logTelemetry('Approve override requested. Double-tap trigger armed.');
				updateUI();
			} else {
				confirmApprove = false;
				logTelemetry('Signed operator approval override. settling v3 sweep.');
				const card = document.getElementById('sullyCard');
				card.classList.add('sweep-active');
				setTimeout(() => {
					card.classList.remove('sweep-active');
					currentPreset = 'complete';
					updatePresetsPanelHighlight();
					updateUI();
				}, 1200);
			}
		});
	});

	const btnStop = document.querySelectorAll('#btnStop');
	btnStop.forEach((btn) => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (!confirmStop) {
				confirmStop = true;
				logTelemetry('Aborting pipeline safety confirmation requested.');
				updateUI();
			} else {
				confirmStop = false;
				logTelemetry('Aborted task. resetting work surface states.');
				currentPreset = 'cc-only';
				confirmApprove = false;
				updatePresetsPanelHighlight();
				updateUI();
			}
		});
	});

	const btnComplete = document.querySelectorAll('#btnComplete');
	btnComplete.forEach((btn) => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			logTelemetry('Opening deployment telemetry logs.');
			alert('Deployment validation logs loaded. Build success.');
		});
	});
}

function updatePresetsPanelHighlight() {
	const btns = document.querySelectorAll('#presetControls button');
	btns.forEach((btn) => {
		if (btn.getAttribute('data-preset') === currentPreset) {
			btn.classList.add('active');
		} else {
			btn.classList.remove('active');
		}
	});
}

document.addEventListener('DOMContentLoaded', () => {
	const presetBtns = document.querySelectorAll('#presetControls button');
	presetBtns.forEach((btn) => {
		btn.addEventListener('click', () => {
			currentPreset = btn.getAttribute('data-preset');
			confirmApprove = false;
			confirmStop = false;

			presetBtns.forEach((b) => b.classList.remove('active'));
			btn.classList.add('active');

			logTelemetry(`Preset updated: ${currentPreset}`);
			updateUI();
		});
	});

	const layoutBtns = document.querySelectorAll('#layoutControls button');
	layoutBtns.forEach((btn) => {
		btn.addEventListener('click', () => {
			currentState = btn.getAttribute('data-state');
			layoutBtns.forEach((b) => b.classList.remove('active'));
			btn.classList.add('active');

			logTelemetry(`Display state: ${currentState}`);
			updateUI();
		});
	});

	document.getElementById('closeExpandedBtn').addEventListener('click', (e) => {
		e.stopPropagation();
		currentState = 'compact';

		layoutBtns.forEach((b) => {
			if (b.getAttribute('data-state') === 'compact') b.classList.add('active');
			else b.classList.remove('active');
		});

		logTelemetry('Surface collapsed to compact card.');
		updateUI();
	});

	document.getElementById('sullyCard').addEventListener('click', (e) => {
		if (e.target.closest('.sully-btn') || e.target.closest('#closeExpandedBtn')) return;

		if (currentState === 'collapsed') {
			currentState = 'compact';
			logTelemetry('Collapsed pill expanded to compact.');
		} else if (currentState === 'compact') {
			currentState = 'expanded';
			logTelemetry('Compact card unfolded to expanded registry.');
		}

		layoutBtns.forEach((b) => {
			if (b.getAttribute('data-state') === currentState) b.classList.add('active');
			else b.classList.remove('active');
		});

		updateUI();
	});

	// Motion Intensity Toggle
	const intensityRadios = document.querySelectorAll('input[name="intensity"]');
	intensityRadios.forEach((radio) => {
		radio.addEventListener('change', (e) => {
			if (e.target.checked) {
				currentIntensity = e.target.value;
				document.body.className = `intensity-${currentIntensity}`;
				logTelemetry(`Set motion intensity to: ${currentIntensity}`);
			}
		});
	});

	updateUI();
});
