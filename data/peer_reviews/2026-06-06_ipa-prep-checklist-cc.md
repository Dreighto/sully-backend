# IPA Pre-flight — Sully Work Surface doctrine pass

**Status when written:** main at `9fc4644` (DPSK review docs) · last 3 CI runs green
(`6c4f1e4` a11y, `67314e5` GMI pulse-binding, `de53c5d` AGY subtraction).

**Doctrine pass implemented + verified.** The card glance now answers the two
glance questions cleanly. CC has independently verified via Playwright at iPhone
390px viewport: hero ring renders + state-bound color shift, worker rows render
flat with state-bound waveforms, pulse animations gate on `isInMotion`, ownership
banner gone on terminal states, indicator pill renders zero DOM when idle.

This checklist is what the operator (or me, on operator's go) walks through to
get the build to TestFlight.

---

## What the chain shipped this cycle

5 commits on `main` between `9af6148` (doctrine canon) and `9fc4644` (DPSK
review docs):

| Commit    | What                                                                                         | Verifier                                                             |
| --------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `de53c5d` | AGY: 5-change subtraction (pill absent, glance reshape, ring, worker rows, accordion demote) | CC grep traps + svelte-check 0 errors                                |
| `67314e5` | GMI: pulse animations state-bound + ownership-banner gone on terminal                        | CC verified `isInMotion` derivation + `class:in-motion` applied      |
| `6c4f1e4` | CC: a11y attrs on SurfaceProgressRing + WorkerRow (GMI skipped Issue 2)                      | Playwright DOM read `aria-label="20% complete · ..."` + `"AGY idle"` |
| `9fc4644` | DPSK review docs (SHIP-WITH-NITS, gap honestly noted)                                        | n/a — docs only                                                      |

---

## Chat-integration (must happen BEFORE the IPA build)

The work-surface components are SHIPPED on `main` but NOT yet wired into the
real chat surface. The user-facing IPA needs the indicator next to the chat
composer. Exact mount point + props:

**File:** `src/routes/chat/+page.svelte`

The `<Composer />` is mounted around line 922 (search for `<!-- Drag-and-drop overlay`).
The WorkSurfaceIndicator should mount **adjacent to** the Composer, OR within the
Composer's existing right-side button cluster (Send / Voice / Talkback / Sparkles)
between the textarea and the send button.

**Suggested mount** (inline next to the composer, as a sibling — keeps
WorkSurfaceIndicator a standalone component, no Composer changes):

```svelte
<!-- in src/routes/chat/+page.svelte, near the Composer mount -->
<script>
	import WorkSurfaceIndicator from '$lib/components/WorkSurfaceIndicator.svelte';
	let dockMode = $state<'badge' | 'rail' | 'sheet'>('badge');
	let dockOpenSurfaceId = $state<string | null>(null);
</script>

<!-- existing Composer mount stays -->
<Composer ... />

<!-- new — adjacent to Composer, before/below it -->
<WorkSurfaceIndicator bind:mode={dockMode} bind:openSurfaceId={dockOpenSurfaceId} />
<WorkSurfaceDock bind:mode={dockMode} bind:openSurfaceId={dockOpenSurfaceId} />
```

**Important:** the dock no longer auto-appears (`absent when idle` per doctrine).
The indicator is the SOLE entry point. When the chat is at rest with no
dispatches running, neither the pill nor the dock will appear — only when a
surface exists in the store.

**Spawning surfaces from the dispatch flow** (a real chat dispatch creates a
surface row): this is the `decide()` → `spawnSurface()` wiring that already
exists in `src/lib/data/surfaces.svelte.ts`. The current Sully decide-loop in
the chat path needs to call `spawnSurface()` when it decides 'Dispatch.' That
wiring is **not part of this pass** but is the gate between "indicator appears
in the running app" and "indicator is decorative."

---

## TestFlight build pre-flight

### Pipeline choice (operator must pick one before next ship)

Per CDX's earlier CI/CD audit at `data/peer_reviews/2026-06-06_ci-cd-audit-cdx.md`,
**two pipelines can build the IPA** and that's the biggest documented risk:

1. **Codemagic** (`codemagic.yaml` + `tools/trigger-ios-build.sh`) — operator's
   historical path. Stable signing key + cert `6QD846B8Y2` (see memory
   `reference_codemagic_sully_signing.md`). The `ci-ios-patch.sh` injects the
   Capacitor 8 `didRegisterForRemoteNotifications` AppDelegate fix (see memory
   `project_sully_apns_push.md` — without this patch APNs registration silently
   fails).
2. **GitHub Actions** (`.github/workflows/ios-testflight.yml`) — alternative
   path. Last 2 successful runs: 2026-05-31 (`26702273221`, `26719050674`).

**CC recommendation: stick with Codemagic** — it has the documented stable key,
the proven patches, and the operator's muscle memory. Demote GH Actions to
keepalive-only.

### Pre-flight checks (run before triggering)

```bash
# 1. main is clean + at the expected commit
cd ~/dev/LogueOS-Companion
git fetch origin -q && git status -sb
# Expected: "## main...origin/main" — no "behind" / "ahead"

# 2. svelte-check 0 errors on main (CI gate)
npm run check 2>&1 | grep -E "ERROR\b|COMPLETED" | tail -1
# Expected: "0 ERRORS"

# 3. CI on the latest main push is green
gh run list --repo Dreighto/LogueOS-Companion --limit 1 --json status,conclusion -q '.[0]'
# Expected: {"status":"completed","conclusion":"success"}

# 4. chat-integration is wired (the dock + indicator are mounted in chat/+page.svelte)
grep -E "WorkSurfaceIndicator|WorkSurfaceDock" src/routes/chat/+page.svelte
# Expected: imports + mounts present (currently NOT done; see "Chat-integration" above)

# 5. iOS-patch script present + executable
ls -la tools/ci-ios-patch.sh tools/trigger-ios-build.sh
```

### The trigger (when ready)

```bash
# Codemagic build, default Sully workflow
bash ~/dev/LogueOS-Companion/tools/trigger-ios-build.sh
```

The script handles the stable signing key + the AppDelegate patch via
`ci-ios-patch.sh`. Build numbers auto-increment via Codemagic.

### After the build is in TestFlight

- Install on physical iPhone via TestFlight
- Verify the indicator is absent when chat has no dispatches running
- Send a "do a thing" message that triggers a Dispatch → indicator pill appears
  in the composer area
- Tap the indicator → sheet opens with the ring + worker rows + accordions
- Verify Tony-Stark-tier reads on a real device (the doctrine is a phone-first
  spec, not a desktop spec)

---

## Out-of-scope but worth noting

1. **DPSK process gap.** This pass's DPSK didn't open the two new component
   files despite the prompt listing the paths. The aider context didn't follow
   through. Next DPSK prompt should: (a) explicitly list each file with its
   exact path, AND (b) require DPSK to quote a snippet from each file as proof
   of reading. Saved as a refinement candidate for the next verifier dispatch.
2. **GMI process gap.** GMI fixed the obvious issue (pulse-binding) and skipped
   Issue 2 (a11y) entirely. The structured stdout summary was empty — GMI didn't
   follow the format. Same refinement candidate: require a per-issue
   acknowledgement, not just a free-form commit message.
3. **Pre-existing tech debt.** `SullyAvatar.svelte` has 8 infinite animations
   from Jun 1. `Composer.svelte` uses `btn-tactile-brand` (invented token).
   Both pre-existing, untouched this pass, candidates for a separate cleanup.
4. **Phase 2 binding work.** Per the locked binding scheme, four animations
   need richer sources: worker waveform amplitude → event count, activity-stream
   → listener event topic, proof checklist → real artifacts, AGY amber-wait →
   elapsed time tiering. Marked as TODO in the components. Implementation
   blocked on a listener event-topic addition (kernel-side work).
