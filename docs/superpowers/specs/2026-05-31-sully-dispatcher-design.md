# Sully Dispatcher — Design Spec

- **Date:** 2026-05-31
- **Version:** v3 — Hermes-learning fix grounded in real Orchestrator code, all review flags resolved, notifications scaffolding added.
- **Status:** Approved design → implementation plan written (`docs/superpowers/plans/`).
- **Repo:** LogueOS-Companion ("Sully")
- **Related:** `2026-05-30-sully-companion-rebuild-design.md`, `2026-05-30-sully-voice-mode-design.md`
- **Memory layer:** full schema is a **later** project; this spec defines only the _seams_ the dispatcher needs.

---

## 0. Ground truth (verified against live code, 2026-05-31)

Two grounded code-reading passes (companion + Orchestrator) overturned several first-draft assumptions. Verified facts (file:line) that re-scope this work:

**Companion (LogueOS-Companion):**

- **Dispatch is deliberately OFF.** `config.ts:143` → `_wired = serverConfig.mode !== 'companion'`; `.env` → `LOGUEOS_APP_MODE=companion`. So `runMode.dispatchEnabled / observationsEnabled / completionPoller / killSwitchEnabled` are all **false** (`config.ts:148-152`). `src/routes/api/chat/+server.ts:206-209` hard-short-circuits `@cc`/`@agy`: _"Worker dispatch … is not available in the Companion."_
- **OAuth Bearer works for HAIKU ONLY.** `sdk-stream/+server.ts:180-217` (`getAnthropicAuthForModel`, verified 2026-05-27): `Authorization: Bearer <CLAUDE_CODE_OAUTH_TOKEN>` against `api.anthropic.com/v1/messages` grants API access to **Haiku**; **Sonnet/Opus return HTTP 429 `rate_limit_error`**. The working OAuth path for Sonnet/Opus is the **Claude CLI bridge** (`claude_cli_stream.ts` — the `claude` binary is the authorized OAuth client). ⚠️ This contradicts memory `claude-max-oauth-direct-api`; see §11.
- **`consult_claude` is silently broken on Opus over OAuth.** `companion_tools.ts:444-508` uses the raw-Bearer fetch with default `claude-opus-4-8` → 429 unless a billed `ANTHROPIC_API_KEY` is set. The dispatcher teacher must NOT copy this pattern.
- **Spend tracking is a prediction.** `usage.ts:43-44` stores `predicted_cost_usd/predicted_tokens` (a guess, never reconciled). `sdk-stream` `onFinish:551` ignores the AI-SDK `usage` object; no `cache_read` captured.
- **The app is 100% polling** (3000/5000 ms); no client `EventSource`. SSE is greenfield.
- **iOS push is non-functional in the app.** `capacitor.config.ts` sets `limitsNavigationsToAppBoundDomains:false` so the PWA service worker stays inert in the WebView; APNs is deferred ("BUILD 2"); no client subscription exists; `chat_web_push_subscriptions` is empty. Web Push works only for desktop / real-Safari PWA.
- **No activity writer, and the kernel one writes the wrong DB.** `chatActivity.ts` has only readers on `companion.db`. The only writer, Orchestrator `tools/emit_chat_activity.py`, writes to `logueos_memory.db` — a DB the companion never reads. Row schema: `(id, trace_id, action, target, timestamp)`, `action ∈ {reading,edited,ran,thinking,completed,failed}`.

**Orchestrator (LogueOS-Orchestrator) — the Hermes pipeline:**

- **The "apprentice" is a labeling BRIDGE, not a trainer.** `tools/hermes_apprentice.py` joins `routing_history.jsonl` (proposal) + `pending_callbacks.jsonl` decided-rows (operator label) + completion/VP-Ops (outcome) → emits `hermes_learning_cases.jsonl`. **No model is fine-tuned anywhere** (roadmap Stage 3 = NOT STARTED).
- **Its decision signal is DEAD today.** The label keys off an operator `action` code (a/o/c/u/x/g/t/r) on a `decided` row joined by `task_identifier`; live `pending_callbacks.jsonl` has 3 decided rows, **0 joinable** → almost everything is `learning_signal='no_decision'`. **This empty decision channel is the whole "no data path" problem.**
- **`routing_history.jsonl` is written by n8n (W2 workflow), not Python; it is NOT hash-chained.** `task_identifier` (e.g. `PRO-960`) is the join key.
- **Two injection paths diverge.** `hermes_injector.py` (gatekeeper, **shadow mode**) reads `observations` + `lessons` by `project_id`. The **live listener** (`memory.js getRelevantLessons`) reads **only** `provisional_lessons` (+ adopted-lessons.md) — never raw observations, never the apprentice output.
- **Observation pipeline (hash-chained):** `emit_observation.py` → `agent_decisions.jsonl` (`audit_chain.append_chained`, tamper-evident) → `ingest_memory.py` → `observations` table → `synthesize_lessons.py` (Ollama qwen2.5:14b clusters, fails-closed) → `provisional_lessons` (6-week TTL) → `memory.js` injects.
- **`ingest_memory` / `synthesize_lessons` / `hermes_apprentice` are all MANUAL** (no scheduler). Written episodes sit cold without a cadence.
- **Append-only invariant:** `routing_history.jsonl` and `pending_callbacks.jsonl` are on the 12-file append-only list — raw `fs`-append only; `agent_decisions.jsonl` MUST use `append_chained`.
- **The `logueos-shadow-loop.service` is miru's card-catalog learner, NOT the routing Hermes** — do not wire Sully into it.

**Consequence:** Phase 1 is **net-new companion dispatch infrastructure**. The Hermes fix is **closing a dead data channel + adding a no-GPU learning layer**, not "turning on training."

---

## 1. Purpose

Give Sully autonomous, **value-gated** escalation: decide when a request is beyond her, dispatch it to one cloud worker (CC / AGY), and stream the worker's live activity into a chat "Working bubble." Every dispatch doubles as a **training episode** feeding a teacher → apprentice loop. This is a **model cascade** (cheap local decision → one cloud worker), **built new** on the companion.

### Goals

- Value-gated escalation, decided cheaply, with a deterministic gate independent of the model.
- A live, visible Working bubble over SSE, with **reconnect-on-resume reconciliation** as the iOS correctness floor.
- App-native control surface (touch UI), never CLI slash-commands.
- A trust ladder graduating per category from **objective operator-outcome** evidence.
- A **real Hermes-learning data path** (§4.10) + a no-GPU learning mechanism, plus the seam for Sully's own apprentice.
- Useful **notifications** (§4.13): lock-screen completion, actionable approve/retry, a live "Working…" status — not just "tap to return."
- Hardware-safe on one 16 GB GPU with a proven VRAM budget; cloud is the only parallelism lane.
- Brakes anchored to **countable** signals against the runaway loop.

### Non-goals (this spec)

- Full 4-layer memory schema/retrieval (later); parallel multi-worker fan-out; a measured-confidence router (v1 uses a deterministic gate + structured self-assessment); final avatar character + accent Theme system; GPU fine-tuning of any model in Phase 1.

---

## 2. Research basis (one paragraph)

Flagships and OSS converge: one central brain classifies intent and delegates a typed job to a worker — never a peer mesh. Single agent ≈ 4× a chat in tokens, multi-agent ≈ 15×; escalation must be value-gated; tuned routers keep ~85–97% of turns local. Deterministic routing costs zero tokens. The #1 failure is the runaway cost/retry loop — brakes first. For making a small apprentice learn from a big teacher on one 16 GB GPU, the field favors **training-free first**: RAG-as-memory + a contextual bandit + confidence calibration (CPU, no GPU, improves from the first approve/override), with periodic LoRA distillation later behind an eval gate. (Some cited papers may be model-fabricated — mechanism-level guidance is sound; treat exact citations as leads.)

---

## 3. Architecture overview

```
You ──▶ Sully (BRAIN = role slot; today = cloud Opus via the Claude CLI bridge/OAuth)
            ├─ answers you directly (most turns)
            └─ DECISION GATE
                  ├─ rule pre-filter (free)
                  ├─ deterministic VALUE gate (server-side, model-independent)
                  └─ schema self-assessment  ── emitted IN the same CLI-bridge reply
                        ▼ {escalate, worker, confidence, category, brief, est_scope} (validated)
                  DISPATCH ── typed handoff ──▶ ONE cloud worker (dispatchName=gemini / claude-code)
                        │                            │ activity rows
                  pending_jobs (companion.db)   worker HTTP-callback ──▶ ACTIVITY WRITER (companion.db)
                        ▼                            ▼
                  WORKING BUBBLE ◀── SSE (id: trace:seq, heartbeat) ──┘   + APNs notify (§4.13)
                  (live rows → final result; reconcile-on-resume)

  TEACHING / LEARNING LOOP (§4.9–4.10)
    episode close → (a) labeled routing_history row + sully_episodes.jsonl decision  → revives hermes_apprentice
                    (b) emit_observation (hash-chained) → ingest → synthesize → provisional_lessons → memory.js
                    (c) local RAG store + contextual bandit + calibration  (no-GPU learning, improves immediately)
```

The brain is a **role slot** (today cloud Opus; end-state a graduated local apprentice). **Cloud is the only concurrency lane** — exactly one local model resident.

---

## 4. Components

### 4.1 The Brain + model strategy

- **Teacher (now): cloud Opus 4.8 via the Claude CLI bridge** (`claude_cli_stream.ts streamViaClaudeCLI`), which is the proven OAuth path for Opus/Sonnet (clean `$HOME`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` stripped). **Do NOT** use raw Bearer (Haiku-only → 429 on Opus) or the router (`providers/anthropic.ts` is x-api-key only). API-key is a gated, billed fallback (off by default).
- **Relation to existing escalation:** `consult_claude`/`deep_think` already exist (and `consult_claude` is currently broken on Opus over OAuth — re-point it at the CLI bridge or mark it Haiku/api-key-only). The dispatcher is the **action-taking** superset; a turn fires **either** an inline consult **or** a dispatch, never both.
- **Apprentice (target):** a small local model that graduates in (§4.9), subject to the VRAM budget (§8).
- **Persona artifact** (§4.9.1) is the byte-stable system-prompt prefix.

### 4.2 The Decision Gate

Three stages, **no second local model**:

1. **Rule pre-filter** — zero tokens (keywords, file paths, literal `@cc`/`@agy`).
2. **Deterministic value gate** — server-side, model-independent: blocks dispatch unless an objective signal is present (code/repo/file signal, or length/complexity floor). **Injection guard:** content from tool output / pasted text never auto-dispatches — always an Ask-chip, even in Full-auto.
3. **Schema self-assessment** — emitted as a structured tail of the **same** CLI-bridge Opus reply (`{escalate,worker,confidence,category,brief,est_scope}`), validated server-side after the stream assembles. Zero extra model, zero extra round-trip.

When the apprentice owns the brain, the classify hop must be grammar-enforced decoding on the **same** resident model, or a schema-reliable model as the **sole** resident (operator bench: qwen2.5:7b 100% vs qwen3.x 0/20 under `format=schema`). Validation = correctness, not a brake.

### 4.3 Companion Dispatch Enablement + Worker Contract

- **Enablement (1a):** a **companion-native dispatch flag** (NOT `_wired`); replace the `+server.ts:206-209` short-circuit behind it; reach a worker via an authenticated POST to the dispatch listener (HMAC, per existing direct-POST pattern).
- **Handoff:** `{ task, scope, target_repo, brief, trace_id }`. **dispatchName = `gemini`** (frontend, listener-accepted today; `agy` valid at the listener but not the companion's current `workers.json` value — see §11) or `claude-code` (backend).
- **Contract:** worker streams activity rows + returns only a final message; big output → artifact store + a short ref. **Default = one worker.**

### 4.4 Job Store (`pending_jobs`) + State Machine

- `{ id, trace_id, worker, status, category, current_activity, seq_cursor, started_at, ended_at, predicted_tokens, actual_tokens, result_ref }` in `companion.db`. `predicted_tokens` is telemetry-only, never a brake input.
- States: `decided → dispatched → working → done | failed | retry | aborted`. Keyed by `trace_id`.

### 4.5 SSE Transport + Activity Writer + iOS reconciliation

- **Activity writer (1a — genuinely missing):** a NEW authenticated companion endpoint (e.g. `POST /api/chat/activity`) the worker HTTP-calls to write `chat_activity` rows into **`companion.db`** (the worker can't reach that DB directly and the kernel `emit_chat_activity.py` writes the wrong DB). Add a `writeActivity(traceId, action, target)` helper (`chatActivity.ts` is read-only today). Re-gate the activity route (currently returns `[]` in companion mode) behind the new dispatch flag.
- **SSE contract (greenfield):** `id: <trace_id>:<seq>` per row; headers on the streamed `Response` (`text/event-stream`, `no-cache,no-transform`, keep-alive) — not `setHeaders`; ~15 s heartbeat to beat Tailscale/carrier idle-reaping; client opens via `resolve('/api/chat/<route>')` (respects `/companion` base). **Verify via the `:8444` tailnet path.**
- **Resume/reconnect (REQUIRED floor):** add `visibilitychange` (PWA) + Capacitor `App` `resume` (native) handlers; on resume recreate the `EventSource` with `Last-Event-ID`, replay `seq > cursor` from `pending_jobs`, dedupe, and reconcile against a fresh GET of the job row. Because SSE+push both fail when the iPhone backgrounds, this is the primary correctness guarantee.
- iOS push is handled in §4.13 (APNs), not here.

### 4.6 The Working Bubble (UI)

`working` → live rows + elapsed timer; `done` → collapse to final message; `failed`/`aborted` → state + bounded retry. Renders off `pending_jobs` + SSE; styled per `companion-ui-design`.

### 4.7 App-Native Control Surface (no slash-commands)

- **Inline chips:** _"Sully wants to send this to CC — [brief]"_ → [Approve] · [Skip] · [Edit brief].
- **Autonomy control (Settings):** segmented **Ask · Auto-for-safe · Full-auto** (full-auto still bounded by §4.11 + kill switch).
- Existing slash-commands stay; **no `/dispatch` command.**

### 4.8 The Autonomy Ladder

Graduate per category on **outcomes**, bounded against value-gate bypass: require a minimum sample size AND a low false-dispatch rate (not a streak); any `failed`/Skip/correction immediately demotes to Ask; never auto-graduate while Full-auto is selected; newly-graduated categories get a tighter probation budget. This is the **same mechanism** as §4.9.4 (both score objective outcomes).

### 4.9 The Teaching Loop

- **4.9.1 Persona artifact:** a canonical source with per-runtime renderings (cloud-prefix for cache, local-prefix for Ollama KV, an L4 object). Only the source is single.
- **4.9.2 Episode capture → L2:** `{ ask, decision, worker_actions, outcome, operator_reaction, trace_id }` in local `companion.db`.
- **4.9.3 Skill acquisition → L4 (LOCAL ONLY):** the team pool has no procedural/skills table — skills stay local to Sully.
- **4.9.4 Graduation scorer (objective):** the apprentice's readiness is scored on **objective operator outcomes** already logged in §4.2 (dispatch succeeded / approved / a local answer was corrected) — never teacher-text-similarity. Eligibility bounded to deterministic/low-judgment categories; persona/judgment turns stay on the cloud teacher.
- **4.9.5 Handoff payoff (VRAM corrected):** graduation makes the apprentice **resident → adds** local VRAM (contends with voice's ~14.6 GB peak); the real payoff is **quota/cost, latency, offline**. During voice, the apprentice is evicted on-demand and cold-reloads on voice exit.

### 4.10 Memory seams + the Hermes-learning fix

**The two-part fix** (this is the resolved "Hermes learning problem"):

**Part A — close the dead data channel (the real bug).** On episode close, the companion writes, append-only:

1. a **labeled `routing_history.jsonl` row** mirroring the n8n W2 intent shape (`timestamp, trace_id, task_identifier=SULLY-<n>, extracted_signals, ranked_candidates, chosen_worker, confidence, risk, operator_override_flag, outcome`), raw `fs`-append, synthetic `SULLY-<n>` namespace (regex-conforming so `ticket_id` inference works);
2. a paired **operator-decision record** to a NEW `data/sully_episodes.jsonl` (`{task_identifier:'SULLY-<n>', action, action_label, decided_at}`; map approve→`a`, skip→`t`, correct-to-X→`{c/u/x/g}`, generic-correct→`o`);
3. extend `hermes_apprentice.py` with a small additive `load_sully_episodes()` feeding `decided_map` by `task_identifier` — **zero change** to its tested `_classify_signal`/`_actual_worker`. This revives the fully-built labeling pipeline that today only emits `no_decision`, producing `hermes_learning_cases.jsonl` — the corpus roadmap Stage 3 fine-tunes on.
4. ALSO `emit_observation.py` (`project_id='logueos-companion'`, `observation_kind ∈ {routing-correction, what-worked, what-didnt-work}`) per high-signal episode → rides the hash-chained `agent_decisions.jsonl → ingest → synthesize → provisional_lessons` pipeline → surfaces to future companion dispatches via `memory.js`. (Lossy: one ≤2000-char observation row; the full episode stays in local L2.)
5. **Wire the cadence (its own task):** schedule `ingest_memory.py` + `synthesize_lessons.py` + `hermes_apprentice.py` (cron/Console) — they are manual today, so without this the episodes sit cold.

**Part B — the learning mechanism (no GPU, improves immediately).** Don't start with fine-tuning. Layer, in order:

1. **RAG-as-memory:** log every decision (query + route + rationale + approve/override) to a local vector store (sqlite-vec/HNSW); at decision time retrieve k=4–8 nearest past decisions as dynamic few-shot so the apprentice imitates teacher precedent. Adapts the instant a new row lands; CPU; ~zero training.
2. **Contextual bandit router** (LinUCB / Vowpal Wabbit, ~50–100 LOC, <50 MB CPU): arms = {handle-locally, escalate-to-Sully}; reward = approve(+1)/override(0); recency-decayed. Learns **when** to trust the apprentice in ~500–700 interactions.
3. **Confidence calibration** (temperature/Platt/conformal on logs, CPU) as the deferral threshold.
4. **Later, behind an eval gate:** periodic offline **LoRA/QLoRA distillation** on accumulated vetted decisions (champion/challenger + shadow + LLM-as-judge, human-in-the-loop promotion). Avoid RLAIF (won't fit 16 GB) and starting with DPO/KTO (fragile on 16 GB; unnecessary for routing).

**Three entities, kept straight:** Sully's **brain-apprentice** (§4.9), the Orchestrator **routing-Hermes** (`hermes_apprentice.py` + `predict.js`/gatekeeper), and the companion **local-tier Hermes** (qwen2.5:7b). They share the **same corpus + pattern**, not one model. "Hermes trains too" realistically = (a) the routing-Hermes corpus finally gets a live decision signal, and (b) Sully's observations become retrievable team context via `memory.js`. No model is fine-tuned in Phase 1.

**Partition discipline:** every team-pool row carries `project_id='logueos-companion'` + `source='sully'`; `synthesize_lessons` must bucket/skip Sully rows so chat/persona noise isn't promoted into team lessons, and `hermes_injector` (filters by `project_id`) never leaks Sully episodes into unrelated workers' prompts.

**L3 must not swap the GPU:** run the embedder CPU-resident; gate L3 retrieval behind the rule pre-filter (not every turn).

### 4.11 Cost/quota brakes + spend telemetry

- **Auth reality:** teacher/workers on Max OAuth (quota, no dollars). Brakes use **countable** signals; the billed API-key path is gated/off.
- **Brakes (all from day one):** (1) **dispatch-count budget** + worker **wall-clock** per rolling window — in Full-auto with the operator away, hitting it is a **HARD stop** until reset; (2) **429 circuit-breaker** (the real quota signal — cooldown, halt-all, **no retry**); (3) bounded retries (default **2**) for **transient** errors only (never 429); (4) **token-bucket rate limiter** before the handoff POST; (5) **no re-escalation by content fingerprint** (`brief|category|target_repo` hash + per-conversation cap); (6) deterministic value gate (§4.2); (7) **two-level companion-LOCAL kill switch** — gate new **and abort in-flight** (iterate `working` rows → POST cancel → `aborted` → stop SSE). Phase-1 acceptance = "aborts an in-flight dispatch."
- **Actual-token capture:** read the **worker result-marker telemetry** (`usage_capture.js`: prompt/completion/cache*read/cache_creation/total) into NEW `actual*_`columns, distinct from`predicted\__`. Also capture the AI-SDK `onFinish` usage on the local reply path (currently ignored). **agy has no actuals** (binary protobuf) → predicted-only for agy dispatches.
- **Telemetry:** Phase-1 companion-app meter = dispatch count + wall-clock today (countable, honest), labeled predicted-vs-actual. The cross-repo **Console tracker** waits on the team-pool write + actual columns.

### 4.12 Animated avatar (later phase)

Outline/terminal CRT line-art (locked); candidate **KAIJU** (original, Sulley-spirited); accent **Theme** (magenta default · phosphor · amber · cyan) later; **Rive** state-machine fed live job/voice state; its own phase, ships without it.

### 4.13 Notifications (NEW — scaffolding)

**Channel reality:** APNs (`@capacitor/push-notifications`) is the **only** channel that wakes the iPhone-as-app (Web Push is dead in the WebView by design; keep Web Push for desktop/Safari). APNs needs a **net-new server sender** (HTTP/2 + JWT from a `.p8` key) — VAPID can't reach it.

**Channel-agnostic envelope** (server emits once; per-channel adapters translate): `{ v, kind, trace_id, ticket_id, thread_id, worker_id, title, body, status, category, interruption_level, relevance_score, thread_group, collapse_id, deep_link, actions[], live_activity?, extra }`. APNs adapter maps to `aps.*` + headers; web-push adapter maps to the existing `{title,body,data.url}`.

**Categories / actions** (buttons act from the lock screen WITHOUT opening the app): `DISPATCH_RESULT` (view/rerun/mute), `APPROVAL_REQUEST` (approve/deny/view — reuses `/api/chat/approve` with a trace_id→message_id lookup; time-sensitive), `DISPATCH_RETRYABLE` (retry/skip/view), `QUOTA_WARNING` (view/snooze, per-provider collapse_id), `DIGEST` (passive daily/while-away summary), `LIVE_STATUS_FALLBACK` (plain-notification substitute for the Live Activity).

**Live Activity / Dynamic Island** (the "useful beyond tap" showpiece, **build last**): a persistent lock-screen card — _"Dispatch 1/3 · building · 4:12"_ — with an **OS-animated** timer/progress (`Text(timerInterval:)`/`ProgressView(timerInterval:)`) so the server pushes only on **step changes**. Requires native Swift: a Widget Extension target, an `ActivityAttributes`+`ContentState` struct compiled into both targets, `NSSupportsLiveActivities`, an App Group — and, because CI regenerates `ios/` fresh, a committed **codemagic.yaml post-`cap add ios` patch step** to inject all of it. Plugin: `ludufre/capacitor-live-activities` (push-to-start, iOS 17.2+).

**Critical nuance:** Capacitor surfaces actions via JS only once the WebView is alive. For Approve/Skip/Retry to round-trip while Sully stays **closed**, a small committed native `UNUserNotificationCenterDelegate` handler must POST to the server (keyed on trace_id), with JS reconciling on next open.

**Build order:** **N1 — APNs spine** (`notify.ts` envelope dispatcher · `apns.ts` HTTP/2 JWT sender · `chat_apns_tokens` table + reaper · capacitor BUILD-2 block + client registration + `aps-environment` entitlement · upgrade `completion_poller.ts` to envelopes). **N2 — actionable approvals** (categories + native delegate + `/api/chat/approve` trace_id lookup + quota-warning + digest). **N3 — Live Activity** (Swift widget extension + CI injection; `LIVE_STATUS_FALLBACK` until then).

---

## 5. Data flow (a real dispatch)

1. Message → brain answers; gate runs (rules → value gate → schema self-assessment in the same CLI-bridge call).
2. Dispatch chosen → value-gated → fingerprint-checked → rate-limited → schema-validated.
3. Autonomy: `Ask` shows chips / `Auto-*` proceeds.
4. `pending_jobs` `decided`; HMAC handoff POST (`dispatched → working`).
5. Worker streams rows → **companion activity-callback** → SSE → bubble. On background, APNs (N1) notifies.
6. Worker finishes → artifacts + final message + ref → bubble collapses (`done`); actual tokens captured from the result marker.
7. Episode → local L2 (+ local L4 if recurring) → **Part A** writes (routing_history + sully_episodes + observation) → cadence ingests.
8. RAG store + bandit + calibration update (Part B); autonomy ladder + spend meter update.
9. On resume: recreate SSE with `Last-Event-ID` + reconcile against the job row.

---

## 6. Error handling

Malformed decision → answer/ask. 429 → circuit-breaker (cooldown, halt-all, no retry). Transient worker failure → bounded retry (2) → `failed`. SSE drop/resume → recreate + replay by `seq` + reconcile. Cold local model → "waking Sully" + re-warm. Budget/kill → hard stop / gate + in-flight abort. `synthesize_lessons` Ollama-down → fails closed (no raw-obs dumping).

---

## 7. Token / quota efficiency

- Deterministic routing first (zero tokens).
- **Prompt caching is structurally unobservable on the chosen Opus path:** the CLI bridge's NDJSON parser reads no usage block, so `cache_read` can't be seen for the teacher today. **Drop the cache projection for the teacher path** (or add result-event usage parsing later). The **dispatched worker** path DOES capture `cache_read` (`usage_capture.js`). Run the spec's identical-prefix cache test against **Haiku** (the only raw-Bearer-over-OAuth path) to confirm the mechanism. Keep persona/canon as a byte-stable prefix regardless; never a timestamp early.
- Local prefix/KV reuse pays off **only within continuous single-model residency** (any GPU swap discards KV) — so §8's swap-minimization is a prerequisite.
- Artifact + reference for big output. Summarize long briefs with the resident local model or deterministic truncation — **no cloud round-trip** on quota unless over a hard threshold.

---

## 8. Hardware constraints (single 16 GB GPU)

- **Ollama env is a Phase-1 deployment PRECONDITION at the systemd level (drop-in `Environment=`, at boot):** `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_KEEP_ALIVE=-1`.
- **VRAM budget** (commit `num_ctx` + KV quant in the plan): Voice-ON peaks ~14.6/16.3 GB (reply + faster-whisper tiny/small + Chatterbox) → **no room** for a resident classifier/embedder/apprentice. Therefore the classifier rides the cloud Opus call (§4.2), the **embedder runs CPU-resident** (§4.10), and the apprentice is **evicted during voice** (§4.9.5). `MAX_LOADED=1` makes every cross-model call a serial unload/reload → minimize distinct resident model names to ~one.
- **System RAM (32 GB):** confirm CPU tenants (embedder, Silero VAD, STT, Chatterbox/torch+CUDA, SvelteKit) fit with margin.
- Cloud-only concurrency; never two local models.

---

## 9. Telemetry & calibration

Log every decision (category, confidence, escalated?, objective outcome, actual tokens where available). Tune on the operator's own traffic; bias slightly toward over-escalation early (under-escalation is the worse error). The ladder graduates on outcomes, not chip taps.

---

## 10. Phasing

- **Phase 1 — Core dispatcher** (decomposed):
  - **1a Unblocking:** companion dispatch flag + listener handoff (HMAC) + **activity-callback writer** into `companion.db`.
  - **1b Backend:** `pending_jobs` + state machine + decision gate (rules + value gate + CLI-bridge schema self-assessment + validation) + brakes (count, 429 breaker, rate-limiter, fingerprint, two-level kill switch) + actual-token capture. Pin defaults (retry 2; starting daily cap; value-gate heuristic). **Acceptance includes the schema-emission test.**
  - **1c Frontend:** SSE (contract + headers + heartbeat + resolve-base) + **resume-reconciliation** + Working bubble + chips + Autonomy _Ask_ + companion-app meter.
- **Phase 2 — Autonomy ladder** (objective-outcome graduation, demotion, probation).
- **Phase 3 — Teaching/learning:** persona artifact, episode capture, local L4 skills, **Hermes Part A** (routing_history + `sully_episodes.jsonl` + `load_sully_episodes()` + observations + **cadence cron**) and **Part B** (RAG store + contextual bandit + calibration).
- **Phase 4 — Apprentice graduation** (local resident handoff; voice-eviction) and (optional) LoRA distillation behind an eval gate.
- **Phase N (parallel track) — Notifications:** N1 APNs spine → N2 actionable approvals → N3 Live Activity.
- **Phase 5 — Avatar (Rive) + accent Theme.**
- **Later — full 4-layer memory.**

---

## 11. Resolved review flags + remaining operator decisions

**Resolved (folded into the spec):**

1. **Teacher code path** → Claude CLI bridge (§4.1), not raw Bearer, not the router.
2. **Prompt-caching over OAuth** → unobservable on the CLI Opus path; drop the teacher projection; worker path captures it; test on Haiku (§7).
3. **Classifier hosting** → rides the same CLI-bridge call (§4.2).
4. **Activity writer** → companion HTTP-callback into `companion.db` (§4.5).
5. **Workers.json name** → emit `gemini` (§4.3).
6. **Actual-token capture** → from the worker result-marker telemetry (§4.11).
7. **Hermes learning** → Part A (close the dead decision channel) + Part B (RAG + bandit + calibration) (§4.10).

**Remaining operator decisions (need your call):**

- **OAuth canon contradiction.** Live code (verified 2026-05-27) proves raw OAuth Bearer is Haiku-only; Sonnet/Opus 429. This supersedes memory `claude-max-oauth-direct-api` ("verified 2026-05-26"). **Decision:** accept the CLI-bridge-for-Opus rule (recommended), and is `consult_claude`'s `opus-4-8` default knowingly billed-api-key-only, or should it be re-pointed at the CLI bridge? (Memory will be updated to the verified nuance.)
- **agy vs gemini cutover** — emit `gemini` now (safe) vs swap `workers.json` to `agy` once the Antigravity migration cuts over.
- **Worker→companion callback auth** — HMAC (per the listener's direct-POST) vs a shared secret; and how the worker prompt/env carries the companion callback URL. To pin in the 1a plan.
- **Cache projection scope** — drop entirely for the Opus teacher (recommended) vs parse the CLI `result` event's usage to recover `cache_read` in Phase 1.
- **agy actuals gap** — accept predicted-only for agy dispatches until Antigravity token tracking lands.

---

## 12. Acceptance (per sub-phase)

- **1a:** a gate-chosen request reaches a worker on the companion; activity rows are written into `companion.db` and readable by `trace_id`.
- **1b:** the gate proposes a dispatch on a qualifying request and refuses trivial/injected content; the schema-emission test passes; a 429 trips the circuit-breaker (halt-all, no retry); the kill switch **aborts an in-flight dispatch**; fingerprint + rate-limiter block a looping dispatch; actual tokens are captured from the worker marker; every decision logged with objective outcome.
- **1c:** the SSE bubble streams via the `:8444` tailnet path and collapses to the final result; background→foreground **recreates the stream and reconciles** (no stale "working"); state survives a server restart; the meter shows dispatch count + wall-clock.
- **Phase 3:** a Sully episode produces a labeled `routing_history` row + a `sully_episodes.jsonl` decision; a manual `hermes_apprentice.py` run yields a non-`no_decision` learning case; an observation reaches `provisional_lessons` after the cadence runs; the RAG store returns a past decision and the bandit updates on an approve/override.
- **N1:** a real lock-screen "Dispatch complete" lands on a closed app via APNs.
