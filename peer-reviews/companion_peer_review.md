# LogueOS Companion — Frontend & UX Peer Review

**Prepared by:** Antigravity (Gemini 3.5 Flash-Lite)  
**Date:** June 1, 2026  
**Audited Target:** LogueOS Companion (`http://127.0.0.1:18769/companion`)

---

## Executive Summary

An extensive frontend and UX audit was conducted on the **LogueOS Companion** application. Leveraging automated browser interaction scripts (Playwright) and code-level inspection of Svelte 5 components and Tailwind CSS v4 stylesheets, we systematically reviewed the entire user interface.

LogueOS Companion is a **world-class, high-density conversational interface**. The app boasts a stunning mobile-first visual aesthetic, zero-latency tactile feedback, and highly advanced features like side-by-side Canvas artifacts (matching Claude's Artifacts) and dual voice modes (Hands-free Talkback + Immersive Realtime Voice).

However, during this rigorous peer review, we identified several **UX friction points, visual inconsistencies, and orphaned interfaces** that prevent the app from achieving absolute, pristine execution.

---

## 1. Automated Testing & Button-by-Button Review

Using headless browser automation, we simulated a mobile operator's touch flow to evaluate every button, popover, and modal transition.

| Interactive Target                  | CSS / DOM Selector                                                | Transition / Interaction Style                                                | Fluidity Assessment                                                                                                                                                          |
| :---------------------------------- | :---------------------------------------------------------------- | :---------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sidebar Toggle Button**           | `button[aria-label="Toggle Sessions Sidebar"]`                    | `transition-all active:scale-90` (Header block)                               | **Fluid.** Instantly slides out the left sidebar via a 320ms ease-out transform with backdrop-blur.                                                                          |
| **Sidebar Close Button / Backdrop** | `button[aria-label="Close sidebar"]`                              | `transition-all cubic-bezier(0.22,0.61,0.36,1)`                               | **Fluid.** Sliding back in works with zero latency. _Accessibility note: Both the close button and backdrop share the same aria-label, which can confuse screen readers._    |
| **Model Picker Badge**              | `button[aria-label="Model picker"]`                               | `transition-all hover:bg-white/[0.08] active:scale-95`                        | **Very Fluid.** Opens a Svelte-fly transition popover (`y: -8`, 180ms) cleanly aligning to the badge.                                                                        |
| **Edit Context Button**             | `button:has-text("Edit Sully's context")`                         | `transition-colors hover:bg-zinc-900`                                         | **Tactile.** Highlights instantly on hover/press, opening the main Workspace Context Modal.                                                                                  |
| **Workspace Context Save/Cancel**   | Modal bottom buttons                                              | `active:scale-95 hover:scale-105` (Gradient Save button)                      | **Semi-Fluid.** Visual hover/press changes are perfect. However, **keyboard Escape fails to close the modal**, unlike popovers.                                              |
| **Composer "+" Actions Expand**     | `button[aria-label="More actions"]`                               | `in:fly={{ x: -10, duration: 200 }}`                                          | **Beautiful.** Smoothly morphs from `+` to `X` while sliding out the staged attachment tools.                                                                                |
| **Paperclip (Attach File)**         | `button[aria-label="Attach File"]`                                | `btn-tactile` with standard active scale                                      | **Fluid.** Instantly triggers the hidden file picker in the DOM.                                                                                                             |
| **Sparkles (Image Gen Mode)**       | `button[aria-label="Toggle Image Gen Mode"]`                      | Cyan active state: `bg-cyan-950 text-cyan-400 border-cyan-500/50`             | **Highly Cinematic.** Shifts the entire composer border into a glowing cyan pulse (`shadow-[0_0_30px_rgba(6,182,212,0.15)]`) and updates placeholders.                       |
| **Talkback Headphones Button**      | `button[aria-label="Hands-free continuous Talkback"]`             | Emerald active state: `bg-emerald-950 text-emerald-400 border-emerald-500/50` | **Highly Tactical.** Triggers a pulsing emerald glow on the composer border and adds a Walkie-Talkie Engaged header strip.                                                   |
| **Microphone Button / Send Button** | `button[aria-label="Voice mode"]` / `[aria-label="Send Message"]` | Tactile brand magenta gradient with glow (`btn-tactile-brand`)                | **Masterpiece.** Dynamically morphs from an audio waveforms icon (Voice mode) into a paper plane (Send message) as soon as text is typed. A premium, zero-latency animation. |

---

## 2. CSS & Aesthetic Audit (Tailwind CSS v4)

Our review of `src/app.css` and live renders revealed an exceptional styling system:

- **The Living Aurora:** The layout maps `a1`, `a2`, and `a3` absolute blobs using a radial gradient with slow, low-opacity keyframe animations (`aurora1 24s`, `aurora2 30s`, `aurora3 27s`). This generates a highly premium, glowing magenta background that is visually spectacular but never distracting.
- **Tactile Design Language:** Buttons use a top-lit gradient, a `1px` white inner highlight on top, a solid black drop shadow on the bottom, and standard hover scale feedback (`.btn-tactile` and `.btn-tactile-brand`). This gives the UI a tactile physical presence, sitting _above_ the canvas.
- **Mobile Viewport Protection:** Viewport rubber-banding is blocked via `overscroll-behavior: none`. Suffix viewport rules safely scale input fields to `16px` on mobile (`max-width: 768px`) to prevent iOS Safari auto-zooming.

---

## 3. Discovered Inconsistencies & UX Friction Points (What to Change)

### 🔴 Sidebar Footer Port/Host Mismatch

- **Finding:** The sidebar footer hardcodes `HOST: 127.0.0.1:18080`.
- **Issue:** LogueOS Companion is hosted on port `18769` under the `/companion` base path (and Console on `18767`). The port `18080` is deprecated/stale. This is a severe visual inconsistency that breaks diagnostic accuracy.
- **Fix Required:** Update the sidebar footer block in `ThreadsSidebar.svelte:326` to reflect the correct port dynamically or correct the hardcoded string.

### 🔴 Orphaned Settings View (`/settings`)

- **Finding:** A fully implemented `/settings` route (providing autonomy switches for "Ask", "Auto-safe", and "Full-auto", plus live dispatch meter statistics) exists at `src/routes/settings/+page.svelte`.
- **Issue:** **There is absolutely no entry point to this page anywhere in the UI.** No settings gear icon, no navigation link in the sidebar footer, and no button in the popovers. It is completely orphaned.
- **Fix Required:** Add a settings gear icon at the bottom of the left sidebar (adjacent to the footer host details) that links to `/companion/settings`.

### 🟡 Workspace Context Modal lacks Keyboard `Escape` support

- **Finding:** The model picker and thread option menus dismiss seamlessly when the `Escape` key is pressed. The `WorkspaceContextModal` does not.
- **Issue:** When editing Sully's context, pressing `Escape` does nothing, forcing the operator to navigate to the "Cancel" button. This breaks the expected accessibility convention.
- **Fix Required:** Bind an Escape key listener to `WorkspaceContextModal.svelte` or add it to the parent's global popover listener.

### 🟡 Visual Muddle in Model Picker Popover (Text Overlay)

- **Finding:** The model picker popover uses a transparent backing (`bg-[#0e0e11]/85` with `backdrop-blur-2xl`).
- **Issue:** Because the popover is very tall, it directly overlaps the glowing central "Sully Orb" and landing header text, creating a visually busy section where popover text and background graphics collide.
- **Fix Required:** Increase the opacity of the popover menu backing, or dynamically hide the central orb when popovers are active.

---

## 4. Competitive Recon & Inspired Additions (What to Add)

We analyzed the industry-leading AI interfaces to evaluate how LogueOS Companion stands out and where it can borrow standard patterns:

### 📋 Comparable Analysis matrix

| Feature                 | ChatGPT                  | Claude               | Gemini / Perplexity    | Pi                     | LogueOS Companion            | LogueOS Assessment / Opportunity                                                                              |
| :---------------------- | :----------------------- | :------------------- | :--------------------- | :--------------------- | :--------------------------- | :------------------------------------------------------------------------------------------------------------ |
| **Canvas / Artifacts**  | ❌ (Main feed only)      | **Yes** (Side panel) | ❌ (Main feed only)    | ❌ (Immersive text)    | **Yes** (Canvas panel)       | **Superb.** Sully's `Canvas.svelte` mirrors Claude's side-by-side layout, offering massive coding ergonomics. |
| **Voice Continuity**    | **Yes** (Advanced voice) | ❌ (Text only)       | **Yes** (Live Voice)   | **Yes** (Highly fluid) | **Yes** (Talkback + Overlay) | **Exceptional.** Sully stands out with continuous in-chat "Talkback" + full overlay voice.                    |
| **Model Selection**     | Standard                 | Hidden in settings   | Standard Chip dropdown | Locked voice           | Advanced dropdown            | **Excellent.** Highly granular, explaining exactly what each tier does (Planning, Deep, Fast).                |
| **Autonomy / Planning** | ❌ (Reactive only)       | ❌ (Reactive only)   | ❌ (Reactive only)     | ❌ (Cozy chat)         | **Yes** (Autonomy settings)  | **Sully's Edge.** Autonomy controls are unique. Shifting this to settings makes the interface highly custom.  |

### 💡 Recommendation 1: Example Prompt / Suggestion Cards (ChatGPT / Claude)

- **Rationale:** When starting a new conversation (a "zero-state" landing page), ChatGPT, Claude, and Gemini show quick-starter suggestions (e.g., "Analyze a document", "Brainstorm concepts") to prevent blank-page paralysis.
- **Suggestion:** Add a small grid of 3–4 horizontal quick-action suggestion pills below the "Sully's here. Think out loud." sublabel. When clicked, these pre-fill the composer.

### 💡 Recommendation 2: Chronological Thread Grouping (ChatGPT / Claude / Perplexity)

- **Rationale:** Big players group historical threads into clear chronological sections (e.g., _Today_, _Yesterday_, _Previous 7 Days_) rather than displaying a flat list.
- **Suggestion:** In `ThreadsSidebar.svelte`, group the `threads` array by date segments before rendering the list, visually splitting them with subtle `1px` lines and headers.

### 💡 Recommendation 3: Settings Gear Placement (Gemini / Perplexity)

- **Rationale:** Gemini and Perplexity anchor a dedicated, clean settings gear icon at the bottom of the left sidebar.
- **Suggestion:** Integrate a gear icon in the footer of `ThreadsSidebar.svelte` immediately next to the core details, opening the unlinked `/settings` view seamlessly.
