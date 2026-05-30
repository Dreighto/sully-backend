# CC Synthesis of Codex Refactor Proposal — LogueOS-Companion

Date: 2026-05-30
Reviewer: CC (Claude Code)
Sibling file: `2026-05-30-codex-refactor-proposal.md`
Method: every load-bearing claim in Codex's review was verified against the live repo at `8141ba2` before grading. Approvals are evidence-backed, not vibes. No code edits made in this pass — proposal only.

---

## Plain-English summary for the operator

Codex's review is solid. I checked every claim it made against the actual code and it was accurate everywhere it counted. Its overall thesis — "stop letting the same 1,700-line page and two big API routes own everything; carve them into small testable pieces" — is the right next move for the companion. I'd do **four of the six findings now**, **modify one**, and **push back on one as already wrong/done**.

The single most important thing it caught that I missed in flight: **the companion model still identifies itself as "the operator's planning partner inside LogueOS Console" in its own system prompt**, and the default workspace is still `LogueOS-Console`. The companion has been the operator's voice partner for a week, but its own personality file still thinks it's the Console. That's a 30-line fix and it should land before any refactor — it's been visibly wrong every conversation since the voice ship.

Beyond that, the right order is: **identity fix → server turn service → model catalog → page decomposition (already on the todo list as Task #11) → voice service split → test harness**. I'd skip Codex's "Phase 0 hygiene" (prettier-write across 39 files muddies every blame line on real changes — fix in-line as files get touched).

No code changes here. Awaiting greenlight on the sequenced plan below.

---

## Per-finding verdict

| # | Finding | Verdict | Why |
|---|---------|---------|-----|
| 1 | `+page.svelte` owns too many behaviors (1,767 LOC) | **KEEP, partly already in flight** | Verified accurate. This was already Task #11 ("decompose chat/+page.svelte"); Codex's proposed split (streaming / composer / threads / slash) is a sharper plan than what I'd outlined. Adopt his shape. |
| 2 | Two POST routes duplicate routing + persistence | **MODIFY** | Verified accurate, but his framing — "collapse to one dispatcher under 200 LOC" — is wrong for the legacy route. The legacy route is still called for polling, image-gen, slug-uniqueness probe, and the `/clear` system marker (lines 462, 581, 994, 1193 in `+page.svelte`). The legacy route is real, not dead code. **Right answer:** keep both routes but extract a shared `chat_turn` service so persistence/classification/history slicing live in one place. Codex's `chat_turn.ts` + `chat_prompt.ts` proposal is exactly that. Just don't expect the line counts he projects. |
| 3 | Provider/model routing duplicated | **KEEP** | Verified. `TIER_MODELS` exists in BOTH `src/lib/server/llm_router.ts:25` and `src/routes/api/chat/sdk-stream/+server.ts:162`, the SDK file's own header comment admits "Mirrors src/lib/server/llm_router.ts so behaviour stays aligned." Voice-reply has a third model-selection path (`COMPANION_VOICE_MODEL`). Real drift risk. `model_catalog.ts` is the right answer. |
| 4 | Voice mode tightly coupled to UI + systemd | **PARTIAL — modify scope** | Server side (split systemd shell-out into `voice_services.ts`): **agree**, small win, easy to test. Client side (split the 745-line `realtime-voice.svelte.ts` into voice-session + voice-audio + voice-stt): **disagree on timing**. That controller was just stress-tested 10/10 plus a hands-free Phase 3 ship; it's freshly proven and not the surface generating bugs. Splitting it for splitting's sake risks regression on a part of the app the operator uses every day. Defer the client split until something concrete (a real bug or a real feature) actually justifies it. |
| 5 | Clone residue (Console wording, default workspace, `/console` URLs) | **KEEP — highest immediate value** | Verified. The companion's own system prompt says **"You are the operator's planning partner inside LogueOS Console"** in both `sdk-stream/+server.ts:260` AND `+server.ts:28`. Default `selectedRepo = 'LogueOS-Console'` in `+page.svelte:53`. Sidebar still shows "CORE: LogueOS-Console" in `ThreadsSidebar.svelte:292`. Push notifications still deep-link to `/console/chat`. This isn't aesthetic — the companion is being told it's the Console, every turn. This is the cheapest finding to fix and it has the loudest behavioral payoff. Move it to the top. |
| 6 | No test harness | **KEEP — but lighter scope** | Verified — `package.json` has no `test` script, no `tests/` or `__tests__/`, no Vitest. Just shipped voice Phase 2/3 and the tools layer without any automated regression — that was a real risk. Worth fixing. Disagree with Codex's "do the test harness in Phase 0 across all targets"; right move is **add Vitest with the test suite that protects each refactor as it happens**, not a giant up-front harness. First tests: `runMode` matrix, `model_catalog` defaults, `chat_turn` persistence. Skip the voice tests until the server split lands. |

---

## What Codex got right that I'd missed

1. **The identity bug** (#5). I shipped voice + tools + cloud and never re-read the system prompt that ships in every chat. The companion has been told it's the Console for every conversation since clone-then-fork. Highest payoff for smallest patch.
2. **Three model-selection paths drift independently** (#3). I added `companion-v1-voice` to voice-reply, added cloud models to `model-choices.ts`, and the SDK route's `TIER_MODELS` still mirrors a kernel module that has its own copy. A "make GPT-OSS the default cloud" change today has to remember three places.
3. **No tests on a security-sensitive surface** (#6). The companion_tools deny-list passed 16/16 in a one-off script that I deleted after running. That should be a checked-in Vitest, not a script that vanished.

## What I'd push back on

- **Phase 0 prettier-write across 39 files.** It muddies blame on every line for every later change in this refactor sequence. The right move is fix-as-you-touch: any file in a phase gets formatted as part of that phase's PR. (Codex itself flagged that lint fails at the prettier step and said it didn't run `--write` "because this review should stay proposal-only" — agree with that restraint; carry it forward.)
- **Collapsing both routes into "a dispatcher under 200 LOC."** Legacy `/api/chat` still has live callers (verified above). The right shape is shared services + two thin route adapters, not collapse.
- **Splitting the realtime-voice controller now.** Freshly proven, not the surface generating bugs. Cost > value today. Defer.

## What I'd add that Codex didn't cover

- **The fact that there are no in-flight feature requests blocked by this refactor.** Refactor here is paying down a drift risk, not unblocking a feature. Worth doing, but the operator's call on whether to spend cycles on drift-prevention vs. the next product step (Emma voice clone, in-app voice-sample upload, etc.). If the operator has more product work queued, refactor should slot in around it, not ahead of it.
- **The voice path's deliberate separation from the SDK chat path is a feature, not a bug.** Voice-reply uses raw Ollama `/api/chat` (not SDK `streamText`) because the SDK's data-stream protocol is heavier than what the per-sentence-TTS loop needs. The file's own header documents this. If Codex's `voice_reply.ts` module is built, it must preserve that — do not "consolidate" it onto the SDK stream just because the SDK exists.
- **`Cleanup ③` (Task #11)** is already the in-flight version of Finding #1. The two efforts should merge: my outline + Codex's sharper four-controller proposal = the actual plan.

---

## Recommended sequenced plan

Six small PRs instead of Codex's five large phases. Each is independently shippable, each carries its own test, and each is reversible if something regresses.

| PR | Scope | Touches | Test added |
|----|-------|---------|------------|
| **A. Identity fix (no architecture change)** | System prompt says "your companion" not "inside LogueOS Console". Default workspace becomes "companion" or null. Sidebar "CORE" pill drops the Console name. PWA push deep-links go to `/companion` not `/console`. Add `serverConfig.appIdentity` (Codex's idea — yes). | `+server.ts:28`, `sdk-stream/+server.ts:260`, `+page.svelte:53`, `ThreadsSidebar.svelte:292`, `web_push.ts:139-140`, `completion_poller.ts:61` | snapshot test: prompt never contains "LogueOS Console" in companion mode |
| **B. Test harness baseline** | Add `vitest` + `npm test` script + `tests/` dir + one passing test against `runMode` matrix. No other code touched. | `package.json`, `vitest.config.ts`, `tests/run-mode.test.ts` | green CI baseline |
| **C. Shared chat turn service** | Extract `persistUserTurn` / `classifyAndTouchThread` / `buildRecentHistory` / `persistAssistantTurn` into `src/lib/server/chat_turn.ts`. Both routes call it. Codex's plan with the legacy-route caveat above. | `chat_turn.ts` (new), `+server.ts`, `sdk-stream/+server.ts` | unit tests for each |
| **D. Model catalog** | One `model_catalog.ts` resolving chat + voice models, used by `llm_router`, `sdk-stream`, `voice-reply`, `model-choices`. | `model_catalog.ts` (new), three callers | resolver unit tests (companion default, cloud override, voice model) |
| **E. Client decomposition (= Task #11)** | Codex's four-controller split: `streaming.svelte.ts` / `composer-state.svelte.ts` / `threads.svelte.ts` / `slash-commands.ts`. Markup unchanged. Target `+page.svelte` < 900 LOC. | `+page.svelte`, new files under `src/lib/chat/` | smoke Playwright over the chat-surface-harness skill |
| **F. Voice service boundary** | Server only: `voice_services.ts` wraps systemd shell-out + readiness probe. Hardcoded unit allowlist. `voice-control/+server.ts` becomes thin. **Do NOT split the client controller in this pass.** | `voice_services.ts` (new), `voice-control/+server.ts` | mocked execFile tests for start/status/stop |

PRs A and B are <1-hour each and trivially reversible — those should land first. C–F are real but bounded and can be queued behind any product work the operator has.

### Why this order

- **A first** because it's high-payoff/low-cost and visibly improves every conversation immediately.
- **B second** because the next four PRs all need a place to put their tests.
- **C before D** because the catalog module is one of the things `chat_turn` will consume.
- **E and F are independent** of each other and can interleave with product work.

### What's NOT in the plan (deferred)

- Splitting `realtime-voice.svelte.ts` — defer until a real bug or feature demands it.
- Repo-wide prettier-write — apply per-file as files are touched.
- A separate "kernel residue fence" sweep — partially absorbed into PR A; the rest is cosmetic and survives.

---

## Guardrails (echoing Codex's)

- Do NOT combine visual redesign with structural refactor (E especially).
- Preserve the fresh-DB bootstrap behavior in `bootstrap.ts`.
- Preserve the `x-companion-tools-key` unlock-code gate on `sdk-stream` exactly as-is (added 2026-05-29).
- Preserve the voice-reply path's deliberate raw-Ollama shape — do not "modernize" it onto the SDK stream.
- Voice services systemd allowlist stays hardcoded inside `voice_services.ts`, never config-driven from the wire.
- Keep wired mode runnable as a parity harness; don't delete it.

---

## Bottom line

Codex's review is grounded and the proposal is the right direction. The synthesized plan above keeps the substance (shared services, model catalog, client decomposition, voice server boundary), corrects two execution details (the legacy route can't be collapsed, the client voice controller shouldn't be split today), and front-loads the one finding (the identity bug) that's already costing the operator on every turn. Six small PRs replace five large phases.

Awaiting operator greenlight on the order — or a redirect (skip refactor entirely, do product work, do only PR A, etc.).
