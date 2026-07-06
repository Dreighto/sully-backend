# Sully Work Surface - Final Mockup & Animation Staging Package

This directory hosts the finalized **Version 3 (Active Ownership)** mockup of the Sully Work Surface component along with staged reusable CSS keyframe modules and JS telemetry presets.

---

## 🚀 How to Preview the Final Mockup

1. Open the [index.html](index.html) file inside this folder directly in any local web browser.
2. The page loads with a split screen:
   - **Left**: Control Room Panel (toggle states, presets, check animations).
   - **Right**: Simulated Mobile Viewport running the live component card inside a chat feed simulation.
3. Test buttons to trigger preset transitions, double-tap safety overrides, speed controls, and layout states (collapsed pill, compact, and expanded panels).

---

## 📁 Staged Integration Assets

### 1. Reusable CSS Animation Modules (Located in `/review_queue/css/`)

These files contain clean, production-ready style rules that can be loaded directly into your main stylesheet bundle:

- **[sully-node-breathing.css](../../css/sully-node-breathing.css)**: Implements slow, material-based breathing pulses (`activeBreathWorking`, `activeBreathChecking`, `activeBreathBlocked`) and staggered delayed floats (`.node-group-animated`).
- **[sully-packet-flow.css](../../css/sully-packet-flow.css)**: Implements glowing active routes and gliding data packets using standard cubic-bezier SVG offset-path motions.
- **[sully-completion-sweep.css](../../css/sully-completion-sweep.css)**: Implements soft radial confirmation sweeps and shine transitions settling across card nodes.
- **[sully-ownership-banner.css](../../css/sully-ownership-banner.css)**: Implements indicators, glanceable active labels, and highlighted worker registry rows with custom badge status pills.
- **[sully-approval-controls.css](../../css/sully-approval-controls.css)**: Sets up standard buttons and pulsing warning scales for double-tap safety actions.

### 2. Reusable JS Telemetry Presets (Located in `/review_queue/js/`)

- **[sully-work-surface-presets.example.js](../../js/sully-work-surface-presets.example.js)**: Contains structured reference presets tracking agent data streams, checklist steps, worker roles, and active state keys.

### 3. SVG Assets (Located in `/review_queue/svg/`)

- Exact copies of all worker and system icons (e.g., `gemini.svg`, `antigravity.svg`, `verify.svg`, `blocked.svg`, etc.) are structured here for manual asset mapping.

### 4. Mockup (Demo-Only Files in this Directory)

- `index.html`: HTML layout showing demo controls, notched iPhone container, and mock chat feed.
- `css/styles.css`: CSS tying the layout wrappers and preview dashboard elements.
- `js/main.js`: JS mock state switcher, inlined SVG definitions, and click triggers.

---

## 🔍 How Core Concepts Work

### Active Ownership Focus

To make it visually obvious which agent is running a task without cluttering the UI:

- **Breathing Nodes**: Only the active worker node circle (`.active-worker`, `.active-worker-checking`, etc.) scales and glows. Idle or waiting nodes remain static.
- **Highlighted Rows**: In the expanded details panel, the row mapping the active worker gets high-contrast text and a `.row-active-highlight` blue-backed outline with a `Now working` badge.

### Packet Flow & Active Routes

- Connecting lines from the active worker to the task node are given the `.active-route` class, which makes them glow.
- Staggered glide packets (`.data-packet.animating`) run _only_ along paths that belong to this active route. Packets are completely hidden on completed or idle worker paths.

### Worker Icons Mapping

- Icons are drawn directly inside the SVG node groups using standard `<use href="#icon-[name]" />` referencing. This maps directly to the standalone vector files under `svg_assets/` (e.g. `<use href="#icon-deepseek" />` renders `deepseek.svg`).

---

## ⚠️ What CC (Captain) Should Review Before Integration

1. **Glanceable Active Labels**: Verify if the active banner `"Now: DPSK verifying schema constraints"` provides instant context.
2. **Breathing Scale & Glow Limits**: Check the active node's 1.06 scale pulse. Ensure it is visible yet calm.
3. **Double-Tap Confirmations**: Review the red double-tap warning style and the green sweep glow upon approval.
4. **Transition Durations**: Confirm that the unfold height animation matches the transition speeds of the app wrapper.
