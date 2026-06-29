# AGY Mockup Pack — Sully Flagship Visual Pass

This directory contains the visual prototypes designed by **AGY (Antigravity)** for the Sully Look-and-Feel visual pass. They demonstrate an alternative layout and visual hierarchy adhering to the locked spec.

## Design Rationale

1. **Quiet Chat Atmosphere:** Assistant text remains bubble-less and completely open on the background canvas for optimal reading comfort. User messages are right-aligned, glass capsules with a tucked bottom-right corner.
2. **Progressive Control Disclosure:** The noisy inline Copy/Regenerate row is replaced. Controls are completely hidden at rest, fading in only when hovering or clicking the message block, keeping the flow clean.
3. **Immersive Voice Orb:** The central orb handles the voice mode transitions with organic keyframe-based breathing, scaling, visualizer lines, and floating ripple glows, elevating voice interactions to a flagship standard.
4. **Interactive Suggested prompts:** Suggested prompt chips are organized vertically, and clicking them pre-fills the composer input and moves cursor focus, demonstrating real product feedback.
5. **Unified Glassmorphic System:** A single, consistent glass-scrim recipe is shared by the composer, the sidebar drawer, user messages, and overlay sheets.
6. **No Dev footprints:** The sidebar is completely scrubbed of console IP addresses, raw HOST details, and secondary control rows, highlighting pinned and active threads. Pinned items are given custom tags.

## How to View

Run the following command from the workspace root or this directory:

```bash
cd /home/dreighto/dev/LogueOS-Companion/docs/flagship-visual-mockups/agy
python3 -m http.server 8766 --bind 0.0.0.0
```

- **Local Address:** `http://127.0.0.1:8766/`
- **Tailscale Address (Phone):** `http://room.taila28611.ts.net:8766/`
