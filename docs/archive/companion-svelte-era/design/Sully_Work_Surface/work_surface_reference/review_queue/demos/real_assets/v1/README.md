# Sully Work Surface - Real Assets v1 Staging Preview

This directory contains the production-staging preview of the Sully Work Surface component (`real_assets_v1`), moving beyond abstract mockups to use actual production SVG assets. 

It is designed as a standalone evaluation area for Captain (Dreighto) and CC review before integration into the main application codebase.

## Directory Structure
- [index.html](index.html): Standalone HTML container displaying the mobile-first device frame and interactive control deck.
- [css/styles.css](css/styles.css): Production CSS animations, node styles, and layouts.
- [js/main.js](js/main.js): Preset engines, dynamic layout coordinator, and SVG rendering scripts.

## Key Features & v3.3 Baseline Behaviors Preserved
1. **Dynamic Layout Coordinate Engine**: Only active workers are displayed. Worker positions are calculated on-the-fly, distributing them symmetrically around the central TASK node.
2. **Real SVG Assets**: Loader symbols map directly to raw files in `svg_assets/workers/` and `svg_assets/system/`.
3. **Semantic Motion Profiles**:
   - `researching`: Small blips/context icons flowing from Worker -> Task.
   - `building`: Isometric code packets/cubes flowing from Worker -> Task.
   - `verifying`: Validation shield-checks oscillating between Task <-> Worker.
   - `blocked`: Static dashed routes with slow warning breathing.
   - `complete`: Static route settled in green.
4. **Motion Intensity Controls**: Toggles between Subtle, Normal, and Debug Outline modes.
5. **Interactive Controls**: Approve Override (double-tap safety), Stop Pipeline, and expand/collapse card details.

## Real SVG Asset Sources
- **Workers**: `claude.svg`, `antigravity.svg`, `codex.svg`, `gemini.svg`, `deepseek.svg`
- **System**: `task.svg`, `dispatch.svg`, `verify.svg`, `memory.svg`, `approval.svg`, `blocked.svg`, `packet.svg`
