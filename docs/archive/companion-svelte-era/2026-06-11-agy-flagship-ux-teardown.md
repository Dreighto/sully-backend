# Sully Flagship UX Teardown & Implementation Spec

This document details the visual and architectural teardown of modern AI assistant interfaces (ChatGPT, Claude, Gemini) and translates their public design patterns into original, trademark-safe Sully behaviors. It builds directly upon the June 1 Audit, resolving open questions and structuring a phased SvelteKit implementation plan.

---

## Part A — Plain-English Spec (Operator-Readable)

For dreighto: This spec outlines how we raise Sully (LogueOS-Companion) to a premium, iOS-native chat-and-work assistant. We preserve Sully's unique identity—its ability to dispatch background workers and run immersive voice loops—while matching the quiet, high-craft aesthetics of ChatGPT and Claude.

### 1. Feature Inventory (Market Patterns → Sully Opportunities)

*   **Chat Composer:** 
    *   *Market Pattern:* A simple pill anchored at the bottom (ChatGPT, Claude) that expands vertically with input. Icons are flat outlines (1.5px stroke).
    *   *Sully Opportunity:* Keep the floating composer pill [Composer.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/Composer.svelte). Relocate the model selection chip *out* of the composer input and place it in the header as a status indicator. The composer now contains only attachments (`+`), the text field, the talkback wave toggle, and the send/voice FAB.
*   **Message Stream:**
    *   *Market Pattern:* Clean, open body text for assistant replies with no bounding bubble boxes (Claude). User messages are tucked, light-glass or subtle neutral capsules aligned to the right. Actions (copy, regen) are completely hidden until hover or long-press.
    *   *Sully Opportunity:* Strip opaque card backgrounds from assistant replies in [MessageFeed.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/MessageFeed.svelte). Keep them flat against the ambient background canvas. Replace the zinc user bubbles (`border-zinc-700/60 bg-zinc-900/60`) with light glass matching the composer. Hide the action rows by default, disclosing them only when a message block is focused or tapped.
*   **Sidebar / History:**
    *   *Market Pattern:* Chronological, grouped thread list (Today, Yesterday, Previous 7 Days) with auto-generated human titles.
    *   *Sully Opportunity:* Group threads chronologically in [ThreadsSidebar.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/ThreadsSidebar.svelte). Hide empty fresh-created threads from the list until the first message is sent. Remove the console dev footer (`CORE: Sully · HOST: ...`) and replace it with a clean settings profile button.
*   **Voice Mode & Talkback:**
    *   *Market Pattern:* Immersive full-screen overlay with a central breathing visualizer orb and real-time transcription feedback (ChatGPT Advanced Voice).
    *   *Sully Opportunity:* Retain the custom voice status engine in [voice-mode.svelte.ts](file:///home/dreighto/dev/LogueOS-Companion/src/lib/chat/voice-mode.svelte.ts) and the UI in [VoiceMode.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/VoiceMode.svelte). Implement visual ripples using CSS scale transitions in the Listening phase, and an equalizer wave in the Speaking phase.
*   **Active Work & Dispatch:**
    *   *Market Pattern:* Competitors do not have autonomous background workers triggered directly via chat. This is Sully's primary differentiator.
    *   *Sully Opportunity:* Create a persistent "Active Tasks" widget in [ThreadsSidebar.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/ThreadsSidebar.svelte). When a user dispatches CC or AGY (e.g. `@cc ...`), a status row appears in the sidebar displaying: Worker Badge (`CC` / `AGY`), Task Brief, Status Dot (Amber/Green/Red), and a Cancel button. This widget persists when switching threads, keeping the operator aware of background task runs.
*   **PWA Standalone & Standby:**
    *   *Market Pattern:* Standard top-banners for PWA updates block UI headers and break click interceptors.
    *   *Sully Opportunity:* Demote the full-width banner in [PwaUpdatePrompt.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/PwaUpdatePrompt.svelte) to a small, floating bottom-left toast or badge indicator that does not collide with header controls.

---

### 2. UX State Machine Mapping

We map every visual state to existing Svelte variables and models, extending them to support progressive visual feedback:

| State | Status | Svelte/TS File Location | Description & UI Action |
| :--- | :--- | :--- | :--- |
| **Idle** | `EXISTS` | [composer-state.svelte.ts](file:///home/dreighto/dev/LogueOS-Companion/src/lib/chat/composer-state.svelte.ts) | Empty input, landing hero visible with 3-4 prompt chips. |
| **User Composing** | `EXISTS` | [Composer.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/Composer.svelte) | Input field expands, send button changes state from microphone to send arrow. |
| **Submitted** | `EXISTS` | [streaming.svelte.ts](file:///home/dreighto/dev/LogueOS-Companion/src/lib/chat/streaming.svelte.ts) | User bubble floats right, composer input locks, thinking monster avatar appears. |
| **Model Streaming** | `EXISTS` | [sdk-stream/+server.ts](file:///home/dreighto/dev/LogueOS-Companion/src/routes/api/chat/sdk-stream/+server.ts) | Tokens stream into feed. Auto-scroll stays anchored to bottom. |
| **Tool Running** | `EXTEND` | [companion_tools.ts](file:///home/dreighto/dev/LogueOS-Companion/src/lib/server/companion_tools.ts) | Inline progress chips update with the active tool's step (e.g. "Reading file..."). |
| **Worker Dispatched** | `EXTEND` | [pillModel.ts](file:///home/dreighto/dev/LogueOS-Companion/src/lib/work-surface/pill/pillModel.ts) | Active tasks widget appears in sidebar. [WorkerPill.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/work-surface/pill/WorkerPill.svelte) is injected inline. |
| **Waiting on User** | `NEW` | [autonomous_dispatch.ts](file:///home/dreighto/dev/LogueOS-Companion/src/lib/server/chat/autonomous_dispatch.ts) | A clear banner displays in the stream asking for permission to proceed with a command. |
| **Verifying** | `EXTEND` | [verifyPoll.ts](file:///home/dreighto/dev/LogueOS-Companion/src/lib/server/verifyPoll.ts) | A warning or success badge displays in the worker pill during git check or test runs. |
| **Complete** | `EXISTS` | [completionClose.ts](file:///home/dreighto/dev/LogueOS-Companion/src/lib/server/completionClose.ts) | Task row in sidebar updates to green, summary card displays in feed. |
| **Failed** | `EXISTS` | [completionClose.ts](file:///home/dreighto/dev/LogueOS-Companion/src/lib/server/completionClose.ts) | Sidebar status turns red, logs become expandable inline. |
| **Canceled** | `EXISTS` | [autonomous_dispatch.ts](file:///home/dreighto/dev/LogueOS-Companion/src/lib/server/chat/autonomous_dispatch.ts) | Running processes are killed, pill status collapses to "canceled". |

---

### 3. Sully-Specific UX Improvements

*   **Real-Time Progress Tracking:** Avoid indefinite thinking states. When a tool runs, the inline chip should reflect the current sub-phase (e.g. *Searching the web...* or *Writing build script...*).
*   **Collapsed-by-Default Architecture:** Keep thread noise down. Deep tool execution logs and file contents returned by workers must be collapsed into simple, readable summaries. Clicking the summary discloses the full debug block.
*   **Artifact Creator Metadata:** When files are generated on the local machine via workers, display clear creator tags (e.g., *Generated by CC | 2.4 KB*) with a fast-download shortcut that reads directly from the workspace filesystem.
*   **Triaging Multiple Workers:** If the user dispatches multiple workers on a single task, the feed groups their activity into a single, multi-column dashboard widget rather than flooding the conversation stream with individual progress messages.

---

### 4. June 1 Audit Review (TRIANGULATED & UPDATED)

#### What the June Audit Got Right (Validated)
*   **Sidebar-Inline Spaces:** The assertion that "flagships put projects on a separate page" was correct. The industry universal pattern has converged on sidebar-inline space organization to preserve context and momentum.
*   **Dev Chrome Removal:** Removing the raw port numbers, core labels, and destructive clean toolbar options from the primary sidebar was completely justified.
*   **Popover Unification:** Unifying the popover recipe (glassmorphic, uniform corners, blurred scrims) was a massive visual regression fix.

#### What Has Been Updated / Corrected
*   **The Artifacts Panel already exists:** The June audit listed a side-panel artifact viewer as a "deferred future build." AGY has discovered that [Canvas.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/Canvas.svelte) is already implemented in the codebase and wires into the markdown parsing pipeline. We simply need to polish this interface and expose it.
*   **Autonomy settings exist:** The June audit recommended building an autonomy control panel. AGY discovered that a fully functional Svelte settings page already exists at [settings/+page.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/routes/settings/+page.svelte) containing autonomy state triggers. We only need to style it to match locked brand tokens and add navigation links to it from the sidebar.
*   **Incorrect Sidebar Port:** The legacy sidebar footer displayed port `18080` as the host. This is factually incorrect; the companion service runs on port `18769`. We will replace this text with a settings button.

---

## Part B — Technical Implementation Checklist

### 1. SvelteKit Component Map

We map every target visual concept to our active codebase, defining clean rename paths where necessary:

| Target Concept | Codebase Path | Status | Migration & Styling Notes |
| :--- | :--- | :--- | :--- |
| **ChatShell** | [src/routes/chat/+page.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/routes/chat/+page.svelte) | `EXISTS` | Handles grid layout. Inject logic to handle desktop sidebar persistent toggle state. |
| **MessageList** | [MessageFeed.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/MessageFeed.svelte) | `RENAME` | Rename to `MessageList.svelte` for clarity. Remove bubble blocks on assistant replies; convert user bubble to glassmorphism. |
| **Composer** | [Composer.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/Composer.svelte) | `EXISTS` | Remove model selection dropdown from interior input structure. |
| **AttachmentTray** | [Composer.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/Composer.svelte) | `EXTEND` | Style staged image cards as glass blocks with 8px corner radii. |
| **WorkCard** | [DispatchCard.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/work-surface/DispatchCard.svelte) | `EXISTS` | Restyle border to locked `--line` tokens; clean up internal padding. |
| **WorkerPill** | [WorkerPill.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/work-surface/pill/WorkerPill.svelte) | `EXISTS` | Add pulsing status dot indicating active runner state. |
| **RunSheet** | [RunSheet.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/work-surface/pill/RunSheet.svelte) | `EXISTS` | Restyle tabular logs using `--font-mono` and `font-variant-numeric: tabular-nums`. |
| **ArtifactShelf** | [WorkSurfaceDock.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/work-surface/WorkSurfaceDock.svelte) | `EXISTS` | Align dock border structure to `--glass-border`. |
| **ToolEventTimeline** | [StageTimeline.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/StageTimeline.svelte) | `EXISTS` | Restyle vertical line to `--line2`; ensure checkmarks are monochrome. |
| **ApprovalBanner** | [src/lib/components/ApprovalBanner.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/ApprovalBanner.svelte) | `NEW` | Create Svelte component to handle inline action buttons (`Approve` / `Reject`) for dispatched worker hooks. |
| **VerificationSummary**| [ProofCard.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/ProofCard.svelte) | `EXISTS` | Align styling with locked Indigo palette status containers (`--green-bg` / `--green-line`). |

---

### 2. Vercel AI SDK Integration

Sully separates its text UI stream from its speech-only processing stream. We respect this separation:

1.  **Text Streaming:** [src/routes/api/chat/sdk-stream/+server.ts](file:///home/dreighto/dev/LogueOS-Companion/src/routes/api/chat/sdk-stream/+server.ts) utilizes the Vercel AI SDK `streamText` function to push markdown segments and tool calls to the client.
2.  **Tool Call Executions:** [companion_tools.ts](file:///home/dreighto/dev/LogueOS-Companion/src/lib/server/companion_tools.ts) contains the schemas and execution methods passed to `streamText`.
3.  **Human-in-the-Loop Interrupts:** When a tool requires authorization (e.g. executing commands), [autonomous_dispatch.ts](file:///home/dreighto/dev/LogueOS-Companion/src/lib/server/chat/autonomous_dispatch.ts) halts the stream and yields control back to the UI. The client renders an inline `ApprovalBanner`, posting user feedback to `api/chat/approve` to resume stream generation.
4.  **Real-Time Speech Synthesis:** Voice turns bypass the Svelte UI streams. They utilize [voice-reply/+server.ts](file:///home/dreighto/dev/LogueOS-Companion/src/routes/api/chat/voice-reply/+server.ts) to push simple text buffers to the local audio bridge.

---

### 3. Phased PR Slices

To minimize regressions, changes are shipped in isolated, reviewable PR packages:

#### Phase A — Visual Polish & Dev Cleanup (Visual Only)
*   **PR 1: Message List Polish**
    *   Target: [MessageFeed.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/MessageFeed.svelte)
    *   Scope: Remove bubble backgrounds on assistant responses. Apply glassmorphic styles to user responses.
*   **PR 2: Progressive Action Disclosure**
    *   Target: [MessageFeed.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/MessageFeed.svelte)
    *   Scope: Hide inline Copy/Regen controls. Add hover and tap-focus listeners to disclose actions.
*   **PR 3: Sidebar Dev Scrubbing**
    *   Target: [ThreadsSidebar.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/ThreadsSidebar.svelte)
    *   Scope: Remove raw IP/port text. Collapse archived options. Replace with settings profile card.

#### Phase B — UI Structuring & Layout Unification (Visual + Config)
*   **PR 4: Composer Restructuring & Model Migration**
    *   Target: [Composer.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/Composer.svelte), [ChatHeader.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/ChatHeader.svelte)
    *   Scope: Shift model selection chip to the header. Clean up input pill interior.
*   **PR 5: Settings Integration**
    *   Target: [ThreadsSidebar.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/ThreadsSidebar.svelte), [settings/+page.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/routes/settings/+page.svelte)
    *   Scope: Style settings page using locked Indigo spec tokens. Add navigation link from sidebar footer.
*   **PR 6: Suggested Starter Chips**
    *   Target: [Composer.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/Composer.svelte), [MessageFeed.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/MessageFeed.svelte)
    *   Scope: Add 3-4 starter prompt chips below empty greetings. Wire taps to fill and focus composer.

#### Phase C — Active-Work Integration (Needs Backend Hooks)
*   **PR 7: Persistent Active Tasks Panel**
    *   Target: [ThreadsSidebar.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/ThreadsSidebar.svelte), [pillModel.ts](file:///home/dreighto/dev/LogueOS-Companion/src/lib/work-surface/pill/pillModel.ts)
    *   Scope: Connect sidebar widget to current dispatch status stream, showing active workers.
*   **PR 8: Human-in-the-Loop Inline Approvals**
    *   Target: [MessageFeed.svelte](file:///home/dreighto/dev/LogueOS-Companion/src/lib/components/MessageFeed.svelte), [autonomous_dispatch.ts](file:///home/dreighto/dev/LogueOS-Companion/src/lib/server/chat/autonomous_dispatch.ts)
    *   Scope: Render approval cards inline when streams pause for user command approvals.

---

## Part C — Explicitly Deferred / Do-Not-Build-Yet

These features are out of scope for the current wave of changes and will not be worked on:

1.  **Separate Space Pages:** No `/companion/spaces` page. All project filtering is strictly inline within the sidebar drawer to maintain navigation momentum.
2.  **Per-Action Permission Popups:** We do not pop up native browser confirm dialogs for individual background scanning events. Users find this annoying; permission is handled globally in settings.
3.  **Bot Grid Home Screen:** We reject a Poe-style grid of custom bots. Sully is a single, hop-in-and-go agent that determines tool routing autonomously.
4.  **Light Mode Theme:** We remain strictly dark-mode, styled around the locked Indigo token colors.
