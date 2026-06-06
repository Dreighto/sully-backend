# Sully Work Surface Motion Mockup - Demos

This directory contains standalone, high-fidelity prototypes demonstrating operator interactions and motion design for the Sully Work Surface card.

---

## 🚀 How to Preview
1. Open either [sully_work_surface_motion_mockup_v1.html](sully_work_surface_motion_mockup_v1.html), [sully_work_surface_motion_mockup_v2.html](sully_work_surface_motion_mockup_v2.html), or [sully_work_surface_motion_mockup_v3.html](sully_work_surface_motion_mockup_v3.html) directly in any local web browser.
2. The pages load with a split screen:
   - **Left**: Control Room Panel (toggle states, presets, check animations).
   - **Right**: Simulated Mobile Viewport running the live component card inside a chat feed simulation.
3. Test buttons to trigger preset transitions, double-tap safety overrides, speed controls, and layout states (collapsed pill, compact, and expanded panels).

---

## 📁 Created Files

### Version 3: Active Ownership (Refined Ownership Focus)
- [sully_work_surface_motion_mockup_v3.html](sully_work_surface_motion_mockup_v3.html): Adds the dynamic glanceable "Now: [Worker] [action]" label banner, dynamic DeepSeek verify preset, and structured tables.
- [sully_work_surface_motion_mockup_v3.css](sully_work_surface_motion_mockup_v3.css): Strong scale/glow pulses for active worker nodes, quieter styles for inactive/queued nodes, glowing active route paths, highlighted registry rows, and clean status badges.
- [sully_work_surface_motion_mockup_v3.js](sully_work_surface_motion_mockup_v3.js): Limits packet glide animations only to the active path, coordinates dynamic text for glanceable labels, and highlights specific worker rows.

### Version 2: Living System (Polished Calm Animations)
- [sully_work_surface_motion_mockup_v2.html](sully_work_surface_motion_mockup_v2.html): Clean HTML container with a v2 unfolding grid layout.
- [sully_work_surface_motion_mockup_v2.css](sully_work_surface_motion_mockup_v2.css): Slower, ease-in-out breathing transitions, staggered animation delays, smooth cubic-bezier packet gliding, and soft confirmation sweep.
- [sully_work_surface_motion_mockup_v2.js](sully_work_surface_motion_mockup_v2.js): Multi-packet flow coordinator with staggered delays and out-of-sync floats.

### Version 1: Mechanical Baseline (For Reference)
- [sully_work_surface_motion_mockup_v1.html](sully_work_surface_motion_mockup_v1.html): Initial markup container.
- [sully_work_surface_motion_mockup_v1.css](sully_work_surface_motion_mockup_v1.css): Rapid flashing and mechanical linear-speed packet slides.
- [sully_work_surface_motion_mockup_v1.js](sully_work_surface_motion_mockup_v1.js): Basic state manager with unified node pulsing.

---

## 🎨 Staged Assets Used
This mockup translates the vector designs from the staging folder:
- **Workers** (from `svg_assets/workers/`):
  - [antigravity.svg](../svg_assets/workers/antigravity.svg) (Antigravity icon wrapper)
  - [claude_code.svg](../svg_assets/workers/claude_code.svg) (Claude invader layout)
  - [codex.svg](../svg_assets/workers/codex.svg) (Codex spoked icon)
  - [gemini.svg](../svg_assets/workers/gemini.svg) (Gemini star shape)
  - [deepseek.svg](../svg_assets/workers/deepseek.svg) (DeepSeek whale shape)
- **System** (from `svg_assets/system/`):
  - [task.svg](../svg_assets/system/task.svg) (Central task destination)
  - [dispatch.svg](../svg_assets/system/dispatch.svg) (Hub-spoke network indicator)
  - [packet.svg](../svg_assets/system/packet.svg) (Isometric data packets)
  - [verify.svg](../svg_assets/system/verify.svg) (QA verification checkmark shield)
  - [approval.svg](../svg_assets/system/approval.svg) (Document with checkmark badge)
  - [blocked.svg](../svg_assets/system/blocked.svg) (Stop/restriction sign)
  - [brain-memory.svg](../svg_assets/system/brain-memory.svg) (Symmetrical brain lobes)

*(Note: Assets are compiled inline inside the JS logic block to allow instant offline rendering over the local `file://` protocol, avoiding CORS constraints when fetching external icons.)*

---

## 🔍 What CC (Captain) Should Review

Before committing and integration:
1. **Interactive Node Layouts**: Review if the worker network nodes scale cleanly when going from 1 worker (CC-Only) to 4 workers (Multi-Worker Flow).
2. **Animation Feel & Telemetry**: Check the visual pace of the glowing nodes and animated packets flowing along connecting paths.
3. **Double-Tap Safety Gates**: Test clicking **Approve Override** on a blocked state. Confirm if the red safety confirmation transition and the final transition to `Complete` look premium.
4. **Digestibility**: Review whether the compact view presents information clearly, and if the expanded registry is clean.
5. **Completion Sweep**: Check the shine animation across the card that triggers upon approving dangerous tasks.
