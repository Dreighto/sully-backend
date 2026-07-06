/* ==========================================================================
   SULLY WORK SURFACE MOTION MOCKUP ENGINE (v1)
   ========================================================================== */

// 1. INLINED SVG DEFINITIONS FOR LOCAL RENDERING WITHOUT CORS SECURITY BLOCKS
const SVG_DEFS = `
<defs>
  <!-- Worker: Claude Code -->
  <g id="icon-claude">
    <path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M19 9h2v2h-2v2h-1v2h-1v-2h-1v2h-1v-2h-4v2H9v-2H8v2H7v-2H6v-2H4V9h2V5h13v4zM8 9h1V7H8v2zm7 0h1V7h-1v2z"/>
  </g>

  <!-- Worker: Antigravity -->
  <g id="icon-antigravity">
    <path fill="currentColor" d="M19.5 19.5c1 .8 2.5.3 1-.8-4.2-4.1-3.3-15.3-8.5-15.3S8.7 14.6 4.5 18.7c-1.5 1.1 0 1.5 1 .8 3.9-2.7 3.6-7.4 7.3-7.4s6.7 4.7 6.7 7.4z"/>
  </g>

  <!-- Worker: Codex -->
  <g id="icon-codex">
    <path fill="currentColor" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm-2.8 11.2a1 1 0 0 1-1.6 1l-2-3.4a1 1 0 0 1 0-1l2-3.4a1 1 0 0 1 1.6 1L8 12.3zm6.8 1.8h-4a1 1 0 0 1 0-2h4a1 1 0 0 1 0 2z"/>
  </g>

  <!-- Worker: Gemini -->
  <g id="icon-gemini">
    <path fill="currentColor" d="M11 18.2q.9 2 .9 4.3 0-2.3.9-4.3t2.6-3.6 3.6-2.5q2-.9 4.3-.9-2.3 0-4.3-.9a11 11 0 0 1-3.6-2.6 11 11 0 0 1-2.6-3.6Q12 2.3 12 0q0 2.3-1 4.3-.9 2-2.5 3.6a11 11 0 0 1-3.6 2.6Q2.3 11 0 11q2.3 0 4.3 1 2 .9 3.6 2.5t2.5 3.6"/>
  </g>

  <!-- Worker: DeepSeek -->
  <g id="icon-deepseek">
    <path fill="currentColor" d="M22 6.5c-.2-.1-.3.1-.4.2 0 .1 0 .1-.1.2-.3.3-.6.5-1.1.5-.7-.1-1.3.1-1.8.7-.1-.7-.5-1.1-1.1-1.4-.3-.1-.6-.2-.8-.5-.1-.2-.2-.4-.3-.6-.1-.1-.1-.3-.3-.3-.1 0-.2.2-.3.3-.3.5-.4 1-.4 1.6 0 1.2.5 2.2 1.5 2.8.1.1.1.2.1.3 0 .2-.1.4-.2.6-.1.2-.1.2-.3.2-.6-.2-1.1-.6-1.5-1-.7-.7-1.3-1.4-2.1-2-.2-.1-.4-.2-.6-.3-.8-.8.1-1.4.3-1.5.2-.1.1-.4-.6-.4s-1.4.2-2.2.6c-.1 0-.2.1-.3.1-.8-.1-1.6-.2-2.4-.1-1.5.2-2.7.9-3.6 2.1-1.1 1.5-1.3 3.2-1 5 .3 1.9 1.3 3.4 2.8 4.6 1.5 1.2 3.3 1.8 5.3 1.7 1.2-.1 2.6-.2 4.1-1.5.4.2.8.3 1.5.3.5.1 1 0 1.4-.1.6-.1.6-.7.4-.8-1.8-.8-1.4-.5-1.8-.8.9-1.1 2.2-2.2 2.7-5.8v-.7c0-.1.1-.2.2-.2.4 0 .9-.1 1.3-.3 1.1-.6 1.6-1.6 1.7-2.9 0-.2-.1-.4-.3-.5zM12 18c-1.7-1.3-2.5-1.8-2.9-1.8-.3 0-.3.4-.2.6v.7c.1.2.2.5-.1.7-.5.3-1.5-.1-1.5-.1-1.1-.7-2-1.5-2.6-2.7-.6-1.2-1-2.4-1.1-3.7 0-.3.1-.4.4-.5.4-.1.8-.1 1.2-.1 1.7.3 3.1 1.1 4.3 2.3.7.7 1.2 1.5 1.8 2.3.6.9 1.2 1.7 2 2.4.3.2.5.4.7.6-.6.1-1.6.1-2.3-.7z"/>
  </g>

  <!-- System: Memory -->
  <g id="icon-memory">
    <path fill="currentColor" d="M12 2A10 10 0 1 0 22 12A10 10 0 0 0 12 2zm1 14h-2v-2h2zm0-4h-2V7h2z"/>
  </g>

  <!-- System: Verify -->
  <g id="icon-verify">
    <path fill="currentColor" d="M12 2L4 5v7c0 5.2 3.4 10.1 8 11.3 4.6-1.2 8-6.1 8-11.3V5l-8-3zm-1 15l-4-4 1.4-1.4 2.6 2.6 6.6-6.6 1.4 1.4-8 8z"/>
  </g>

  <!-- System: Approval -->
  <g id="icon-approval">
    <path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zM8 12h8v2H8v-2zm0 4h8v2H8v-2z"/>
  </g>

  <!-- System: Dispatch -->
  <g id="icon-dispatch">
    <circle cx="5" cy="12" r="2.5" fill="currentColor"/>
    <circle cx="19" cy="5" r="2.5" fill="currentColor"/>
    <circle cx="19" cy="12" r="2.5" fill="currentColor"/>
    <circle cx="19" cy="19" r="2.5" fill="currentColor"/>
    <path d="M8 10.5l8-3.5M8 12h8M8 13.5l8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </g>

  <!-- System: Blocked -->
  <g id="icon-blocked">
    <path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8 0-1.8.6-3.5 1.7-4.9L16.9 18.3c-1.4 1.1-3.1 1.7-4.9 1.7zm5.3-3.1L6.7 6.7C8.1 5.6 9.8 5 12 5c4.4 0 8 3.6 8 8 0 1.8-.6 3.5-1.7 4.9z"/>
  </g>

  <!-- System: Task -->
  <g id="icon-task">
    <path fill="currentColor" d="M19 3h-4.2a3 3 0 0 0-5.6 0H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-7 0a1 1 0 1 1-1 1 1 1 0 0 1 1-1zm2 14H8v-2h6zm4-4H8v-2h10z"/>
  </g>

  <!-- System: Packet -->
  <g id="icon-packet">
    <path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5M12 12v10"/>
  </g>
</defs>
`;

// 2. SIMULATION PRESETS CONFIGURATIONS
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
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'working',
				desc: 'Analyzing foreign keys'
			}
		],
		phases: [
			{ name: 'Reading user payload', state: 'done', time: '0.2s' },
			{ name: 'Mapping tables & indexing schemas', state: 'active', time: 'Running' },
			{ name: 'Compiling optimization queries', state: 'pending', time: '--' },
			{ name: 'Waiting for operator override', state: 'pending', time: '--' }
		],
		proofScore: 'Active',
		proofDetail: 'Coordinator verifying index bounds. Graph edges active.'
	},
	'cc-verify': {
		title: 'Handshake Diagnostic',
		prompt: 'Verify secure SSL certificate handshake bindings.',
		systemStatus: 'Sully Coordinator is scanning ports; Verify QA checking SSL handshakes.',
		status: 'checking',
		statusText: 'Checking',
		bannerText: "Next: <span class='banner-highlight'>Submitting validation report</span>",
		bannerIcon: '🔍',
		headerIcon: 'icon-verify',
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
				state: 'checking',
				desc: 'Verifying TLS v1.3 handshake'
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
				state: 'working',
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
	'multi-worker': {
		title: 'Similarity Index Build',
		prompt: 'Process embeddings archive logs context search.',
		systemStatus: 'Sully building similarity matrix referencing Memory module.',
		status: 'working',
		statusText: 'Working',
		bannerText: "Next: <span class='banner-highlight'>Deploying neural similarity matrix</span>",
		bannerIcon: '⚡',
		headerIcon: 'icon-memory',
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
				state: 'working',
				desc: 'Synthesizing similarities'
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
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'blocked',
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

// 3. MOTION GRAPH CONFIGURATIONS & LAYOUT COORDINATES
// Central Task Node is at (170, 65). Workers route towards center.
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

// 4. MAIN STATE & INTERACTIVE CONTROLLERS
let currentPreset = 'cc-only';
let currentState = 'compact';
let confirmApprove = false;
let confirmStop = false;
let animationSpeedFactor = 1;

// Log to virtual console deck
function logTelemetry(msg) {
	const logBox = document.getElementById('telemetryLog');
	if (logBox) {
		const logSpan = document.createElement('span');
		logSpan.innerText = `\n[MOCKUP] ${msg}`;
		logBox.appendChild(logSpan);
		logBox.scrollTop = logBox.scrollHeight;
	}
}

// 5. GRAPH DRAWING ENGINE
function renderGraph(svgId, preset) {
	const svg = document.getElementById(svgId);
	if (!svg) return;

	svg.innerHTML = '';
	svg.insertAdjacentHTML('afterbegin', SVG_DEFS);

	const workers = preset.workers;
	const count = workers.length;
	const layout = WORKER_POSITIONS[count] || WORKER_POSITIONS[4];

	// 1. Draw connecting paths (Edges)
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

		// Edge styling based on state
		let edgeClass = 'edge-line';
		if (preset.status === 'working' && w.state === 'working') {
			edgeClass += ' active';
		}

		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', pathD);
		path.setAttribute('class', edgeClass);
		svg.appendChild(path);

		// 2. Draw Data Packets along path (if animated)
		const togglePackets = document.getElementById('toggleSpeed');
		const packetsEnabled = togglePackets ? togglePackets.checked : true;

		if (packetsEnabled && preset.status === 'working' && w.state === 'working') {
			const packetGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
			packetGroup.setAttribute('class', 'node-icon-wrapper');

			const packetPulse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
			packetPulse.setAttribute('href', '#icon-packet');
			packetPulse.setAttribute('x', '-8');
			packetPulse.setAttribute('y', '-8');
			packetPulse.setAttribute('width', '16');
			packetPulse.setAttribute('height', '16');
			packetPulse.setAttribute('class', 'data-packet animating');

			// CSS motion path animation setup
			packetPulse.style.offsetPath = `path("${pathD}")`;
			packetPulse.style.animation = `dashSlide ${2 / animationSpeedFactor}s linear infinite`;

			packetGroup.appendChild(packetPulse);
			svg.appendChild(packetGroup);
		}
	});

	// 3. Draw Worker Nodes
	workers.forEach((w, idx) => {
		const pos = layout[idx];
		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

		// Pulse ring circle
		const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		circle.setAttribute('cx', pos.x);
		circle.setAttribute('cy', pos.y);
		circle.setAttribute('r', '16');
		circle.setAttribute('class', `node-circle status-${w.state}`);
		g.appendChild(circle);

		// Inlined SVG Icon
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

		// Mini Key text below/above nodes for clarity
		const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		label.setAttribute('x', pos.x);
		label.setAttribute('y', pos.y + 24);
		label.setAttribute('text-anchor', 'middle');
		label.setAttribute('fill', 'var(--sully-text-muted)');
		label.setAttribute('font-size', '8px');
		label.setAttribute('font-weight', 'bold');
		label.textContent = w.key;
		g.appendChild(label);

		svg.appendChild(g);
	});

	// 4. Draw Central Task Node
	const centralG = document.createElementNS('http://www.w3.org/2000/svg', 'g');

	const centralCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
	centralCircle.setAttribute('cx', '170');
	centralCircle.setAttribute('cy', '65');
	centralCircle.setAttribute('r', '20');
	centralCircle.setAttribute('class', `node-circle central-task-node status-${preset.status}`);
	centralG.appendChild(centralCircle);

	// Inlined Central Task Icon
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

// 6. UI UPDATE CONTROLLER
function updateUI() {
	const data = PRESETS[currentPreset];
	const card = document.getElementById('sullyCard');

	// Set card classes for layouts and state mappings
	card.className = `sully-card state-${currentState} status-${data.status}`;

	// Collapsed View values
	document.getElementById('collapsedTitle').innerText = data.title;
	document.getElementById('collapsedMeta').innerText = data.workers.map((w) => w.key).join(' + ');

	// Compact View header
	document.getElementById('compactTaskTitle').innerText = data.title;
	document.getElementById('compactStatusBadge').innerText = data.statusText;
	document.getElementById('compactStatusBadge').className = `status-pill status-${data.status}`;

	// Mini Banner in compact view
	const banner = document.getElementById('compactBanner');
	banner.innerHTML = `<span class="banner-icon">${data.bannerIcon}</span><span class="banner-text">${data.bannerText}</span>`;

	// Dynamic header icons
	const headerIconWrapper = document.getElementById('systemHeaderIcon');
	headerIconWrapper.innerHTML = `<svg><use href="#${data.headerIcon}"/></svg>`;

	const expandedHeaderIconWrapper = document.getElementById('expandedHeaderIcon');
	expandedHeaderIconWrapper.innerHTML = `<svg><use href="#${data.headerIcon}"/></svg>`;

	// Ingest Prompt text into Simulated Screen bubbles
	document.getElementById('userBubble').innerText = data.prompt;
	document.getElementById('systemBubble').innerText = data.systemStatus;

	// Render SVG Graphs (Compact & Expanded are identical mirror layouts)
	renderGraph('graphSvg', data);
	renderGraph('expandedGraphSvg', data);

	// Load checklist phases inside expanded view
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

	// Load Worker registry metrics in expanded view
	const workersGrid = document.getElementById('workersGrid');
	workersGrid.innerHTML = data.workers
		.map(
			(w) => `
    <div class="worker-row ${w.state === 'complete' ? 'complete' : w.state === 'working' ? 'active' : w.state === 'blocked' ? 'blocked' : 'idle'}">
      <div class="worker-left">
        <span class="worker-dot"></span>
        <span class="worker-identity">${w.key} <span class="worker-role">(${w.role})</span></span>
      </div>
      <span class="worker-status">${w.desc}</span>
    </div>
  `
		)
		.join('');

	// Load proof validation score
	const proofContainer = document.getElementById('proofContainer');
	proofContainer.innerHTML = `
    <div class="proof-header">
      <span>QA Cryptographic Proof</span>
      <span class="proof-conf">${data.proofScore}</span>
    </div>
    <p class="proof-log">${data.proofDetail}</p>
  `;

	// Render buttons dynamically in compact and expanded cards
	renderActionButtons(data);
}

// 7. DYNAMIC ACTIONS CONTROLLER
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
		// Render actions row directly visible in compact card for blocked approvals
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

	// Populate actions rows
	if (compactActions.style.display === 'flex') {
		compactActions.innerHTML = buttonHtml;
	}
	expandedActions.innerHTML = buttonHtml;

	// Bind Listeners
	bindActionListeners();
}

function bindActionListeners() {
	// Bind Approve buttons
	const btnApprove = document.querySelectorAll('#btnApprove');
	btnApprove.forEach((btn) => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (!confirmApprove) {
				confirmApprove = true;
				logTelemetry('Destructive action warning displayed. Double-tap required.');
				updateUI();
			} else {
				// Double tapped: Perform transition sweep
				confirmApprove = false;
				logTelemetry('Approval code signed! Triggering completion sequence.');

				// Add sweep animation trigger class to container
				const card = document.getElementById('sullyCard');
				card.classList.add('sweep-active');

				// Transition preset to complete
				setTimeout(() => {
					card.classList.remove('sweep-active');
					currentPreset = 'complete';
					updatePresetsPanelHighlight();
					updateUI();
				}, 850);
			}
		});
	});

	// Bind Stop buttons
	const btnStop = document.querySelectorAll('#btnStop');
	btnStop.forEach((btn) => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (!confirmStop) {
				confirmStop = true;
				logTelemetry('Stop safety confirmation triggered.');
				updateUI();
			} else {
				// Stop pipeline
				confirmStop = false;
				logTelemetry('Execution halted by Operator. Pipeline terminated.');
				currentPreset = 'cc-only';

				// Reset approval warnings
				confirmApprove = false;

				updatePresetsPanelHighlight();
				updateUI();
			}
		});
	});

	// Bind Complete buttons
	const btnComplete = document.querySelectorAll('#btnComplete');
	btnComplete.forEach((btn) => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			logTelemetry('Opening deployment telemetry logs in sandbox.');
			alert('Deployment validation logs loaded. Build success.');
		});
	});
}

// Update highlights in control deck
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

// 8. INTERACTIVE BINDINGS FOR DEMO CONTROLS
document.addEventListener('DOMContentLoaded', () => {
	// Preset switches
	const presetBtns = document.querySelectorAll('#presetControls button');
	presetBtns.forEach((btn) => {
		btn.addEventListener('click', () => {
			currentPreset = btn.getAttribute('data-preset');
			confirmApprove = false;
			confirmStop = false;

			presetBtns.forEach((b) => b.classList.remove('active'));
			btn.classList.add('active');

			logTelemetry(`Switched simulation preset to: ${currentPreset}`);
			updateUI();
		});
	});

	// Layout switches
	const layoutBtns = document.querySelectorAll('#layoutControls button');
	layoutBtns.forEach((btn) => {
		btn.addEventListener('click', () => {
			currentState = btn.getAttribute('data-state');
			layoutBtns.forEach((b) => b.classList.remove('active'));
			btn.classList.add('active');

			logTelemetry(`Changed view display state to: ${currentState}`);
			updateUI();
		});
	});

	// Close button in expanded card
	document.getElementById('closeExpandedBtn').addEventListener('click', (e) => {
		e.stopPropagation();
		currentState = 'compact';

		layoutBtns.forEach((b) => {
			if (b.getAttribute('data-state') === 'compact') b.classList.add('active');
			else b.classList.remove('active');
		});

		logTelemetry('Collapsed expanded card to compact.');
		updateUI();
	});

	// Click on Card body triggers toggle mappings
	document.getElementById('sullyCard').addEventListener('click', (e) => {
		// Avoid double trigger if buttons clicked
		if (e.target.closest('.sully-btn') || e.target.closest('#closeExpandedBtn')) return;

		if (currentState === 'collapsed') {
			currentState = 'compact';
			logTelemetry('Pill clicked. Expanded to compact layout.');
		} else if (currentState === 'compact') {
			// Avoid expanding if clicks on node graphics directly unless intended, but generally body click expands
			currentState = 'expanded';
			logTelemetry('Card body clicked. Opened expanded detailed panel.');
		}

		// Update layout switcher buttons
		layoutBtns.forEach((b) => {
			if (b.getAttribute('data-state') === currentState) b.classList.add('active');
			else b.classList.remove('active');
		});

		updateUI();
	});

	// Packet animation toggle control
	document.getElementById('toggleSpeed').addEventListener('change', (e) => {
		logTelemetry(`Packet animations ${e.target.checked ? 'Enabled' : 'Disabled'}`);
		updateUI();
	});

	// Initial Draw
	updateUI();
});
