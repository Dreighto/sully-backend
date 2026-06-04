# LogueOS-Companion (Sully) — Session Handoff

**Last updated:** 2026-06-03 (CC) · **`main` HEAD `4deaf2d`.** · **IN REVIEW:** branch `feat/dispatch-task-card` (dispatch Task-card visibility fix) — browser-verified, awaiting operator phone-QA + merge. Read this first. · **Backlog:** `docs/backlog/`.

**To resume:** this file → `docs/CURRENT-STATE.md` / `docs/DOING-NOW.md` / `docs/PLAN.md` → full audit `data/peer_reviews/2026-06-02_companion-audit_findings.md`. `~/.claude/CLAUDE.md` + Orchestrator `AGENTS.md` auto-load. Key memories: `project_companion_repos`, `reference_companion_chat_module_map`, `reference_companion_chat_context_architecture`, `project_sully_apns_push`, `reference_codemagic_sully_signing`, `project_companion_voice_mode`, and ⚠️ `feedback_check_before_asserting`.

Sully = dreighto's personal local-AI companion. SvelteKit (adapter-node, Svelte 5 runes, Tailwind 4) + Capacitor iOS shell. Server `:18769`, base path `/companion`. **Operator = dreighto ("Captain"), non-technical → lead every reply in plain English.**

---

## ⚠️ Operating lessons from this session (don't repeat)

1. **CHECK before asserting.** I stated system behavior from memory 3× and was wrong each time; the operator had to disprove me. Before ANY claim about how the system behaves — read the code / query the journal/DB / `ls` / hit the endpoint, THEN state with the receipt. Contradicting the operator's recollection = STOP-and-verify. (`feedback_check_before_asserting`)
2. **Scope cleanup to your OWN artifacts.** Never blanket-delete to tidy; remove only files you created, by name. (`feedback_scope_cleanup_to_own_artifacts`) The `docs/agy-audit-shots/*.png` in the tree are AGY's — leave them.
3. **Browser-verify UI changes on the real iPhone.** 200-OK + green tests have masked operator-visible regressions here before.

## Current state

- `main`. **The working tree carries several pre-existing, NOT-ours changes** from before this session — `docs/agy-audit-shots/*.png` (AGY's), some `peer-reviews/*` deletions, and `scripts/finetune/train_qlora.py`. Leave them; do NOT sweep them into a commit. Everything from this session's work IS committed + pushed.
- **134/134 vitest pass · `svelte-check` 0 errors** (3 pre-existing warnings: DispatchChips, ImageLightbox a11y).
- Services all **active**: `logueos-companion`, `logueos-companion-tts`, `logueos-companion-stt`.
- **Pushing is fine — it does NOT fire an iOS build.** `ios-testflight.yml` is `workflow_dispatch`/`workflow_call` only. iOS builds go through **Codemagic** via `tools/trigger-ios-build.sh`. The new `.github/workflows/ci.yml` runs check+test on every push (the cheap gate; e2e/Lighthouse deferred per `project_ci_cost_decision_pending`).

## Deploy / verify

```bash
npm run build && sudo -n systemctl restart logueos-companion.service   # after backend changes
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18769/companion/chat   # expect 200
npm run check && npm test   # before committing — both must be green
```

The iOS shell loads the **remote** tailnet URL, so frontend changes reach the phone on app reload — **no iOS rebuild** unless native code changes (push, plugins, icon, permissions). iOS rebuild: `bash tools/trigger-ios-build.sh` (one-time cert reset: `REVOKE_DIST_CERTS=1 bash tools/trigger-ios-build.sh`).

## What shipped this session (2026-06-02 → 06-03)

- **🔵 IN REVIEW — Dispatch Task-card visibility fix** (branch `feat/dispatch-task-card`, commits `3f27189`/`011e799`/`6b9ff42`, **browser-verified, NOT merged**). Fixes the operator's screenshot: the dispatch card span `claude-code working · 39:53` forever and leaked `synthesis_completed {json}`. Root cause = jobs end at status `synthesized` (Phase 3) but the terminal allow-list was only `['done','failed','aborted']`. Fix: shared `src/lib/dispatchActivityView.ts` (`isTerminalStatus` incl. synthesized/verified; `HIDDEN_ACTIONS` deny-list + `friendlyStep` plain-English mapper, generic fallback, never raw verb/target/JSON); SSE stream + reconcile endpoint filter internal events + carry `started_at`/`ended_at`; client (`dispatchStream.svelte.ts`) resolves from server truth on mount (no "working" flash, no live mm:ss — a FROZEN duration), opens NO EventSource for finished cards; `WorkingBubble.svelte` → calm working pulse / compact `✓ CC handled this · Ns` strip / blame-free failed state; `MessageFeed.svelte` renders dispatch rows as ONLY the card (no LOGUEOS text bubble/footer); trace id stripped from the notice text. **Browser-verified** against real synthesized job 66 → renders `✓ CC handled this · 42s` above the answer, no JSON. Plan + design: `docs/superpowers/plans/2026-06-03-dispatch-task-card.md`, `data/peer_reviews/2026-06-03_sully-dispatch-ui-redesign_gpt.md` (GPT-approved). Adversarial review: SAFE TO SHIP. **Deferred (next pass):** ask-before-dispatch tap-to-confirm buttons (works today via typed "yes"); P2 fast-follow on the dormant kernel-wired activity pill. **To QA on phone:** reload the app, open a thread with a past `@cc` dispatch — the old stuck "working" card now shows `✓ CC handled this`. **To merge:** `git checkout main && git merge feat/dispatch-task-card`, then `npm run build && sudo -n systemctl restart logueos-companion.service`.
- **Real Sully synthesis (Phase 3, PR #4, `47d4b9e`, live-QA'd)** — when a worker (CC/AGY) finishes, `closeOutTask` now generates a plain-English summary in Sully's voice (Haiku via `runConsultClaude` + `src/lib/server/routing/synthesize.ts` `SYNTH_SYSTEM`) instead of dumping raw output; best-effort with raw fallback. `closeOutTask` is async; activity route awaits it. Live proof: "@cc run the tests" → _"I had CC run the tests… great news—everything came back clean. All 167 tests passed…"_. Model = Haiku (no local GPU load). **Also fixed a daily-cap over-count regression** (`dispatchBrakes.checkDailyCap`): self-handled turns reach 'synthesized' + expired proposals reach 'aborted', which the status-only filter counted as dispatches (tripped 21/20 on 3 real dispatches) → now counts only `worker!='sully'` excl. 'aborted'.
- **Ask-before-dispatch (Phase 2, PR #3, `9b358b0`, live + voice-QA'd)** — Sully no longer needs `@cc`/`@agy`: she PROPOSES work and dispatches only on a natural-language "yes" (`src/lib/server/routing/confirm.ts` `isAffirmation`; `decide()` returns Dispatch only for @mentions, else Ask; `maybeAutonomousDispatch` stores a 'gated' proposal + consumes/expires it each turn; voice speaks the proposal). Broadened the work-intent gate (investigative verbs: audit/run/review/scan/check…) + an **anti-confabulation prompt guardrail** (`chat_prompt.ts`: she can't claim to do work she never dispatched — fixed a real voice case where she "ran an audit" that never ran). Scorecard 95.9%.
- **⚠️ PARKED: iOS voice-mode volume** (`docs/backlog/ios-voice-volume.md`) — TTS ignores hardware volume on iOS. Tried 3 builds (16/17/18) of AppDelegate AVAudioSession via `ci-ios-patch.sh`; root-caused (`.playAndRecord` ownership collides with WKWebView's getUserMedia session + floors the volume). Build 18 = `.playback` (on branch `fix/ios-voice-volume`, **NOT merged**); operator says volume still unfixed → parked. `main` has NO audio-session change (= build-15 behavior). Operator investigating moving voice VRAM to a separate box, which may change this.
- **Routing scorecard + close-the-loops** (`c5a5909`, PR #2, **live-QA'd end-to-end**) — gap audit of the whole "Sully Workspace Vision" (`data/peer_reviews/2026-06-03_sully-vision-gap-audit.md`) → built Phase 0 + Phase 1 of the routing-test plan (`docs/superpowers/plans/2026-06-03-...md`). **Phase 0:** classifier tier now persisted on the Task row (`markClassified`); completion close-out routes to the live thread + is idempotent + survives a late terminal callback (`completionClose.ts`); self-handled turns reach `synthesized` (`markSelfHandled`); stale-job reaper on the polled activity GET. **Phase 1:** one pure `decide()` (Talk/Ask/Dispatch) that the scorecard grades AND production calls (`src/lib/server/routing/`); labeled corpus `tests/fixtures/routing-cases.jsonl`; **hard CI gate** `tests/routing-scorecard.test.ts` (`npm run routing:score`); two scorecard-validated safe fixes (suppress dispatch in planning/deep; tighten `valueGate` soft-imperative + brainstorm-deny) → **accuracy 79.5%→95.6%**; injection guard now precedes `@cc` (pasted content can't auto-fire). Also fixed a **pre-existing CI-only red** (web*search dropped results when the spend-DB write threw — default `memoryDbPath` points at the Orchestrator path, absent in CI; spend recording is now best-effort). Live QA: a real `@cc` dispatch returned to its originating thread, status `synthesized`, one completion message. *(Note: the "ask before dispatch" BEHAVIOR is still Phase 2 — `decide()` returns `Ask`, caller maps it to do-not-fire for now.)\_
- **Native iOS push (APNs)** live on **TestFlight build 15**, verified end-to-end (test push hit the lock screen). Root cause was Capacitor 8 dropping the AppDelegate token-forwarding (fixed in `scripts/ci-ios-patch.sh`) + a signing saga (stable key + cert reset). _(This closes the old handoff's "iOS Build 2 = push" item.)_
- **Read-aloud/Talkback fixed** (shared-element playback + trailing-silence pad + local-TTS self-heal) and **cloud Emma made primary** (`VOICE_TTS_PROVIDER=elevenlabs`; local Chatterbox is fall-forward).
- **Task-first Phase 1** (`c8f6bc1`) — Task object + forensic journal + `turn_replay.ts`.
- **Full app audit + 9 quick-win fixes** (`11f466e`) — latent index bug, a type error, a wrong-thread history bug, the CI gate, Enter-to-send hotkey, dead-code, APNs key-cache, `.env.example`.
- **State docs** (`f62fd3a`) — CURRENT-STATE / DOING-NOW / PLAN.

## Open threads + decisions waiting on the operator

- **Gate authority / dispatch routing** — PARTLY ADDRESSED by the routing scorecard ship (`c5a5909`): the gate is now measured (95.6% on a labeled corpus, hard CI gate) and tightened (no brainstorm/planning auto-fire; soft-imperative demotion). STILL PENDING = the **"ask before dispatch" BEHAVIOR** (Phase 2): `decide()` already returns `Ask` for borderline turns, but the caller maps it to do-not-fire — wiring a real confirmation prompt + dispatch-on-yes is the next step. Also pending: scoring the `SULLY_GATE` model-vote layer offline (capture is wired, env-gated `ROUTING_CAPTURE_GATES=1`).
- **Decision: retire the legacy in-composer Talkback?** (realtime voice is primary now.)
- **Today's Ops dashboard** — the first task-first test project, **not yet built**. The dir Sully "claimed" to create doesn't exist (she narrated it in `local` tier without dispatching). Design: `data/peer_reviews/2026-06-02_todays-ops-data-sources_design.md`.
- **Post-audit refactor** — quick wins done; M/L items (legacy `/api/chat` migration, shared `db.ts`, voice consolidation) queued behind CI + the two decisions. See `docs/PLAN.md`.

## Gotchas / landmines (durable — don't re-learn)

- **Dispatch works.** Triggers: `@cc`/`@agy` in the OPERATOR's message forces it (any tier); the auto-gate (`decisionGate.ts` valueGate) fires on strong work-signals (file path, or imperative+repo/code). `local` tier still runs the gate but rarely qualifies. Proven by real `claude-code` jobs in the journal.
- **Read the journal, don't ask the operator to check logs.** `data/companion.db` → `chat_activity` (events, correlate by `trace_id` = the `sully-…` task_id) + `chat_messages` (forensics cols) + `turn_replay.ts`.
- **Chat context is assembled SERVER-side** in `chat/stream_prepare.ts` (hot-window from `chat_messages` + Layer-1 summary + Layer-3 facts); the frontend sends only the current turn. Any send-path change MUST keep the server loading the hot window or model switches go amnesiac. (`reference_companion_chat_context_architecture`)
- **`LOGUEOS_MEMORY_DB_PATH`** (`.env`) overrides the default shared-orchestrator DB to the private `data/companion.db` — **keep it** or personal facts leak into the team DB. (Verified this session.)
- `buildSystemPrompt` (`chat_prompt.ts`) is **async** — `await` it or you get `[object Promise]` in the prompt.
- Semantic recall filters by `embed_model` — changing the embed model orphans existing vectors.
- `chat_messages.sender` ∈ `operator`/`local`/`cc`/`agy`/`system` — never `user`/`assistant` (model mapping happens in `stream_prepare.ts`).
- **`.env` gitignored**; `.env.example` (names only) tracked via a `!.env.example` exception. Never echo/commit secret values.
- **Do NOT touch** (load-bearing, per audit): the run-mode config matrix (`config.ts`), the shared `chat_turn`/`stream_prepare`/`chat_prompt` extractions, the hot-window ordering, the documented Svelte-5 runes workarounds, the stable-signing-key injection (`tools/trigger-ios-build.sh`), the tailnet fail-closed auth, the brakes-chain ordering.
- **Training guard** (`feedback_no_local_model_during_training`): if the operator says training is starting, set local models off + cloud default. Currently NOT training. Note `COMPANION_LOCAL_DISABLED=true` is currently set.

## Project shape & services (durable)

- **Two repos:** `~/dev/LogueOS-Companion` (app, `:18769`) + `~/dev/companion-speech` (Python STT `:18770` / TTS `:18771`, on-demand to free the GPU; self-heal on CUDA fault via `voice_services.ts`).
- **URLs:** tailnet `https://room.taila28611.ts.net:8444/companion` (the iOS app's `server.url`; needs Tailscale + MagicDNS on the phone) · public Funnel `https://room.taila28611.ts.net/companion`.
- **Voice:** cloud Emma (ElevenLabs Flash) primary + local Chatterbox fall-forward; daily cap `ELEVENLABS_DAILY_CHAR_CAP`. Model setup lives in `config.ts` + the model registry (verify there rather than assuming a default — it shifts with tier/training state).
- Apple: bundle `com.dreighto.sully`, Team `G3KJW4VXM9`, live distribution cert `6QD846B8Y2`.
