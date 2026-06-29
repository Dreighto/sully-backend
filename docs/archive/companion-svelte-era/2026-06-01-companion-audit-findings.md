# Companion Audit & Direction — 2026-06-01

**Three independent inputs synthesized:** (1) live Playwright audit of the running app at iPhone + desktop viewports, (2) deep research on the visual design language of flagship AI chat apps, (3) deep research on the information-architecture / multi-thread / projects-spaces handling of those apps. All three findings agree on the high points. The research's qualitative patterns are trustworthy; its specific percentages are largely fabricated by Perplexity's deep-research mode and are **ignored** in this synthesis.

This doc is the CC view. AGY's parallel synthesis can drop in alongside and we'll triangulate.

**Mandate from the operator:** no code touched until we agree on direction. One exception flagged below: a high-severity functional regression introduced by my own sidebar work (desktop sidebar invisible on initial load). Including it here for visibility, not fixing yet.

---

## 0. TL;DR — what to actually do

1. **Spaces decision (the operator's biggest question):** the "most flagship apps put projects on a separate page" framing is **incorrect**. Nobody successfully ships projects on a separate top-level surface — ChatGPT tried it in beta and reverted. The universal pattern is **sidebar-inline with optional filtering**. For our personal active-work app the right call is a stronger version of the current sidebar with collapsible spaces + an "Active Tasks" persistent awareness section, NOT a separate page. (Details in §6.)
2. **One real bug to fix:** the desktop sidebar is invisible on initial load because an inline `transform: translateX(-100%)` beats the `lg:translate-x-0` Tailwind class. Phone is fine (it's supposed to be a drawer); desktop is broken. One-line fix, needs operator green light per the "no code" rule.
3. **The chrome is mostly there, the sidebar isn't.** The composer pill, the message footer, the model picker, the thinking indicator with monster avatar — those are all sound and premium. The sidebar reads as glued-on from a different design language. Top three to align: (a) thread-options popover ≠ model-picker popover (10px apart, no shared blur/border idiom), (b) sidebar Sully mark is 4px smaller than chat-header Sully mark, (c) "Show archived / Clear all" toolbar row uses devtool chrome on a premium surface.
4. **Identity-affirming patterns to adopt** (active-work companion, not chat-with-a-bot): persistent "Active Tasks" sidebar section, inline tool-call chips with backlink to originating message, optional right-side artifact panel for dispatched work, AI-suggested project promotion (Cursor pattern), Cmd-K command surface.
5. **Patterns to explicitly reject:** separate top-level page for projects (tried and abandoned everywhere), full-screen modal project setup (kills momentum), per-action permission prompts (users disable background scanning after 2-3 prompts), Poe-style tool-picker-as-home (wrong identity).
6. **One identity-clarifying note:** Claude has Cowork/Code that "do work," but they require navigation/setup. Our differentiator is hop-in-and-go: type into the same composer, the model decides what tools to call. That's preserved by current direction. Don't accidentally re-add ChatGPT-style "pick a Custom GPT first" friction.

The rest of this doc is evidence and the menu we choose from.

---

## 1. The desktop sidebar bug (flag, don't fix yet)

**Component:** `src/lib/components/ThreadsSidebar.svelte:91-95` + `src/routes/chat/+page.svelte` initial `sidebarOpen`.

**Symptom (verified by visual audit at 1024×768):** on a fresh page load, sidebar `getBoundingClientRect().x === -288`. Toggle button works; after click, it stays open. So an operator landing on desktop never sees the persistent sidebar — they think the app has no sidebar until they hunt the burger.

**Cause:** the sidebar uses an inline `style="transform: translateX({open ? 0 : -100%})"` for the spring slide, but inline styles beat Tailwind utilities, so `lg:translate-x-0` never wins.

**Fix sketch (do NOT apply yet):** either `sidebarOpen = $state(typeof window !== 'undefined' && window.innerWidth >= 1024)`, or keep the inline transform off on `lg:` by gating it. One-line either way.

**Operator impact:** phone use is unaffected (drawer behavior is correct). Desktop use only.

---

## 2. What works (keep — these are the reference points)

These set the bar for everything else. New surfaces should be siblings of these, not exceptions.

- **The composer pill** (`Composer.svelte`) — `rounded-3xl border-white/[0.08] bg-[#0e0e11]/60 backdrop-blur-2xl focus-within:border-white/20`. The pulse-glow on `sending` (brand/45 border + 28% magenta shadow) is the right amount of magenta in the right moment.
- **`SullyNameTag.svelte`** — the "● Sully" pill. Brand-soft text, brand/30 border, brand/0.08 bg, gradient dot. This is the magenta-usage benchmark — sparing, identity-only.
- **`btn-tactile-brand`** — domed gradient + dual inset highlights + magenta glow halo. "The one important button" treatment, used on send / voice-mode. Premium.
- **The "+" composer reveal animation** — `fly` from x:-10 with 45ms/90ms staggered delays. Genuinely tactile, the best micro-interaction in the app right now.
- **The Den's brand styling when active** — `border-brand/45 bg-brand/[0.12] shadow-[0_0_16px_-4px_rgba(236,45,120,0.4)]`. Correct semantic use of magenta (identity = home).
- **The sidebar slide-in curve itself** — `cubic-bezier(0.22,0.61,0.36,1) 320ms`. Springy without being bouncy.
- **The empty-state landing** — fresh thread on open with "Hey Captain — what's on your mind?" — matches the hop-in-and-go identity.
- **The thinking indicator + monster avatar** — Sully name-tag pill + monster sprite at state="thinking" + 3 bouncing dots. Premium and identity-forward.

---

## 3. What's off — cross-component inconsistencies (the real list)

Each is a HIGH/MED/LOW from the live audit. File refs from the audit (verified against current source).

### HIGH

| #   | Component                                                                                   | Issue                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | `ThreadsSidebar.svelte:91-95` + page init                                                   | **Desktop sidebar invisible on first load.** Inline `transform: translateX(-100%)` beats `lg:translate-x-0`. See §1.                                                                                                                                          |
| H2  | model picker (`ChatHeader.svelte:113`) vs thread-options menu (`ThreadsSidebar.svelte:273`) | **Two popover languages 10px apart.** Model picker = `rounded-2xl border-white/[0.08] bg-[#0e0e11]/85 backdrop-blur-2xl`. Thread-options = `rounded-xl border-zinc-800 bg-[#0e0e0e]` opaque, no blur. Same app, same purpose. Operator flagged this directly. |
| H3  | `ThreadsSidebar.svelte:321-327`                                                             | **Sidebar footer is dev-overlay chrome** — `CORE: Sully · HOST: 127.0.0.1:18080` rendered as two-line label:value. Violates the companion-ui-design discipline ("OPPOSITE of operator-console-ui"). Replace with a profile/settings chip OR hide entirely.    |

### MED

| #   | Component                                                                     | Issue                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | `ThreadsSidebar.svelte:112` (`h-7 w-7`) vs `ChatHeader.svelte:76` (`h-8 w-8`) | **Sidebar Sully mark is 4px smaller than chat-header Sully mark** + drop-shadow opacities differ (0.45 vs 0.5). Pick one, use everywhere.                                                                                                               |
| M2  | `ThreadsSidebar.svelte:262` (kebab)                                           | **Session-options kebab uses `rounded` (8px) + `hover:bg-zinc-800` + no border**, breaking the row's chrome language (`rounded-xl` + alpha-white borders everywhere else). Also h-11×w-9 — only non-square tap target in chrome.                        |
| M3  | `ThreadsSidebar.svelte:141-158` toolbar (Show archived / Clear all)           | **Toolbar buttons are floating chrome-less ghosts** below a row of bordered icon buttons. No visual relationship to the header. Suggest collapsing both into the sidebar kebab (Show archived → settings; Clear all → kill it, it's a foot-gun anyway). |
| M4  | `MessageFeed.svelte:125` user bubble                                          | **Operator bubble uses `border-zinc-700/60 bg-zinc-900/60`** — opaque Slack-era card. Composer uses glass (`border-white/[0.08] bg-[#0e0e11]/60 backdrop-blur-2xl`). Both render the operator's voice; they should be the same material.                |
| M5  | `MessageFeed.svelte:143-190` action buttons                                   | **Copy / Regen / Play are h-7 (24.5px) — below the 44pt iOS tap-target minimum.** Bump to h-9 + icon-only on mobile.                                                                                                                                    |
| M6  | `Composer.svelte:189` image-mode strip                                        | **Cyan accent only used here + drag-overlay**, and the toggle's "active" state is `bg-cyan-950` (DARKER than inactive). Active should be lit, not dimmed.                                                                                               |
| M7  | `Composer.svelte:172` talkback label                                          | **Five different colorful emoji** (🔴/🔄/📤/🔈/↩) in state chips break the monochrome aesthetic. Lucide icons everywhere else; use them here too. Reserve emoji for identity (🪶 model tier is fine).                                                   |
| M8  | sidebar header buttons vs sidebar toolbar buttons                             | **Header buttons are h-11 rounded-xl bordered; toolbar buttons are h-7 borderless.** Two languages in the same vertical strip.                                                                                                                          |

### LOW

| #   | Component                                     | Issue                                                                                                                                                                                                                        |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | `ThreadsSidebar.svelte:250` counter pill      | **`rounded` (8px) `border-zinc-900 bg-zinc-950`** — border is one shade lighter than bg, invisible. Make it `rounded-full bg-white/[0.06] no border`.                                                                        |
| L2  | brand-new "New thread" sidebar entry          | **Empty fresh-created threads appear in the sidebar before any message.** ChatGPT/Claude don't list them until the first send. Clutters the list.                                                                            |
| L3  | sidebar row `transition: all` vs inline 200ms | **Two transition curves on one hover** (`transition-all` Tailwind default + the 200ms inline rules). Feels mushy.                                                                                                            |
| L4  | `MessageFeed.svelte:100` greeting             | **"Hey Captain — what's on your mind?" uses default tracking** while the wordmark above uses `tracking-tight` and the bubbles use `tracking-[-0.005em]`. Most important empty-state line gets the least-considered tracking. |

### Radius zoo (system-level)

We currently use **7 distinct border-radius values**: 6 (md) · 8 (lg/rounded) · 12 (xl) · 13 (`0.8rem` tactile) · 16 (2xl) · 24 (3xl) · 9999 (full). Collapse to **4**:

- `rounded-lg` 8px — tiny chips, footer buttons
- `rounded-xl` 12px — icon buttons, thread rows
- `rounded-2xl` 16px — popovers, user bubble, composer card
- `rounded-full` — name pills, send/voice FAB, counters

Drop `rounded-md` and `rounded-3xl` from the codebase.

### Border idiom (system-level)

Pick one and use everywhere:

- `border-white/[0.06]` resting chrome
- `border-white/[0.08]` elevated surfaces (popovers, composer, user bubble)

**Kill every `border-zinc-XXX`** in the chat surface — they're holdovers from a Console-density era. Current uses found: `border-zinc-700/60`, `border-zinc-800`, `border-zinc-800/50`, `border-zinc-900`.

---

## 4. What flagship apps actually do (research distilled)

The qualitative patterns are trustworthy; specific percentages from the research are **fabricated** by Perplexity's deep-research mode and have been removed.

### Typography

- **ChatGPT** = Söhne (commercial grotesk). **Claude** = Inter-ish. **Gemini** = Google Sans (Material 3). **Perplexity, Grok, Mistral, Poe** = system-UI or Inter-style. Our `Inter Variable` is in good company.
- **Chat body 14–16 px / line-height 1.4–1.6**. We render `text-[14px]` body — good.
- **Composer input 13–15 px** — equal to or slightly _smaller_ than body, keeps draft subordinate to conversation. We use `text-[16px]` — that's right for iOS-no-zoom but visually slightly oversized vs flagships. Consider sm:text-[15px] on desktop.
- **Sidebar labels 12–14 px**. We use `text-xs` (12px) — fine.
- **Mono = code only.** Not labels, not metadata. We finished this in refactor slice 6 — confirmed.
- **ALL-CAPS reserved for micro-badges** (`BETA`, `LIVE`, `DEEP RESEARCH`) with ~0.08-0.12em tracking. We use it on a few sidebar labels; modest, fine.

### Layout

- Sidebar **260-320 px** width. Ours: `w-72` (288 px) — right in the band.
- Sidebar solid backgrounds, no flagship uses blur/glass. **Ours uses `backdrop-blur-2xl` — we're an outlier here.** Could be a deliberate differentiator (matches our glassy composer/popovers); just know it.
- Chat = **flat cards, NOT bubbles**. Universal. Ours: assistant flat ✓, user bubble ✗ (we still use a bordered bubble — see M4).
- Composer **pill-shaped, fixed bottom, send right / attach left**. Universal. Ours: ✓.
- Model picker = header dropdown (ChatGPT, Claude) / mode chips (Gemini) / full home screen (Poe). Ours: header chip popover — same as Claude/ChatGPT.

### Color

- **Backgrounds NEVER pure black** — flagships use `#101010` to `#18181B`. We use `#0e0e11` and `#050505` — slightly darker than the band but close. The aurora layer compensates by adding ambient warmth.
- **User vs AI distinction via subtle tint + indent**, not color blocks. Ours: assistant flat under name-tag ✓, user bordered + indented right ✓ — the visual idea is right; just the material is wrong (M4).
- **Brand accent SPARING**, used on send button + active states + brand identity. We do this correctly already (magenta only on Den, name-tag, send FAB, thinking glow).

### Animation

- **150-250 ms ease-in-out** is the universal range. Spring physics emerging in Gemini Neural Expressive (200-300 ms). Ours: 320 ms cubic-bezier on sidebar slide — slightly slower than flagship, feels intentional. Hover transitions 200 ms — right.
- **All flagships respect Reduce Motion.** We do, via `@media (prefers-reduced-motion)` in SullyAvatar.

### Iconography

- ChatGPT, Claude, Perplexity, Poe (web) = custom or Lucide/Heroicons-style.
- Gemini = Material Symbols. Cursor/Replit/v0 = mixed UI + dev-specific.
- **Stroke weight ~1.5 px universal default.** Ours: Lucide default (~2 px) — slightly heavier than flagship. Worth noting but not a fix.
- **Filled vs outline = state semantic.** Outline = inactive, filled = active. We use this on the Den row.

### Mobile ↔ desktop

- Persistent sidebar desktop → drawer or bottom-tab on mobile. Our drawer is correct.
- **Heavy active-work is desktop-first** (Claude Artifacts, Replit Canvas, Cursor visual editor). Mobile is for **triggering, monitoring, approving** dispatched work — not authoring it. This squares with operator's "I want voice + chat + small sidebar on mobile" instinct.

### Active-work UI affordances (the differentiator)

Three patterns the flagships use:

1. **Side-panel artifact** (Claude Cowork, Cursor, Replit Canvas, v0). Chat narrates left, artifact lives right, persistent, sometimes auto-opens on structured output.
2. **Inline progress chips + rich result cards in-flow** (ChatGPT Code Interpreter, Custom GPT actions). Logs and results co-located in the chat thread.
3. **Separate task/board view + remote control** (Gemini Spark Tasks, Replit Plan→Build, Perplexity Deep Research stages). For long-running agentic work, status stages plus "watch the AI work" + takeover.

**Triggering**: implicit (auto-detected) for fast/cheap tools; explicit toggle for slow/expensive agentic ones. Our `@cc`/`@agy` triggers + autonomous Sully dispatch gate are in this same shape.

---

## 5. Universal safe defaults (adopt unless we have a reason)

These are what ALL flagships converge on. Any deviation from these should be deliberate:

1. Three-region desktop layout (sidebar / chat / optional right panel)
2. Sticky composer at bottom, pill-shaped, send right / attach left
3. Flat message cards, not bubbles
4. Body 14-16 px / line-height 1.4-1.6, +1 step on mobile
5. Streaming token-by-token, viewport anchors to bottom, "jump to latest" pill when scrolled up
6. Tap-to-switch-thread, no transition needed (responsiveness > polish)
7. Hover/tap reveals message-level toolbar (copy / regen / etc.)
8. Light/dark + system-match toggle
9. Sidebar 260-320 px with collapse
10. Tool invocations render as inline cards with origin icon + summary + result block
11. 44-48 px touch targets on primary mobile controls
12. OS Reduce Motion respected

We meet most of these. Gaps: #1 right panel (intentionally deferred — see §7), #8 light mode (we're dark-only and probably staying that way), #11 partial (message-footer buttons are 25px — fix M5).

---

## 6. The spaces/projects decision — the operator's biggest question

### What the operator said

> "For most of these the projects/spaces are in a different page entirely. So we would need to add another surface so the app doesn't become full of bloat and consists of only the voice mode and the chat interface with a little sidebar."

### What the research found

The "most apps put projects on a different page" premise is **wrong**. NO flagship app puts projects on a separate top-level surface successfully:

| App                    | Project / Space surface                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ChatGPT Projects       | Sidebar section under thread list. Filters threads, doesn't replace chat. Project banner at top of chat. (Tried a separate page in beta; reverted.)          |
| Claude Projects        | Invisible context modifier — no dedicated UI section at all. Created via AI suggestion. (Has notable discoverability problem — even Anthropic acknowledges.) |
| Perplexity Spaces      | Sidebar section, collapsible. Threads + linked Collections in one view.                                                                                      |
| Perplexity Collections | **Separate top-level tab** — but for **knowledge bases**, not project containers.                                                                            |
| Gemini Gems            | Small icons in sidebar; open as a side-panel overlay, generate new threads.                                                                                  |
| Mistral Agents         | Buried in the input-bar dropdown. Power-user-only.                                                                                                           |
| Poe Bots               | Sidebar section, but selecting a bot **replaces the chat entirely** — stovepiped.                                                                            |

**Convergent industry pattern**: sidebar-inline filtering that doesn't hijack the chat. Separate surface was tried and abandoned. Reported reason: "kills workflow momentum."

### Why this matters more for OUR app

Active-work apps need **persistent awareness of background tasks**. If the operator dispatches CC and switches to a new thread, the "CC is working on PR #181" status needs to stay visible — a separate-surface architecture can't show that while the user is in chat. This is the strongest argument against a separate page for our use case.

### Recommendation (open to challenge)

Keep projects/spaces **sidebar-inline**, not on a separate page. Specifically:

- **Sidebar header** = current (Sully mark + new-thread Compass + close) but **fix M1-M3 above**.
- **The Den** = pinned at top, always visible, always "your home thread space" (it's the only auto-promoted thread; everything else is a child of a space or unfiled).
- **Spaces section** below The Den — collapsible per space. Each space has its own row with chevron + name + count. Expanding shows the threads belonging to that space.
- **Active Tasks section** above or alongside Recent — persistent dispatch awareness. Each dispatched job has a row with worker icon + brief + status dot + abort. Clicking jumps to the originating message in its thread.
- **Recent threads** (unfiled) — chronological, beneath spaces.
- **The operator's "small sidebar on mobile" instinct is still right**: on mobile, sidebar is a drawer — opens when summoned, hides for max chat real estate.

What about the "I don't want bloat in the chat surface"? Two answers:

1. **None of the above adds clutter to the chat surface** — it's all in the sidebar drawer, hidden on mobile until summoned.
2. If the operator still wants a _separate_ full-screen surface — that's a legitimate personal-app choice the research can't override, but I'd argue the cost is "you can't see dispatched work running while you're in chat" which seems like a bigger regression than the small clutter of a richer sidebar.

**Alternative if the operator insists on a separate surface**: build it as `/companion/spaces` accessed from a small icon in the sidebar header (NOT a primary tab — that'd flag the app as "project-first" which conflicts with hop-in-and-go). The chat surface stays unchanged. Dispatched-work awareness still goes in the chat-surface sidebar though — it has to.

### What a Space CONTAINS in our app

This is the real design question. Choices, each more expensive than the last:

- Just a thread filter (cheapest — like Claude Projects)
- Filter + space-specific Sully instructions (medium — like ChatGPT Projects sans files)
- Filter + instructions + files + a `space_id` on the `chat_messages.thread_id` (rich — like ChatGPT Projects full)

For a personal active-work app, I'd argue **medium** is right: filter + space instructions ("This space is for Treehouse — assume context about the build"). Files belong at the OS layer (he already has the file_read tool, the machine is the file system).

### What about AI-suggested space promotion?

Cursor's pattern: when a conversation gains traction in one direction, the AI offers to promote it ("This is becoming a real refactor — make it a Project?"). Operator already brought this up in earlier sessions ("Sully should suggest making a proper project space for the thread"). This is a high-ROI feature — adopt it.

---

## 7. The active-work identity — what to adopt

The operator's identity claim: _"We're building an app that actually does work. Claude Cowork/Code requires setup and navigation. Ours is hop-in-and-go."_ The research suggests specific affordances that reinforce this.

### Adopt now (high ROI)

1. **Persistent "Active Tasks" sidebar section** — survives thread switches. Each dispatched job: worker icon (CC/GMI/AGY) + 1-line brief + status dot (amber=running, green=done, red=failed) + abort. Click jumps to originating message. This is the single most important active-work UI primitive missing today.
2. **Inline tool-call chips with backlink** — when Sully calls a tool (web_search, read_file, dispatch), render an inline chip in the message stream + a persistent reference in the sidebar's Active Tasks. We have the inline chips ✓, missing the persistent reference.
3. **AI-suggested context promotion** — Cursor pattern. When a conversation in The Den shows pattern signals (e.g., 5+ messages about the treehouse), Sully offers: "Make a space for this?". Operator approves with one tap.
4. **Status-stage display for long work** — Perplexity Deep Research pattern. Don't show "Sully is thinking" indefinitely; show "Searching the web... → Reading source... → Drafting reply...". We have the spine for this (`hasActiveToolCalls` + tool-call chips) — needs the stage labels.
5. **Diff + accept/reject hunks for code changes** — Cursor Agent Review. When a dispatched worker returns code, render the diff with per-hunk accept controls, not a wall-of-text reply. Bigger build but matches the active-work identity.

### Adopt later (medium ROI)

6. **Right-side artifact panel** — Claude Cowork pattern. For dispatched work in progress (CC editing a file), the chat narrates on the left, the file/diff/preview lives on the right, slides in on structured output. **Desktop-first**; collapsed to a thumb tab on mobile or hidden entirely. Bigger build.
7. **Static-result + "switch to interactive"** — ChatGPT Data Analysis. Render a fast static preview (e.g., a diff summary or a chart screenshot) first; user opts into the heavier interactive view (the full diff editor or interactive chart). Cheap default, opt-in detail.
8. **Cmd/Ctrl+K command bar** — Claude pattern. Universal action surface: thread search, model switch, dispatch trigger, settings. Keyboard-first power layer. Free on desktop, can collapse on mobile.

### Reject (wrong identity)

9. **Full-screen modals for project setup / configuration** — destroys hop-in-and-go.
10. **Per-action permission prompts for every background operation** — "users disable background scanning after a few prompts." Permissions should be tiered/onboarded once.
11. **Tool-centric navigation (Poe-style bot grid as home)** — forces the user to pick a tool before they have a task. Wrong identity for a personal companion.
12. **Discovery-only-via-AI-suggestion** (Claude Projects' fatal flaw) — even elegant features go unused if there's no visible inline entry. Suggestions are a nudge, not the only path.

---

## 8. What's missing (gaps the audit found we don't have yet)

- **Persistent sidebar at desktop on first load** (fix the bug, then this becomes default).
- **Settings entry point** — no visible affordance for `/settings` from the chat surface. The sidebar footer is the natural home.
- **A real Spaces surface** (the operator's actual ask — addressed in §6).
- **Active-task indicator** that survives thread switches (§7 #1).
- **Empty-state suggestion chips** — "Hey Captain — what's on your mind?" lands with nothing to do. Big-three apps offer 3-4 starter prompts. Spec already mentions this.
- **Memory transparency callouts** (Mistral pattern) — when Sully uses a remembered fact, show a small chip ("From your 2026-05-20 note") linked to the source. Reinforces the active-companion identity.
- **AI-generated thread titles editable from sidebar** (Perplexity-only feature, easy ship, removes friction).
- **Clipboard-fallback feedback** — currently Copy gives a red toast on iOS failure; should still flash "Copied" even if the clipboard write failed silently.

---

## 9. The recommendation matrix (executive view)

| Decision             | Today                  | Recommendation                                             | Cost  | Rationale                                                                                                                                          |
| -------------------- | ---------------------- | ---------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spaces home          | Just The Den pinned    | Sidebar-inline spaces + The Den + Active Tasks (§6)        | MED   | Universal flagship pattern; required for active-work persistence; operator's instinct about "separate page" is contradicted by every shipping app. |
| Spaces contents      | n/a                    | Filter + per-space Sully instructions                      | MED   | Files belong to the OS (we have file_read); instructions reinforce companion identity.                                                             |
| Space creation       | Manual only (future)   | Manual + AI-suggested promotion (Cursor)                   | MED   | High ROI — operator already wanted this.                                                                                                           |
| Sidebar bug          | Broken on desktop      | Fix one-line                                               | XS    | Functional regression I introduced; needs operator green light per "no code" rule.                                                                 |
| Popover idiom        | Two languages          | Apply model-picker recipe to thread-options + all popovers | S     | Premium feel; H2 is the operator's flagship sidebar complaint.                                                                                     |
| Sidebar Sully mark   | h-7 mismatch           | h-8 to match chat header                                   | XS    | Polish; M1.                                                                                                                                        |
| Sidebar footer       | Dev label              | Profile/settings chip OR hide                              | S     | H3; companion-ui-design discipline.                                                                                                                |
| Toolbar row          | Floating ghosts        | Collapse into sidebar kebab; kill Clear-all                | S     | M3; foot-gun removal.                                                                                                                              |
| User bubble material | Opaque card            | Glass to match composer                                    | XS    | M4; consistency.                                                                                                                                   |
| Action-button size   | 25px (sub-WCAG)        | 36px icon-only on mobile                                   | XS    | M5; a11y.                                                                                                                                          |
| Emoji state labels   | 5 colorful glyphs      | Lucide icons; emoji for identity only                      | XS    | M7; aesthetic.                                                                                                                                     |
| Radius zoo           | 7 values               | 4 values                                                   | S     | System cleanup.                                                                                                                                    |
| Border idiom         | zinc + white-alpha mix | white-alpha only                                           | S     | Kill Console-era leftover.                                                                                                                         |
| Active Tasks panel   | None                   | Sidebar section; survives thread switch                    | MED   | §7 #1; biggest active-work miss.                                                                                                                   |
| Empty-state chips    | None                   | 3-4 starter suggestions                                    | S     | Adoption / discoverability.                                                                                                                        |
| Right artifact panel | None                   | Future — desktop-first                                     | LARGE | §7 #6; ROI medium; defer.                                                                                                                          |
| Cmd-K bar            | None                   | Future                                                     | MED   | §7 #8; useful, not urgent.                                                                                                                         |

---

## 10. Open questions for the operator

Before any code:

1. **Spaces direction**: comfortable with sidebar-inline (recommendation §6) or do you still want a separate `/companion/spaces` surface, knowing the research argues against it?
2. **Active Tasks panel placement**: above The Den (always-on awareness) or below Recent (out-of-the-way until needed)?
3. **AI-suggested space promotion**: opt-in dialog ("Make this a space?") or auto-promote silently with a "moved to space X" toast?
4. **Right artifact panel**: do you want this eventually (§7 #6), or is "results inline in the chat" enough? Affects whether we design for a 3-region surface.
5. **Settings entry**: replace the dev footer with a profile/settings chip, or hide the footer entirely and reach settings via Cmd-K only?
6. **The desktop sidebar bug**: green-light the one-line fix now, or batch it with the larger sidebar cleanup?

---

## 11. AGY's parallel view + triangulation

AGY's review is at `peer-reviews/companion_peer_review.md` (Antigravity / Gemini 3.5 Flash-Lite, dated 2026-06-01). Different model class than CC's pass (smaller / shallower), so the audits hit different layers. Cross-check below.

### Where AGY agrees with CC (high confidence — both passes independently arrived here)

- **Sidebar footer is wrong.** CC said "dev-overlay chrome on a premium surface"; AGY found the more concrete problem: **the port number `18080` is factually WRONG** (companion runs on `18769`). Verified at `ThreadsSidebar.svelte:326`. Both fixes converge: replace the footer with a settings gear + profile/identity chip; kill the dev label.
- **Settings access is missing.** Both recommend a gear icon in the sidebar footer linking to `/companion/settings`.
- **Empty-state suggestion pills** — both recommend the ChatGPT/Claude pattern (3–4 starter prompts in the landing).
- **Chronological thread grouping** (Today / Yesterday / Previous 7 Days) — AGY recommends; CC didn't flag explicitly but agrees on review. Adding to the matrix.

### Where AGY caught things CC missed (genuine new wins — verified)

- 🔴 **An orphaned `/settings` page already exists.** `src/routes/settings/+page.svelte` is 81 lines, fully implemented: autonomy toggle (Ask / Auto-for-safe / Full-auto) + dispatch meter (count, wall-clock, used/cap). **Zero links to it from `src/`.** Verified via `grep -r "/settings"` — only backend usages of `getSetting()`, no navigation. **This changes one recommendation**: we don't need to BUILD a settings page, we need to LINK to the existing one + restyle it to match the brand (it uses `fuchsia-*` Tailwind tokens; should use `--color-brand`).
- 🟡 **Workspace Context Modal doesn't respond to Escape.** Model picker and thread-options popovers do. Accessibility / convention miss.
- 🟡 **`aria-label="Close sidebar"` is duplicated** on the backdrop overlay AND the explicit close button. Screen readers announce them identically.
- 🟡 **Model picker popover overlaps the central Sully orb / landing header** at certain viewport heights. Visual collision. Fix: increase popover opacity or hide the orb while popover is active.

### Where CC caught things AGY missed (these stay on the table)

AGY's review stayed at button-by-button surface interaction (which makes sense for the Flash-Lite model class). The structural and systemic issues need deeper code analysis. AGY did NOT flag:

- The **desktop sidebar invisible-on-first-load bug** (CC §1, HIGH severity — AGY tested mobile flow only).
- The **two popover languages** (model-picker glass vs thread-options opaque) — CC H2; this is the operator's flagship sidebar complaint, and arguably the highest-visibility inconsistency.
- The **sidebar Sully mark 4px smaller** than chat-header Sully mark (CC M1).
- The **user-bubble material** mismatch with composer glass (CC M4).
- The **action-button tap targets** at 25px (sub-WCAG, CC M5).
- The **session-options kebab** breaking the row's chrome language (CC M2).
- The **toolbar row** "Show archived / Clear all" being floating ghosts (CC M3).
- The **counter pill** invisible border (CC L1).
- The **emoji-state-label** monochrome break in Talkback (CC M7).
- The **radius zoo** (7 values) and **border idiom** (zinc + white-alpha mix) systemic drift (CC §3 footer).
- The **spaces decision** entirely — AGY didn't research the IA question, has no opinion on separate-surface vs sidebar-inline.

### Where AGY's read is meaningfully different from CC's

AGY's tone is more positive overall — "world-class," "stunning," "Masterpiece," "Highly Cinematic." Some of this is genuine (Canvas/Artifacts side panel, the dual voice modes, the autonomy controls _if_ they were discoverable). Some is marketing-toned and not actionable. **Where AGY is right that CC under-credited**:

- **Canvas/Artifacts is a real shipped feature.** CC didn't engage with `Canvas.svelte` in the audit — it IS a Claude-Cowork-style side panel that opens from `Markdown.svelte`'s `oncanvas` callback. We're closer to flagship parity on the "active-work artifact panel" than CC's recommendation matrix implied. **Updating §7 #6**: this is "polish + integrate" rather than "future build."
- **Voice mode parity is real.** Talkback continuous mode + the full-screen immersive Voice Mode together give Sully a competitive footprint Pi/ChatGPT match, but Claude doesn't have. Worth keeping in mind for messaging when we describe the app.
- **Autonomy controls are unique** — they exist (in the orphaned `/settings`), they just aren't surfaced. That's a one-day "wire it up" effort, not a new build.

### Updated recommendations from AGY's pass

Adding to §9 matrix:

| Decision                       | Today                                   | Recommendation                                                    | Cost | Source                                               |
| ------------------------------ | --------------------------------------- | ----------------------------------------------------------------- | ---- | ---------------------------------------------------- |
| `/settings` page               | Built, orphaned                         | Wire it via gear icon in sidebar footer + restyle to brand tokens | XS   | AGY (verified)                                       |
| Footer port                    | Hardcoded `18080` (wrong)               | Replace with dynamic or kill the line                             | XS   | AGY (verified)                                       |
| Chronological thread grouping  | Flat by recency                         | Group by Today / Yesterday / Previous 7 Days                      | S    | AGY (matches ChatGPT/Claude/Perplexity)              |
| Workspace Context modal Escape | Doesn't close                           | Add Escape listener (same as popovers)                            | XS   | AGY                                                  |
| Duplicate `aria-label`         | Backdrop + button share "Close sidebar" | Differentiate (`Dismiss sidebar overlay` vs `Close sidebar`)      | XS   | AGY (accessibility)                                  |
| Model picker / orb collision   | Popover overlaps landing orb            | Bump popover bg opacity OR hide orb when any popover open         | S    | AGY                                                  |
| Canvas / Artifacts panel       | Built, integrates from Markdown         | Surface visibly + add a header chip when content is canvas-able   | S    | AGY (re-prioritized from "future build" to "polish") |

### Net effect of AGY's pass on direction

- One straight bug fix (port `18080` → real port).
- One "find money in the couch" win — the `/settings` page already exists; we wire it instead of building it.
- Two small a11y fixes (Escape + duplicate label).
- Three small UX polish items (thread grouping, orb collision, suggestion pills).
- Confirms two CC recommendations independently (footer, settings gear).
- Does not move CC's recommendation on the **spaces decision** (AGY didn't address it).
- Does not move CC's recommendation on the structural inconsistencies (AGY didn't catch them) — but doesn't argue against them either.

The two views are complementary rather than contradictory. AGY mapped the surface; CC mapped the structure. The combined picture is stronger than either alone.

---

## Source files

- Visual audit screenshots: `/home/dreighto/dev/.playwright-mcp/sidebar-audit/01–22-*.png`
- Visual audit findings: this doc, §1–3
- Research (visual): summarized in §4–5; raw at `/home/dreighto/.claude/projects/-home-dreighto-dev/75ae061d-34a4-4f41-9b7e-85db24575151/tool-results/mcp-perplexity-perplexity_research-1780332388298.txt`
- Research (IA): summarized in §6; raw at `/home/dreighto/.claude/projects/-home-dreighto-dev/75ae061d-34a4-4f41-9b7e-85db24575151/tool-results/toolu_011nQtsYNZcqFS3ESMhskBbv.txt`
- All Perplexity-fabricated statistics are excluded from this synthesis. The qualitative patterns are sound.
