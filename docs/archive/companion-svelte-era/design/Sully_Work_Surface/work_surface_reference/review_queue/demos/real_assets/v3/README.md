# Sully Work Surface - Real Assets v3 Preview

This directory contains the third iteration of the production-staging preview (`real_assets_v3`), focusing entirely on establishing a **workflow-meaningful animation language**.

Instead of general glowing lines, the animations are designed to explain to Captain and CC exactly _how_ work is flowing through the system.

## Dynamic Animation Language

1. **Researching (Gathering Context)**:
   - Slower, exploratory flow (`6s` cycle) representing information discovery.
   - Payloads are **radar blips** (scanning pings).
   - In single-worker presets, a **Memory (Context) node** is added on the right side and an **outside edge curve** enters from the bottom-right. Blips travel from the worker, Memory, and outside edge, converging into the central `TASK` node.
2. **Building (Producing Output)**:
   - Confident, rhythmic batches of isometric code packets (cubes) traveling from Worker -> Task.
   - **Precision Sync**: The `TASK` node releases a subtle ripple expansion precisely at the timestamps when each packet in the batch arrives at the core (pulses at `50%`, `61.4%`, and `72.8%` of the `3.5s` cycle).
3. **Verifying (Inspection)**:
   - Analytical QA Shield payloads move TASK ↔ verifier (worker or Verify system node).
   - **Inspection Orbit**: The packet orbits around the verifier node's center from `40%` to `75%` of its cycle to imply checking.
   - **Precision Sync**: The verifier node fires high-frequency scan pulses _only_ during the active orbit, and the `TASK` node ripples precisely when the packet returns back.
4. **Multi-Worker Coordination**:
   - Routes are prioritized: the primary active worker is highlighted with glowing paths and full-strength payloads.
   - Secondary workers are dimmed (`12%` route opacity, `28%` packet opacity) and run slower (`1.4x` cycle duration) to represent background support rather than visual chaos.
5. **Waiting / Blocked (Operator Intercept)**:
   - Routes freeze completely (dashes stop moving, no payloads).
   - Pacified warning pulse breathes slowly, showing Sully is waiting on your input, not broken.
6. **Complete (Settled)**:
   - All looped motion, sweeps, and packet animations stop completely, settling into a quiet green state.
7. **Interactive Preview Legend**:
   - Added an instrumentation overlay legend at the bottom of the graph viewport to clarify the meaning of each state. Customized with wrapping support for mobile screens.

## Staging Files

- [index.html](index.html)
- [css/styles.css](css/styles.css)
- [js/main.js](js/main.js)
