# Work Surface — Research-Driven Polish Brief

**Produced:** 2026-06-06 by a 7-agent research workflow (5 research angles → synthesize → design-director critique).
**Research angles:** agent-work product UIs (Devin/Manus/Factory/LangGraph/Operator) · process-visibility in shipped AI chats (ChatGPT/Claude/Perplexity/Cursor) · node-graph/payload animation · premium "system OS" aesthetics (Linear/Raycast/Arc/Apple) · motion + reduced-motion best practices. 40 patterns gathered.

**Two findings that anchor everything:**

1. **Magenta `#ec2d78` is currently absent from the mock.** The brand identity color isn't used at all — off-brand. Fix = ration it as the _live-attention_ signal, never a theme fill.
2. **`stageProgress` data exists but is never rendered.** The 6-stage timeline — which the research says should be the always-visible **spine** — is dead data. Fix = render it.

**Through-line from the research:** _calm is the premium signal; motion is information, not garnish._ Trustworthy agent UIs animate exactly ONE thing at a time (the live action), keep the plan/pipeline a stable scannable spine, and reserve their accent color for "this is happening now."

---

## Recommendations (apply all six)

### 1. [HIGH] Magenta as a rationed IDENTITY accent (layered over, not replacing, the motion palette)

Add brand tokens. Use magenta `#ec2d78` on **four surfaces only**: (a) the pill + ownership pulse dots, (b) the central TASK-node stroke, (c) the **active** timeline stage marker, (d) the card resting border. **Do NOT** touch the cyan/blue/purple per-motion edge + packet colors. **Never** recolor worker edges or packets magenta. Magenta = "live now," nothing else.

### 2. [HIGH] Render the 6-stage timeline spine from the unused `stageProgress` data

Add a `stageTimeline` flex row of six fixed pills (Read · Research · Build · Check · Approve · Reply) in the compact card, mirrored in expanded. Class per status: `done` = filled muted (+ tick), `active` = magenta fill + visible label, `pending` = hairline outline, `skipped` = low-opacity dashed. Transition only fill + opacity. It must **honour `skipped`** (a linear progress bar can't express skipped — discrete pills can). Stages never resize or reorder.

### 3. [HIGH] Quiet non-primary nodes + cap blur (use the existing primary/secondary split)

On secondary-active workers: ring opacity → `0.1`, `rotateOrbital` → 30s+; **remove `floatNode` from secondary node-groups** so only the primary node drifts; keep a single `coreBreath` on the central core. Keep the keyframes. Also drop the `core-field` blur and cut the card `backdrop-filter` from `25px` → `14px`. (These run on every node — the main motion-noise + mobile cost. Tuning, not a rebuild.)

### 4. [HIGH] One-shot settles for Stopped/Failed/Complete + a hand-off pulse — all reduced-motion safe

Settles fire **once, not looping**: Complete = green ring-converge then hold; Stopped = amber dampen to a frozen frame; Failed = single red core nudge then static. On stage advance, fire **one** payload pulse from the completed edge into the core, then stop. **Neutralise every animation inside a `@media (prefers-reduced-motion: reduce)` block** (the draft missed this — it's required).

### 5. [MEDIUM] Plain-English collapsed pill

Replace the pill's worker short-codes (`collapsedMeta`, ~JS 708-709) with the truncated `activeOwnershipLabel` sentence already used in the ownership banner. One-line swap — propagates the action-plus-item phrasing the rest of the card uses.

### 6. [MEDIUM] Approve gate = calm amber hold; auto-promote pill → compact

At `blocked`/`Waiting`: pacify the graph, tint the gate **amber** (not magenta, not red — red is reserved for Failed), and if the card is collapsed auto-set it to compact so the operator sees what they're approving. Keep magenta off the approval CTA.

---

## Keep intact (do NOT break)

The node-graph structure, the **semantic per-motion palette** (research=blips, build=code-cubes, verify=QA-shield orbit; cyan/blue/purple), the primary/secondary emphasis system, the three footprints, and the verified amber-Stopped / red-Failed / green-Complete settle colors from the last round. This is refinement, not a redesign.

## Brand register

Calm, premium, magenta-as-identity-only, near-black canvas. The Jarvis/FRIDAY "refined instrument panel" register — never the RGB sci-fi-toy register.
