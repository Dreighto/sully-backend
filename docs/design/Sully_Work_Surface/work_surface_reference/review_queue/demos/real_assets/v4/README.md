# Sully Work Surface - Real Assets v4 (2.0 Visual Treatment)

This directory contains the fourth iteration of the production-staging preview (`real_assets/v4`), organized according to the refactored project structure.

It is designed to feel like a small, premium, futuristic OS-assistant console operating inside the chat—alive, responsive, and aesthetically stunning without feeling like a sci-fi toy HUD.

## Key 2.0 Visual Upgrades

1. **Clean HUD Glass Depth**:
   - The card features tailored glassmorphism (`backdrop-filter: blur(25px)`), subtle inner glows (`inset 0 1px 0 rgba(255, 255, 255, 0.08)`), and deliberate card borders.
   - Spacing has been improved inside the compact and expanded views for a cleaner, modern iOS-assistant aesthetic.
   - Outfit typography is loaded and applied across all textual hierarchies.

2. **Graph Core Field & Routing Lanes**:
   - A subtle concentric coordinate "core field" rotates and breathes behind the central `TASK` node, making it feel like the system's central core.
   - Active routes are rendered as "dual-lane tracks" (a wider backing line + a thin inner glow path), presenting routes as lanes rather than generic lines.
   - Clear visual prioritization: The primary active worker is highlighted with full-glow routes and nodes, while secondary worker routes are dimmed (`opacity: 0.08` for paths, `opacity: 0.15` for packets) to keep the layout organized and legible.

3. **High-Fidelity Micro-Animations**:
   - **Soft Sonar Wake**: Triggered upon clicking presets or switching display layout states, sending a radial wake ring out from the center.
   - **Synched Collision Ripples**: The central `TASK` node fires ripples synchronized precisely to payload arrival timestamps (packets land at `50%`, `61.4%`, and `72.8%` of the cycle).
   - **Deliberate Verifying Orbit**: In verification mode, the QA Shield payload travels to the verifier node, pauses, executes a 360° audit orbit, pauses again, and returns to the central task core.
   - **Complete State Settle**: Stops all looped packet animations, sweeps, pulsing glows, and coordinate rings instantly, settling cleanly into a calm green state.

4. **Legend Moved Off-Card**:
   - The visual legend is removed from the phone viewport so that it doesn't cover the Work Surface on mobile layouts.
   - The legend has been moved into the desktop Control Room settings panel under "Visual Settings."

5. **Performance and Accessibility**:
   - Driven entirely by CSS and SVG pathing. No canvas, WebGL, or heavy filter stacks.
   - Preserves monochrome icon settings and full `prefers-reduced-motion` diagnostic checks.

## Directory Files
- [index.html](index.html)
- [css/styles.css](css/styles.css)
- [js/main.js](js/main.js)
