/* ==========================================================================
   SULLY WORK SURFACE - REAL ASSETS V3 ENGINE
   ========================================================================== */

// 1. SIMULATION PRESETS
// motionTypes: researching, building, verifying, blocked, complete
const PRESETS = {
  'cc-researching': {
    title: "CC Schema Analysis",
    prompt: "Assess database migrations index layout.",
    systemStatus: "Sully has dispatched Claude Code to analyze database indexes.",
    status: "working",
    statusText: "Researching",
    bannerText: "Next: <span class='banner-highlight'>Optimizing database lookup speed</span>",
    bannerIcon: "🔍",
    headerIcon: "icon-dispatch",
    activeOwnershipLabel: "Claude researching database indexes",
    activeMotionType: "researching",
    workers: [
      { key: "CC", icon: "icon-claude", role: "Claude Code", motionType: "researching", desc: "Researching index tables" }
    ],
    phases: [
      { name: "Reading user payload", state: "done", time: "0.2s" },
      { name: "Mapping tables & indexing schemas", state: "active", time: "Running" },
      { name: "Compiling optimization queries", state: "pending", time: "--" }
    ],
    proofScore: "Active",
    proofDetail: "Claude scanning database model mappings. Edge routing active."
  },
  'agy-building': {
    title: "Deck Handler Refinements",
    prompt: "Apply mobile-first drag handling routines.",
    systemStatus: "Antigravity writing gesture code; QA suite checks queued.",
    status: "working",
    statusText: "Building",
    bannerText: "Next: <span class='banner-highlight'>Running gesture telemetry scripts</span>",
    bannerIcon: "⚡",
    headerIcon: "icon-antigravity",
    activeOwnershipLabel: "Antigravity building touch gesture handlers",
    activeMotionType: "building",
    workers: [
      { key: "AGY", icon: "icon-antigravity", role: "Antigravity Agent", motionType: "building", desc: "Writing drag handlers" }
    ],
    phases: [
      { name: "Ingesting touch specifications", state: "done", time: "0.1s" },
      { name: "Injecting drag logic modules", state: "active", time: "Writing" },
      { name: "Verifying coordinate boundary limits", state: "pending", time: "--" }
    ],
    proofScore: "Queued",
    proofDetail: "Gesture test blocks built. Awaiting Touch Handlers compilation."
  },
  'dpsk-verifying': {
    title: "Sully is checking schema logic",
    prompt: "Verify database constraints and triggers.",
    systemStatus: "DeepSeek active verifying constraints logic; QA queued.",
    status: "checking",
    statusText: "Checking",
    bannerText: "Next: <span class='banner-highlight'>Reviewing logic constraint rules</span>",
    bannerIcon: "🔍",
    headerIcon: "icon-verify",
    activeOwnershipLabel: "DeepSeek verifying schema constraints logic",
    activeMotionType: "verifying",
    workers: [
      { key: "DPSK", icon: "icon-deepseek", role: "DeepSeek", motionType: "verifying", desc: "Verifying trigger constraints" }
    ],
    phases: [
      { name: "Mapping model keys", state: "done", time: "0.3s" },
      { name: "Evaluating check triggers", state: "active", time: "Verifying" },
      { name: "Running integration validation", state: "pending", time: "--" }
    ],
    proofScore: "Active",
    proofDetail: "DeepSeek scanning database model mappings. 12 triggers validated."
  },
  'gemini-brainstorming': {
    title: "Context Log Synthesis",
    prompt: "Gather historical error logs and synthesize search context.",
    systemStatus: "Gemini brainstorming context mappings in memory logs.",
    status: "working",
    statusText: "Brainstorming",
    bannerText: "Next: <span class='banner-highlight'>Compiling vector search space</span>",
    bannerIcon: "🧠",
    headerIcon: "icon-memory",
    activeOwnershipLabel: "Gemini brainstorming context log vectors",
    activeMotionType: "researching",
    workers: [
      { key: "GEM", icon: "icon-gemini", role: "Gemini", motionType: "researching", desc: "Synthesizing log similarities" }
    ],
    phases: [
      { name: "Reading log history archive", state: "done", time: "0.4s" },
      { name: "Clustering semantic error groups", state: "active", time: "Mapping" },
      { name: "Exporting search vector indices", state: "pending", time: "--" }
    ],
    proofScore: "Active",
    proofDetail: "Gemini scanning memory buffers. Mapping cluster nodes."
  },
  'codex-reviewing': {
    title: "Codebase Restructuring Audit",
    prompt: "Review files hierarchy structure against best practices.",
    systemStatus: "Codex audit running in staging area; structural integrity scan.",
    status: "checking",
    statusText: "Reviewing",
    bannerText: "Next: <span class='banner-highlight'>Submitting file recommendations</span>",
    bannerIcon: "🔍",
    headerIcon: "icon-verify",
    activeOwnershipLabel: "Codex reviewing folder structures",
    activeMotionType: "verifying",
    workers: [
      { key: "COD", icon: "icon-codex", role: "Codex", motionType: "verifying", desc: "Auditing folder pathways" }
    ],
    phases: [
      { name: "Verifying staging structures", state: "done", time: "0.2s" },
      { name: "Validating name mappings", state: "active", time: "Auditing" },
      { name: "Generating folder layout summary", state: "pending", time: "--" }
    ],
    proofScore: "94% Confidence",
    proofDetail: "Codex auditing relative routes. Layout syntax checked."
  },
  'multi-worker': {
    title: "Coordinated Staging Build",
    prompt: "Assemble, scan, and verify touch gesture code suite.",
    systemStatus: "Antigravity compiling drag code, Claude researching schemas, Codex checking files.",
    status: "working",
    statusText: "Coordinated",
    bannerText: "Next: <span class='banner-highlight'>Deploying QA test environment</span>",
    bannerIcon: "⚙️",
    headerIcon: "icon-packet",
    activeOwnershipLabel: "CC, AGY & Codex concurrently executing",
    activeMotionType: "building",
    workers: [
      { key: "CC", icon: "icon-claude", role: "Claude Code", motionType: "researching", desc: "Indexing schemas" },
      { key: "AGY", icon: "icon-antigravity", role: "Antigravity Agent", motionType: "building", desc: "Compiling code block" },
      { key: "COD", icon: "icon-codex", role: "Codex", motionType: "verifying", desc: "Validating layout rules" }
    ],
    phases: [
      { name: "Staging database schemas", state: "done", time: "0.3s" },
      { name: "Synthesizing gesture assets", state: "active", time: "Compiling" },
      { name: "Auditing relative structures", state: "pending", time: "--" }
    ],
    proofScore: "Coordinated",
    proofDetail: "Three active sub-agents running concurrently. Latency: 42ms."
  },
  'waiting-approval': {
    title: "Safety Shield Intercepted",
    prompt: "Delete production database backup logs.",
    systemStatus: "Sully has paused work. Operator override signature required.",
    status: "blocked",
    statusText: "Awaiting Action",
    bannerText: "Operator verification required to execute folder deletion.",
    bannerIcon: "⚠️",
    headerIcon: "icon-approval",
    activeOwnershipLabel: "Halted - waiting for operator signature",
    activeMotionType: "blocked",
    workers: [
      { key: "AGY", icon: "icon-antigravity", role: "Antigravity Agent", motionType: "blocked", desc: "Halted at safe Gate" }
    ],
    phases: [
      { name: "Scanning backup indices", state: "done", time: "0.2s" },
      { name: "Checking folder access permissions", state: "done", time: "0.4s" },
      { name: "Awaiting manual operator signature", state: "active", time: "Halted" }
    ],
    proofScore: "Override Req.",
    proofDetail: "Action matches protected rule: DELETE PRODUCTION LOGS. Manual approval required."
  },
  'complete': {
    title: "Pipeline Executed Successfully",
    prompt: "Deploy sandbox gateway hotfix v1.4.3.",
    systemStatus: "Hotfix deployment complete. Verification runs successful.",
    status: "complete",
    statusText: "Complete",
    bannerText: "Execution successful. Staging workspace settled.",
    bannerIcon: "✓",
    headerIcon: "icon-task",
    activeOwnershipLabel: "Settled - execution successful",
    activeMotionType: "complete",
    workers: [
      { key: "CC", icon: "icon-claude", role: "Claude Code", motionType: "complete", desc: "Successful" },
      { key: "AGY", icon: "icon-antigravity", role: "complete", desc: "Successful" }
    ],
    phases: [
      { name: "Reading deployment schema", state: "done", time: "0.1s" },
      { name: "Spawning gateway containers", state: "done", time: "0.8s" },
      { name: "Running socket handshake QA checks", state: "done", time: "1.2s" },
      { name: "Compiling response package", state: "done", time: "0.2s" }
    ],
    proofScore: "100% Success",
    proofDetail: "All testing suites compiled and executed successfully. Clean exit."
  }
};

// 2. DYNAMIC COORDINATE GENERATOR (Based on Active Worker Count)
function getWorkerPositions(count) {
  if (count === 1) {
    return [{ x: 60, y: 65 }];
  } else if (count === 2) {
    return [
      { x: 60, y: 35 }, 
      { x: 60, y: 95 }
    ];
  } else if (count === 3) {
    return [
      { x: 60, y: 30 }, 
      { x: 60, y: 100 }, 
      { x: 280, y: 65 }
    ];
  } else if (count === 4) {
    return [
      { x: 60, y: 30 }, 
      { x: 60, y: 100 }, 
      { x: 280, y: 30 }, 
      { x: 280, y: 100 }
    ];
  } else if (count >= 5) {
    return [
      { x: 60, y: 30 },
      { x: 60, y: 65 },
      { x: 60, y: 100 },
      { x: 280, y: 45 },
      { x: 280, y: 85 }
    ];
  }
  return [];
}

// State trackers
let currentPreset = 'cc-researching';
let currentState = 'compact';
let confirmApprove = false;
let confirmStop = false;
let currentIntensity = 'normal';

function logTelemetry(msg) {
  const logBox = document.getElementById('telemetryLog');
  if (logBox) {
    const logSpan = document.createElement('span');
    logSpan.innerHTML = `<br>[INT:${currentIntensity.toUpperCase()}] ${msg}`;
    logBox.appendChild(logSpan);
    logBox.scrollTop = logBox.scrollHeight;
  }
}

// 3. DYNAMIC GRAPH RENDERING ENGINE
function renderGraph(svgId, preset) {
  const svg = document.getElementById(svgId);
  if (!svg) return;

  // Clear existing items (retains global defs since they are in HTML body)
  svg.innerHTML = '';

  // Filter: ONLY show active workers in the graph (motionType != complete, waiting)
  // We keep 'blocked' in the graph so the user sees the safety intercept.
  const activeWorkers = preset.workers.filter(w => w.motionType !== 'complete' && w.motionType !== 'waiting');
  const count = activeWorkers.length;
  const layout = getWorkerPositions(count);

  const targetX = 170;
  const targetY = 65;

  const isMonochrome = document.getElementById('toggleMonochrome')?.checked;
  const isResearchingPreset = preset.activeMotionType === 'researching';
  const isVerifyingPreset = preset.activeMotionType === 'verifying';

  // Build the list of paths/routes to draw
  const routes = [];

  // Add active worker routes
  activeWorkers.forEach((w, idx) => {
    const pos = layout[idx];
    if (!pos) return;
    routes.push({
      id: `worker-${w.key}`,
      startX: pos.x,
      startY: pos.y,
      endX: targetX,
      endY: targetY,
      motionType: w.motionType,
      isPrimary: (count === 1) || (w.motionType === preset.activeMotionType),
      isWorker: true,
      icon: w.icon,
      key: w.key,
      role: w.role,
      desc: w.desc
    });
  });

  // For single-worker layouts, enrich the graph with helper system nodes
  if (count === 1) {
    if (isResearchingPreset) {
      // Add a Memory (Context) node on the right
      routes.push({
        id: 'system-memory',
        startX: 280,
        startY: 65,
        endX: targetX,
        endY: targetY,
        motionType: 'researching',
        isPrimary: true,
        isWorker: false,
        icon: 'icon-memory',
        key: 'MEMORY',
        role: 'System context',
        desc: 'Memory buffer'
      });
      // Add an outside edge input path from the bottom right to task
      routes.push({
        id: 'system-edge',
        startX: 340,
        startY: 105,
        endX: targetX,
        endY: targetY,
        motionType: 'researching',
        isPrimary: false,
        isWorker: false,
        isEdge: true
      });
    } else if (isVerifyingPreset) {
      // Add a Verify (Inspection) node on the right
      routes.push({
        id: 'system-verify',
        startX: 280,
        startY: 65,
        endX: targetX,
        endY: targetY,
        motionType: 'verifying',
        isPrimary: true,
        isWorker: false,
        icon: 'icon-verify',
        key: 'VERIFY',
        role: 'Inspection engine',
        desc: 'Validation gate'
      });
    }
  }

  // 1. Draw Paths & Routing lines first
  routes.forEach((route) => {
    let pathD;
    if (route.startY === targetY) {
      pathD = `M ${route.startX} ${route.startY} L ${route.endX} ${route.endY}`;
    } else {
      const ctrlX = (route.startX + route.endX) / 2;
      const ctrlY = route.startY < route.endY ? route.startY - 10 : route.startY + 10;
      pathD = `M ${route.startX} ${route.startY} Q ${ctrlX} ${ctrlY} ${route.endX} ${route.endY}`;
    }

    const priorityClass = route.isPrimary ? 'primary-active' : 'secondary-active';

    // Static Base Edge Path
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathD);
    path.setAttribute("class", `edge-line route-${route.motionType} ${priorityClass}`);
    svg.appendChild(path);

    // Scanner Sweep overlay path (Only for active flows)
    if (route.motionType === 'researching' || route.motionType === 'building' || route.motionType === 'verifying') {
      const sweepPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      sweepPath.setAttribute("d", pathD);
      sweepPath.setAttribute("class", `edge-sweep-line route-${route.motionType}-sweep ${priorityClass}`);
      svg.appendChild(sweepPath);
    }

    // 2. Draw Semantic Payload Packets along active routes
    if (route.motionType === 'researching' || route.motionType === 'building' || route.motionType === 'verifying') {
      const isVerifying = route.motionType === 'verifying';
      const numPackets = isVerifying ? 1 : (route.isPrimary ? 3 : 2); 

      for (let i = 0; i < numPackets; i++) {
        const packetGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
        packetGroup.setAttribute("class", "node-icon-wrapper");
        
        const packetUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
        packetUse.setAttribute("href", `#payload-${route.motionType}`);
        
        // Define clean bounds
        const size = 20;
        packetUse.setAttribute("width", size);
        packetUse.setAttribute("height", size);
        packetUse.setAttribute("x", -size / 2);
        packetUse.setAttribute("y", -size / 2);
        packetUse.setAttribute("class", `data-packet packet-${route.motionType} ${priorityClass}`);
        
        // Apply motion profiles
        packetUse.style.offsetPath = `path("${pathD}")`;
        
        // Scale speed for secondary background workers
        const speedMult = route.isPrimary ? 1.0 : 1.4;
        
        if (route.motionType === 'researching') {
          // Researching = slower, context gathering (exploratory)
          packetUse.style.animation = `glidePacketResearching ${6.0 * speedMult}s ease-in-out infinite`;
          packetUse.style.animationDelay = `${i * 2.5}s`;
        } else if (route.motionType === 'building') {
          // Building = steady batch output stream (rhythmic construction)
          packetUse.style.animation = `glidePacketBuilding ${3.5 * speedMult}s cubic-bezier(0.25, 0.8, 0.25, 1) infinite`;
          packetUse.style.animationDelay = `${i * 0.4}s`;
        } else if (route.motionType === 'verifying') {
          // Verifying = task <-> verifier loop with inspection orbit near verifier
          packetUse.style.animation = `glidePacketVerifying ${4.0 * speedMult}s ease-in-out infinite`;
        }
        
        packetGroup.appendChild(packetUse);
        svg.appendChild(packetGroup);
      }
    }
  });

  // 3. Draw Worker Nodes & Added System Nodes
  // Draw Workers first
  activeWorkers.forEach((w, idx) => {
    const pos = layout[idx];
    if (!pos) return;

    const isPrimary = (count === 1) || (w.motionType === preset.activeMotionType);
    const priorityClass = isPrimary ? 'primary-active' : 'secondary-active';

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", `node-group-animated stagger-${(idx % 4) + 1} ${priorityClass}`);

    // Orbital Ring rotating around active workers
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ring.setAttribute("cx", pos.x);
    ring.setAttribute("cy", pos.y);
    ring.setAttribute("r", "23");
    ring.setAttribute("class", `orbital-ring ring-${w.motionType} ${priorityClass}`);
    g.appendChild(ring);

    // Worker Outer Ring (Breaths slightly based on motionType class)
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", pos.x);
    circle.setAttribute("cy", pos.y);
    circle.setAttribute("r", "17");
    
    const breathDelayClass = (idx % 2 === 0) ? "breath-delay-1" : "breath-delay-2";
    circle.setAttribute("class", `node-circle node-${w.motionType} ${breathDelayClass} ${priorityClass}`);
    g.appendChild(circle);

    // Primary Worker Icon selection
    let iconId = w.icon;
    if (isMonochrome && iconId === 'icon-antigravity') {
      iconId = 'icon-antigravity-mono';
    }

    const iconG = document.createElementNS("http://www.w3.org/2000/svg", "g");
    iconG.setAttribute("class", "node-icon-wrapper");
    
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${iconId}`);
    use.setAttribute("x", pos.x - 11);
    use.setAttribute("y", pos.y - 11);
    use.setAttribute("width", "22");
    use.setAttribute("height", "22");
    iconG.appendChild(use);
    g.appendChild(iconG);

    // Secondary Text Label
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", pos.x);
    label.setAttribute("y", pos.y + 26);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", "var(--sully-text-muted)");
    label.setAttribute("font-size", "7.5px");
    label.setAttribute("font-weight", "600");
    label.setAttribute("letter-spacing", "0.5px");
    label.setAttribute("opacity", "0.75");
    label.textContent = w.key;
    g.appendChild(label);

    svg.appendChild(g);
  });

  // Draw added System Nodes
  routes.forEach((route) => {
    if (route.isWorker || route.isEdge) return;

    const pos = { x: route.startX, y: route.startY };
    const priorityClass = 'primary-active';

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", `node-group-animated stagger-3 ${priorityClass}`);

    // Orbital Ring
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ring.setAttribute("cx", pos.x);
    ring.setAttribute("cy", pos.y);
    ring.setAttribute("r", "23");
    ring.setAttribute("class", `orbital-ring ring-${route.motionType} ${priorityClass}`);
    g.appendChild(ring);

    // Node Outer Ring
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", pos.x);
    circle.setAttribute("cy", pos.y);
    circle.setAttribute("r", "17");
    circle.setAttribute("class", `node-circle node-${route.motionType} breath-delay-1 ${priorityClass}`);
    g.appendChild(circle);

    // Icon
    const iconG = document.createElementNS("http://www.w3.org/2000/svg", "g");
    iconG.setAttribute("class", "node-icon-wrapper");
    
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${route.icon}`);
    use.setAttribute("x", pos.x - 11);
    use.setAttribute("y", pos.y - 11);
    use.setAttribute("width", "22");
    use.setAttribute("height", "22");
    iconG.appendChild(use);
    g.appendChild(iconG);

    // Text Label
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", pos.x);
    label.setAttribute("y", pos.y + 26);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", "var(--sully-text-muted)");
    label.setAttribute("font-size", "7.5px");
    label.setAttribute("font-weight", "600");
    label.setAttribute("letter-spacing", "0.5px");
    label.setAttribute("opacity", "0.75");
    label.textContent = route.key;
    g.appendChild(label);

    svg.appendChild(g);
  });

  // 4. Central Task Node
  const centralG = document.createElementNS("http://www.w3.org/2000/svg", "g");
  centralG.setAttribute("class", "node-group-animated CentralTask");
  
  // Central Task core breathing glow (pulses color-coded to active motion)
  const taskCore = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  taskCore.setAttribute("cx", targetX);
  taskCore.setAttribute("cy", targetY);
  taskCore.setAttribute("r", "14");
  taskCore.setAttribute("class", `task-core-pulse core-${preset.activeMotionType}`);
  centralG.appendChild(taskCore);

  // Central Task landing handoff ripple (releases wave ripple as packets arrive)
  const taskRipple = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  taskRipple.setAttribute("cx", targetX);
  taskRipple.setAttribute("cy", targetY);
  taskRipple.setAttribute("r", "20");
  taskRipple.setAttribute("class", `task-ripple ripple-${preset.activeMotionType}`);
  centralG.appendChild(taskRipple);

  const centralCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  centralCircle.setAttribute("cx", targetX);
  centralCircle.setAttribute("cy", targetY);
  centralCircle.setAttribute("r", "20"); // 40px diameter
  
  let taskStatusClass = "status-working";
  if (preset.activeMotionType === 'complete') taskStatusClass = "status-complete";
  else if (preset.activeMotionType === 'blocked') taskStatusClass = "status-blocked";
  
  centralCircle.setAttribute("class", `node-circle central-task-node ${taskStatusClass}`);
  centralG.appendChild(centralCircle);

  // Task Icon (Clipboard)
  const centralIconUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
  centralIconUse.setAttribute("href", "#icon-task");
  centralIconUse.setAttribute("x", targetX - 11);
  centralIconUse.setAttribute("y", targetY - 11);
  centralIconUse.setAttribute("width", "22");
  centralIconUse.setAttribute("height", "22");
  centralG.appendChild(centralIconUse);

  // Central TASK Label
  const centralLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  centralLabel.setAttribute("x", targetX);
  centralLabel.setAttribute("y", targetY + 29);
  centralLabel.setAttribute("text-anchor", "middle");
  centralLabel.setAttribute("fill", "#fff");
  centralLabel.setAttribute("font-size", "8px");
  centralLabel.setAttribute("font-weight", "700");
  centralLabel.setAttribute("letter-spacing", "0.5px");
  centralLabel.textContent = "TASK";
  centralG.appendChild(centralLabel);

  svg.appendChild(centralG);
}

// 5. MAIN UI UPDATER
function updateUI() {
  const data = PRESETS[currentPreset];
  const card = document.getElementById('sullyCard');

  // Set card classes for collapsing and overall status
  card.className = `sully-card state-${currentState} status-${data.status}`;

  // Check monochrome state
  const isMonochrome = document.getElementById('toggleMonochrome')?.checked;
  if (isMonochrome) {
    card.classList.add('monochrome-graph');
  } else {
    card.classList.remove('monochrome-graph');
  }

  // Collapsed details
  document.getElementById('collapsedTitle').innerText = data.title;
  document.getElementById('collapsedMeta').innerText = data.workers.map(w => w.key).join(' + ');

  // Compact details
  document.getElementById('compactTaskTitle').innerText = data.title;
  document.getElementById('compactStatusBadge').innerText = data.statusText;
  document.getElementById('compactStatusBadge').className = `status-pill status-${data.status}`;

  const banner = document.getElementById('compactBanner');
  banner.innerHTML = `<span class="banner-icon">${data.bannerIcon}</span><span class="banner-text">${data.bannerText}</span>`;

  // Header System Badges
  const headerIconWrapper = document.getElementById('systemHeaderIcon');
  headerIconWrapper.innerHTML = `<svg class="system-svg-asset"><use href="#${data.headerIcon}"/></svg>`;

  const expandedHeaderIconWrapper = document.getElementById('expandedHeaderIcon');
  expandedHeaderIconWrapper.innerHTML = `<svg class="system-svg-asset"><use href="#${data.headerIcon}"/></svg>`;

  // Chat conversation emulation
  document.getElementById('userBubble').innerText = data.prompt;
  document.getElementById('systemBubble').innerText = data.systemStatus;

  // Render both viewports (compact & expanded details)
  renderGraph('graphSvg', data);
  renderGraph('expandedGraphSvg', data);

  // Active Ownership labels
  const compactOwnershipLabel = document.getElementById('compactOwnershipLabel');
  const expandedOwnershipLabel = document.getElementById('expandedOwnershipLabel');

  compactOwnershipLabel.className = `active-ownership-banner ${data.activeMotionType}`;
  expandedOwnershipLabel.className = `active-ownership-banner ${data.activeMotionType}`;

  const labelContent = `Now: ${data.activeOwnershipLabel}`;
  compactOwnershipLabel.querySelector('.ownership-text').innerText = labelContent;
  expandedOwnershipLabel.querySelector('.ownership-text').innerText = labelContent;

  // Phases Checklist (Expanded view)
  const checklist = document.getElementById('phasesChecklist');
  checklist.innerHTML = data.phases.map(p => `
    <div class="phase-row ${p.state}">
      <div class="phase-left">
        <span class="phase-dot"></span>
        <span>${p.name}</span>
      </div>
      <span class="phase-time">${p.time}</span>
    </div>
  `).join('');

  // Worker Registry grid (Expanded view)
  const workersGrid = document.getElementById('workersGrid');
  workersGrid.innerHTML = data.workers.map(w => {
    let rowClass = "worker-row";
    let badgeHtml = '';

    if (w.motionType === 'researching') {
      rowClass += " row-active-highlight-researching";
      badgeHtml = `<span class="worker-badge-pill badge-researching">Researching</span>`;
    } else if (w.motionType === 'building') {
      rowClass += " row-active-highlight-building";
      badgeHtml = `<span class="worker-badge-pill badge-building">Building</span>`;
    } else if (w.motionType === 'verifying') {
      rowClass += " row-active-highlight-verifying";
      badgeHtml = `<span class="worker-badge-pill badge-verifying">Verifying</span>`;
    } else if (w.motionType === 'blocked') {
      rowClass += " row-active-highlight-blocked";
      badgeHtml = `<span class="worker-badge-pill badge-blocked">Blocked</span>`;
    } else if (w.motionType === 'complete') {
      rowClass += " complete";
      badgeHtml = `<span class="worker-badge-pill badge-done">Done</span>`;
    } else {
      rowClass += " idle";
      badgeHtml = `<span class="worker-badge-pill badge-waiting">Waiting</span>`;
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
  }).join('');

  // QA proof scores (Expanded view)
  const proofContainer = document.getElementById('proofContainer');
  proofContainer.innerHTML = `
    <div class="proof-header">
      <span>QA Cryptographic Verification</span>
      <span class="proof-conf">${data.proofScore}</span>
    </div>
    <p class="proof-log">${data.proofDetail}</p>
  `;

  renderActionButtons(data);
}

// 6. DOUBLE-TAP APPROVAL & ACTION CONTROLS
function renderActionButtons(data) {
  const compactActions = document.getElementById('compactActions');
  const expandedActions = document.getElementById('expandedActions');

  let buttonHtml = '';

  if (data.activeMotionType === 'blocked') {
    buttonHtml = `
      <button class="sully-btn btn-secondary" id="btnStop">
        ${confirmStop ? "Confirm stopping?" : "Stop Task"}
      </button>
      <button class="sully-btn ${confirmApprove ? 'btn-danger-confirm' : 'btn-approve'}" id="btnApprove">
        ${confirmApprove ? "Confirm deletion?" : "Approve Override"}
      </button>
    `;
    compactActions.style.display = 'flex';
  } else if (data.status === 'working' || data.status === 'checking') {
    buttonHtml = `
      <button class="sully-btn ${confirmStop ? 'btn-stop-confirm' : 'btn-secondary'}" id="btnStop" style="width: 100%;">
        ${confirmStop ? "Confirm stopping active task?" : "Stop Pipeline"}
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
  btnApprove.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirmApprove) {
        confirmApprove = true;
        logTelemetry("Override intercept armed. Double-tap to execute.");
        updateUI();
      } else {
        confirmApprove = false;
        logTelemetry("Signed approval signature. Triggering sweep...");
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
  btnStop.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirmStop) {
        confirmStop = true;
        logTelemetry("Stop pipeline request armed. Double-tap to verify.");
        updateUI();
      } else {
        confirmStop = false;
        logTelemetry("Safety stop executed. Reverting pipeline.");
        currentPreset = 'cc-researching';
        confirmApprove = false;
        updatePresetsPanelHighlight();
        updateUI();
      }
    });
  });

  const btnComplete = document.querySelectorAll('#btnComplete');
  btnComplete.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      logTelemetry("Fetched staging deployment logs: Sandbox healthy.");
      alert("Deployment validation log successfully fetched. Status: 200 OK");
    });
  });
}

function updatePresetsPanelHighlight() {
  const btns = document.querySelectorAll('#presetControls button');
  btns.forEach(btn => {
    if (btn.getAttribute('data-preset') === currentPreset) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// 7. DOM LISTENERS & INITIALIZATION
document.addEventListener('DOMContentLoaded', () => {
  const presetBtns = document.querySelectorAll('#presetControls button');
  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      currentPreset = btn.getAttribute('data-preset');
      confirmApprove = false;
      confirmStop = false;
      
      presetBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      logTelemetry(`Preset updated: ${currentPreset}`);
      
      if (currentPreset === 'complete') {
        // Run one clean completion sweep transition, then settle
        const card = document.getElementById('sullyCard');
        card.classList.add('sweep-active');
        setTimeout(() => {
          card.classList.remove('sweep-active');
          updateUI();
        }, 1200);
      } else {
        updateUI();
      }
    });
  });

  const layoutBtns = document.querySelectorAll('#layoutControls button');
  layoutBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      currentState = btn.getAttribute('data-state');
      layoutBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      logTelemetry(`Display state: ${currentState}`);
      updateUI();
    });
  });

  // Monochrome switch listener
  const toggleMono = document.getElementById('toggleMonochrome');
  if (toggleMono) {
    toggleMono.addEventListener('change', (e) => {
      logTelemetry(`Monochrome Graph icons set to: ${e.target.checked}`);
      updateUI();
    });
  }

  document.getElementById('closeExpandedBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    currentState = 'compact';
    
    layoutBtns.forEach(b => {
      if (b.getAttribute('data-state') === 'compact') b.classList.add('active');
      else b.classList.remove('active');
    });
    
    logTelemetry("Surface collapsed to compact card.");
    updateUI();
  });

  document.getElementById('sullyCard').addEventListener('click', (e) => {
    if (e.target.closest('.sully-btn') || e.target.closest('#closeExpandedBtn')) return;

    if (currentState === 'collapsed') {
      currentState = 'compact';
      logTelemetry("Pill expanded to compact card.");
    } else if (currentState === 'compact') {
      currentState = 'expanded';
      logTelemetry("Compact card unfolded to expanded view.");
    }
    
    layoutBtns.forEach(b => {
      if (b.getAttribute('data-state') === currentState) b.classList.add('active');
      else b.classList.remove('active');
    });

    updateUI();
  });

  // Motion Intensity Toggle
  const intensityRadios = document.querySelectorAll('input[name="intensity"]');
  intensityRadios.forEach(radio => {
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
