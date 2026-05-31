# Sully Dispatcher — Design Spec

- **Date:** 2026-05-31
- **Version:** v2 — corrected against live companion code after an adversarial 7-lens review.
- **Status:** Approved design → ready for implementation planning (Phase 1 decomposed).
- **Repo:** LogueOS-Companion ("Sully")
- **Related:** `2026-05-30-sully-companion-rebuild-design.md`, `2026-05-30-sully-voice-mode-design.md`
- **Memory layer:** full schema is a **later** project; this spec defines only the _seams_ the dispatcher needs.

---

## 0. Ground truth (verified against live code, 2026-05-31)

The first draft assumed the existing kernel dispatch was ~55% present and could be "layered on." **That is false in companion mode.** Verified facts (file:line) that re-scope this work:

- **Dispatch is deliberately OFF.** `config.ts:143` → `const _wired = serverConfig.mode !== 'companion'`; `.env` → `LOGUEOS_APP_MODE=companion`. So `runMode.dispatchEnabled`, `observationsEnabled`, `completionPoller`, `killSwitchEnabled` are all **false** (`config.ts:148-152`). `src/routes/api/chat/+server.ts:206-209` hard-short-circuits any `@cc`/`@agy` message: _"Worker dispatch … is not available in the Companion."_
- **Local memory ≠ team pool.** `.env` → `LOGUEOS_MEMORY_DB_PATH=…/LogueOS-Companion/data/companion.db`. The local pool is already distinct from the Orchestrator's `logueos_memory.db`.
- **Spend tracking is a prediction, not actuals.** `usage.ts:43-44` stores `predicted_cost_usd` / `predicted_tokens` (a dispatch-time guess, never reconciled). `sdk-stream` `onFinish` never reads the AI-SDK `usage` object; no `cache_read_input_tokens` is captured. Max OAuth returns no dollar/quota figure.
- **The app is 100 % polling.** Chat polls activity at 3000/5000 ms; there is **no** client `EventSource` anywhere. SSE is greenfield.
- **iOS push is non-functional.** The Capacitor shell's PWA service worker "stays inert" in the WebView; APNs (`@capacitor/push-notifications`) is deferred; there is **no** client `pushManager.subscribe` / `Notification.requestPermission`; `chat_web_push_subscriptions` is empty; `completion_poller.ts` (the only completion-push caller) is gated off in companion mode.
- **No activity writer.** `chatActivity.ts` has only readers; nothing inserts into `chat_activity` in companion mode (kernel-side dispatch populated it).
- **OAuth is not wired into the router.** `providers/anthropic.ts` authenticates with `x-api-key` only; only the standalone `consult_claude` tool implements OAuth-first → API-key. `model_catalog.ts` wires the Anthropic top tier to `claude-opus-4-7`; only the consult tool / `COMPANION_CLAUDE_CONSULT_MODEL` references `opus-4-8`.
- **The "Hermes apprentice" does not read observations.** Orchestrator `hermes_apprentice.py` is a _routing_ predictor over `routing_history.jsonl` + operator approve/override; the only consumer of dual-written observations is `hermes_injector.py`, a RAG/prompt-injection librarian (`SELECT … WHERE project_id=?`). Team `lessons` are written only by `synthesize_lessons.py` (a clustering job); there is no skills/procedural table and no write-a-skill API.
- **Existing cloud escalation already ships.** `companion_tools.ts` exposes `consult_claude` + `deep_think` (model-decided cloud calls, OAuth-first). The dispatcher must say how it relates to these.

**Consequence:** Phase 1 is **net-new companion dispatch infrastructure**, gated behind a new companion-native flag, not a re-skin of kernel dispatch.

---

## 1. Purpose

Give Sully the ability to **decide, autonomously and value-gated, when a request is beyond what she should answer directly — and dispatch it to a cloud worker (CC / AGY)** while streaming the worker's live activity into a chat "Working bubble." Every dispatch doubles as a **training episode**: a capable teacher model demonstrates good behavior, the episode is captured to memory, and a smaller local apprentice gradually learns to take over — saving quota/latency and gaining offline capability.

This is **not** a multi-agent framework. It is a **model cascade** (cheap local decision → one cloud worker) in a hub-and-spoke shape, **built new** on the companion (the kernel path is deliberately disabled here).

### Goals

- Autonomous, **value-gated** escalation decided cheaply, with a deterministic gate independent of the model.
- A **live, visible** Working bubble over SSE, with a **reconnect-on-resume reconciliation** floor (the real correctness guarantee on iOS).
- **App-native** control surface (touch UI), never CLI slash-commands.
- A **trust ladder** that graduates per task-category from **objective operator-outcome** evidence (not model self-rating).
- A **teacher → apprentice** loop feeding Sully's local 4-layer memory; **optionally** emitting L2 episodes to the team pool (see §4.10 — this is an _open question_, not a settled goal).
- Hard **safety brakes** anchored to **countable** signals against the #1 failure mode (runaway cost/retry).
- Token-spend **visibility**: a companion-app meter in Phase 1; the cross-repo Console tracker once actual-usage capture + the team-pool write land.
- **Hardware-safe** on a single 16 GB GPU with a proven VRAM budget; cloud is the only parallelism lane.

### Non-goals (this spec)

- The full 4-layer memory schema + retrieval engine (later project; seams only).
- Parallel multi-worker fan-out / adversarial verification (build only when data proves the need).
- A measured-confidence/entropy router (later upgrade); v1 uses a deterministic gate + structured self-assessment.
- Final avatar character selection and the accent **Theme** system (later polish phase).
- "Hermes (the Orchestrator routing predictor) trains on Sully's data" — **demoted to an open question** (§4.10); no data path exists today.

---

## 2. Research basis (one paragraph)

Every flagship (Anthropic lead-agent, OpenAI manager, Google ADK Coordinator, xAI orchestrator) and the OSS field converge: **one central brain classifies intent and delegates a typed job to a worker** — never a chatty peer mesh. Cost anchors: single agent ≈ 4× a chat in tokens, multi-agent ≈ 15×; escalation must be **value-gated**, and tuned routers keep ~85–97 % of turns local. Deterministic (code) routing costs **zero** tokens; reserve the model for the ambiguous middle. The #1 production failure is the **runaway cost/retry loop** — brakes first. Verification caveats honored: (a) "small models can't emit strict JSON" is _partly stale_ (Ollama added grammar enforcement) — we **empirically test**; (b) several third-party cost figures were unverified — no decision rests on them.

---

## 3. Architecture overview ("the shape")

```
You ──▶ Sully (the BRAIN = a role slot; today = cloud Opus via Max OAuth)
            ├─ answers you directly (most turns)
            └─ DECISION GATE
                  ├─ rule pre-filter (free, no model)
                  ├─ deterministic VALUE gate (server-side, model-independent)
                  └─ schema self-assessment  ── emitted IN the same cloud reply call
                        │  {escalate, worker, confidence, category, brief, est_scope}
                        ▼  (validated → rejected if malformed)
                  DISPATCH ── typed handoff ──▶ ONE cloud worker (CC / AGY)
                        │                              │ activity rows
                  pending_jobs (typed store)      worker callback ──▶ ACTIVITY WRITER
                        │                              │
                        ▼                              ▼
                  WORKING BUBBLE ◀── SSE (id: trace:seq, heartbeat) ──┘
                  (live rows → collapses to final result; reconcile-on-resume)

  Wrapping it:  TEACHING LOOP
    teacher (cloud Opus, Sully persona) → episodes (L2) + skills (L4, local-only)
       → Sully local memory (companion.db);  L2 episodes OPTIONALLY → team pool (§4.10)
       → apprentice (local) scored on OBJECTIVE outcomes → graduates into the BRAIN slot
```

**The brain is a role slot.** Today = **Claude Opus 4.8, cloud, via Max OAuth**; swappable; end-state = a graduated small local apprentice.

**Cloud is the only concurrency lane.** Exactly **one** local model resident at steady state. Two heavy tasks → two _cloud_ workers, never a second local model.

---

## 4. Components

### 4.1 The Brain (role slot) + model strategy

- **Purpose:** answer the user and emit the gate self-assessment in the _same_ call.
- **Teacher (now):** Claude Opus 4.8, cloud, OAuth-first (`CLAUDE_CODE_OAUTH_TOKEN`), API-key only as a gated, billed fallback (off by default).
- **Code-path decision (must be made in the plan):** either (a) **route the teacher through a `consult_claude`-style direct call** (already OAuth-capable in `companion_tools.ts`) — _preferred_, or (b) **route through the model router**, which then requires a Phase-1 task to add an **OAuth Bearer branch to `providers/anthropic.ts`** and bump the tier to `opus-4-8` (catalog currently `opus-4-7`). Do **not** imply the router is OAuth-ready — it is not.
- **Relation to existing escalation:** `consult_claude` / `deep_think` already exist (model-decided cloud calls). The dispatcher is a **superset for action-taking work** (file edits, builds, multi-step). Spec rule: a turn fires **either** an inline consult **or** a dispatch, never both; the gate chooses.
- **Apprentice (target):** a small local model that graduates in (§4.9), subject to the VRAM budget (§8).
- **Persona artifact** (§4.9.1) is the byte-stable prefix for cache reuse (§7).

### 4.2 The Decision Gate

- **Purpose:** decide _answer locally_ vs _dispatch_, cheaply, **without a second local model**.
- **Three stages:**
  1. **Rule pre-filter — zero tokens.** Patterns (`fix…`, `build`, `run tests`, `search the repo`, a file path, literal `@cc`/`@agy`) route obvious cases.
  2. **Deterministic value gate — server-side, model-independent.** Blocks dispatch unless an objective signal is present (e.g. a code/repo/file signal, or length/complexity above a floor). A small model emitting `{escalate:true,confidence:high}` for trivial/hallucinated/pasted content does **not** get to dispatch. **Injection guard:** content originating from tool output or pasted external text never auto-dispatches — it always requires an Ask-chip, even in Full-auto.
  3. **Schema self-assessment — emitted inside the same cloud Opus reply call** (while Opus is the brain → **zero extra local model**, no swap, no queue):
     ```json
     {
     	"escalate": true,
     	"worker": "cc",
     	"confidence": "high",
     	"category": "research",
     	"brief": "one line",
     	"est_scope": "single"
     }
     ```
- **No separate local classifier while Opus is the brain.** When the apprentice eventually owns the brain slot, the classify hop is served by grammar-enforced decoding on the **same resident** model, or (if unreliable per the operator's qwen3 schema bench) by making a schema-reliable model the **only** resident model — never a co-resident second model.
- **Validation:** the object is validated before any dispatch; malformed → rejected (fall back to answer/ask). _(This is correctness, not a cost brake — see §4.11.)_
- **Logging:** every decision (escalated or not) logged with category/confidence/**objective outcome** — fuel for §4.8 and telemetry.

### 4.3 Companion Dispatch Enablement + Worker Contract

- **Purpose:** make dispatch _possible_ on the companion (it is currently blocked) and define a typed handoff.
- **Enablement (Phase 1a):** add a **companion-native dispatch flag** (not `_wired`) and a companion path to reach a worker — either a companion gateway endpoint or a direct authenticated POST to the dispatch listener. Remove/replace the `+server.ts:206-209` short-circuit behind this flag.
- **Handoff schema** (mirrors `cc_handoff` frontmatter): `{ task, scope, target_repo, brief, trace_id }`. **Worker name:** confirm the listener's accepted `dispatchName` — `workers.json` labels the frontend slot `gemini` with `agy` as an alias; reference the accepted name or note the swap as a prerequisite.
- **Contract:** the worker streams activity rows while running and returns **only a final synthesized message**; large output goes to an artifact store, a short **reference** comes back (avoids token blowup).
- **Default = one worker.** Parallel fan-out is out of scope.

### 4.4 Job Store (`pending_jobs`) + State Machine

- **Purpose:** orchestration state **outside** the model context; survives restarts/backgrounding.
- **Shape:** `{ id, trace_id, worker, status, category, current_activity, seq_cursor, started_at, ended_at, predicted_tokens, result_ref }`. `predicted_tokens` is **telemetry-only, never a brake input**.
- **States:** `decided → dispatched → working → done | failed | retry | aborted`.
- **Concurrency:** keyed by `trace_id`; concurrent dispatches never clobber each other.

### 4.5 SSE Transport + Activity Writer + iOS reconciliation

- **Activity writer (Phase 1a, genuinely missing):** define **who emits** `chat_activity` rows for a companion dispatch (worker callback/webhook to a companion endpoint, or companion re-emitting from a poll), the **row schema**, and the `trace_id` key. The bubble cannot stream what nothing writes.
- **SSE contract (greenfield):** server emits `id: <trace_id>:<seq>` per row; headers set **directly on the streamed `Response`** (`Content-Type: text/event-stream`, `Cache-Control: no-cache,no-transform`, `Connection: keep-alive`) — _not_ via `setHeaders`; a **~15 s heartbeat comment** defeats Tailscale Serve / carrier idle-reaping. Client opens the stream via `resolve('/api/chat/<route>')` so `paths.base` (`/companion`) is respected. **Verify through the real `:8444` tailnet path, not localhost.**
- **Resume / reconnect (REQUIRED correctness floor, not an edge case):** the chat page currently has **no** `visibilitychange` listener. Add handlers for `visibilitychange` (PWA) **and** Capacitor `App` `resume` (native): on resume, tear down + recreate the `EventSource` with `Last-Event-ID`, replay rows with `seq > cursor` from `pending_jobs`, dedupe by `seq`, and **reconcile the bubble against a fresh GET of the job-store row.** Because SSE _and_ push both currently fail when the iPhone backgrounds, this resume reconciliation is the primary guarantee.
- **iOS push — DESCOPED for Phase 1.** The SW is inert in the WebView, there is no client subscription, and APNs is deferred. "Backgrounded finish pings via push" is **removed from Phase-1 acceptance.** The real channel is **APNs via `@capacitor/push-notifications`** (a later phase) and/or a real web-push subscription flow for the PWA; until then, resume-reconciliation covers correctness. Drop the "Declarative Web Push primary" claim from "canon honored" — `web_push.ts` sends a flat imperative payload.

### 4.6 The Working Bubble (UI)

- While `working`: live activity rows + elapsed timer. On `done`: collapse to the final message. On `failed`/`aborted`: show state + a bounded **retry** affordance. Renders entirely off `pending_jobs` + SSE; styled per `companion-ui-design` (flat reply under `● Sully`).

### 4.7 App-Native Control Surface (no slash-commands)

- **Inline chips:** _"Sully wants to send this to CC — [brief]"_ → **[Approve] · [Skip] · [Edit brief]**.
- **Autonomy control (Settings):** segmented **Ask · Auto-for-safe · Full-auto** (full-auto still bounded by §4.11 + kill switch).
- **Clarification:** the existing slash-command system (`/clear`, `/new`, `/regen`, `/unlock`, …) stays for its current functions; the dispatch surface is **chips-only** — do **not** add a `/dispatch` command.

### 4.8 The Autonomy Ladder

- **Graduate on evidence, per category** — but bounded against being a value-gate bypass:
  - Require a **minimum sample size AND a low false-dispatch rate** (not a raw approval streak).
  - **Any** worker `failed` / operator-Skip / operator-correction **immediately demotes** the category to Ask.
  - **Never auto-graduate while Full-auto is selected.**
  - Newly-graduated categories run under a **tighter probation budget**.
- Reconcile with §9's deliberate over-escalation bias (which can train rubber-stamping): the ladder counts **outcomes**, not chip taps alone.

### 4.9 The Teaching Loop

#### 4.9.1 Persona / method artifact

A canonical **source** describing how Sully behaves (tone, warmth, operator-comms style, dispatch judgment), with **per-runtime renderings**: a cloud-prefix form (Anthropic cache breakpoints), a local-prefix form (Ollama KV reuse), and a retrievable L4 object. Only the _source_ is single; do not promise byte-identical reuse across runtimes from one literal.

#### 4.9.2 Episode capture → memory L2 (episodic)

Each meaningful turn → `{ ask, decision, worker_actions, outcome, operator_reaction, trace_id }`, stored in Sully's **local** L2 (companion.db).

#### 4.9.3 Skill acquisition → memory L4 (procedural, LOCAL ONLY)

Recurring, proven patterns distilled into reusable skills the apprentice can load. **L4 stays local to Sully** — the team pool has no procedural/skills table or write API, so skills do **not** cross the boundary.

#### 4.9.4 Graduation scorer (objective, not teacher-similarity)

The apprentice's readiness is scored on **objective operator-outcome signals already logged in §4.2** (dispatch succeeded / operator approved / a local answer got corrected) — **not** text-similarity to the teacher (non-deterministic, undefined metric). This makes §4.8 and §4.9.4 genuinely the same mechanism. **Eligibility is bounded:** only deterministic/low-judgment categories can graduate locally; persona/judgment turns stay on the cloud teacher.

#### 4.9.5 Handoff — the real payoff (VRAM narrative corrected)

Pre-graduation the brain is cloud Opus (**0 local VRAM**); post-graduation the apprentice is **resident** and **adds** local VRAM pressure (contending with voice's ~14.6 GB peak — §8). So graduation does **not** "free VRAM." The real payoff is **quota/cost reduction, lower latency, and offline capability.** During a voice session, only one model can be resident: specify that voice mode **evicts** the apprentice on-demand (the pattern voice already uses) and the apprentice cold-reloads on voice exit.

### 4.10 4-layer memory seams + the team-pool question

- **Layers** (full schema deferred): **L1 Working** (exists) · **L2 Episodic** (§4.9.2) · **L3 Semantic** (embeddings via `mxbai-embed-large`) · **L4 Procedural** (§4.9.3, local only).
- **L3 must not swap the GPU:** with one resident model, synchronously embedding on the turn path forces an unload/reload (multi-second cliff). Run the embedder **CPU-resident** (mirrors Silero VAD's CPU pinning) or query a precomputed vector index; gate L3 retrieval **behind the rule pre-filter** (only on flagged ambiguity), not every turn.
- **Team-pool dual-write — OPEN QUESTION, not a Phase-1 goal.** Verified: the local pool is already `companion.db` (distinct), and there is **no live companion→team path** (`observation_emit.ts` returns `{ok:false, reason:'companion_mode'}`). If pursued (Phase 3+):
  - Define a **narrow authenticated emit endpoint** (e.g. `POST /api/v1/observation`) that validates **one Tier-0 observation** through the redactor and **`append_chained`** to the hash-chained `agent_decisions.jsonl` (JSONL is source-of-truth; do **not** write the DB table directly à la the bypassing `observation_emit.ts`, and do **not** use generic `write_query`).
  - **Lossy by design:** flatten the local episode into one observation row — pick `observation_kind` from the closed enum `{what-worked|what-didnt-work|surprise|routing-correction}`, ≤2000 chars, kebab `task_shape` tags. Full structured episodes stay only in local L2.
  - **Enforced partition:** stamp a reserved `project_id` namespace (`sully-companion`) + `source='sully'` on every row; `synthesize_lessons.py` must **bucket/skip** Sully-sourced rows so chat/persona noise is not promoted into team lessons, and `hermes_injector` (which filters `WHERE project_id=?`) never leaks Sully episodes into unrelated workers' prompts.
- **"Hermes apprentice trains too" is downgraded to an open question.** The Orchestrator's `hermes_apprentice.py` is a _routing_ predictor that never reads observations; the observations consumer is `hermes_injector.py` (context-injection RAG). So the realistic benefit is "Sully's episodes become **retrievable team context** via `hermes_injector`," not "a Hermes model learns." Sully's local graduation and the Orchestrator pipeline share a **pattern, not a data path.**

### 4.11 Cost/quota brakes + spend telemetry

- **Auth reality:** teacher + workers run on **Max OAuth** (quota, not dollars). Max OAuth returns **no** spend figure, so brakes must use **countable** signals. The only _billed_ path (API-key fallback) is gated and off by default. Limits are **generous but bounded** (more dispatch = more training data) — not penny-pinching.
- **Brakes (all on from day one):**
  1. **Dispatch-count budget** — a real `dispatches_today` counter incremented **at dispatch time**, plus cumulative worker **wall-clock** per rolling window. (Replaces the dollar/predicted-token "budget," which measured a fiction.) In **Full-auto with the operator away, hitting the cap is a HARD stop** — dispatch halts and stays halted until the operator explicitly resets it; never auto-resume on a timed-out prompt.
  2. **429 circuit-breaker (the real quota signal).** Opus/Sonnet over Max OAuth return HTTP **429 `rate_limit_error`** on quota exhaustion. On the first 429 from the teacher/worker path: **trip a cooldown, halt ALL dispatch for a back-off window, surface "Sully hit her cloud quota — paused until <time>", and do NOT retry.**
  3. **Bounded retries — transient errors only.** Retry (default **2**) only `overloaded_error` / network / SSE-drop; **never** 429. Then `failed`.
  4. **Rate limiter (token-bucket).** Server-side, before the handoff POST: max 1 dispatch / N seconds and B / rolling minute, independent of daily budget and autonomy level (a fast loop or double-firing handler can emit a burst of distinct, valid dispatches in seconds; the listener has no per-caller cap).
  5. **No re-escalation by content fingerprint.** Hash the normalized `brief|category|target_repo`; block (or force an Ask-chip) on a match to a recent failed/cooldown dispatch, even under a fresh `trace_id`. Plus a per-conversation cap (max K dispatches in T minutes without operator re-confirmation). "Distinct task" = distinct fingerprint.
  6. **Deterministic value gate** (§4.2) — trivial/injected content never dispatches.
  7. **Two-level companion-LOCAL kill switch** (the `system_halt` mirror is inert here): (a) **gate** new dispatches AND (b) **abort in-flight** — iterate `working` rows by `trace_id`, POST cancel to the worker/listener, flip to `aborted`, stop the SSE stream. Backed by a companion-data-dir file or settings flag. **Phase-1 acceptance = "aborts an in-flight dispatch,"** not just "blocks a new one." If the listener cannot terminate a running worker, that is a named Phase-1 dependency.
- **Spend telemetry:**
  - **Phase 1:** a companion-app meter showing **dispatch count + wall-clock today** (countable, honest). Capture **actual** tokens from the worker's final usage where available; clearly label predicted-vs-actual so the meter is never silently fed router predictions.
  - **Console tracker (later):** the Console is a **separate repo** reading the team pool, so it surfaces nothing until the team-pool write (§4.10) lands and actual-token + per-category columns exist. Gate it on that phase.

### 4.12 Animated avatar (later phase)

- **Style (locked):** outline / terminal CRT line-art — stroke + phosphor glow + scanlines.
- **Character:** leading candidate **KAIJU** (original big-friendly-horned-monster, Sulley-spirited — _not_ the trademarked character); final pick deferred to a polish pass.
- **Accent → Theme system (later):** magenta (default) · phosphor · amber · cyan, selectable.
- **Tech:** **Rive** (state-machine-driven), fed the live job/voice state — the avatar _is_ the read-out. States: idle · listening · thinking · deciding · working · speaking · done · error.
- **Phasing:** its own phase; the core dispatcher ships without it.

---

## 5. Data flow (a real dispatch)

1. You send a message → brain answers; gate runs (rules → value gate → schema self-assessment in the same cloud call).
2. Dispatch chosen → value-gated → fingerprint-checked → rate-limited → schema-validated.
3. Autonomy: `Ask` shows chips (you approve) / `Auto-*` proceeds.
4. `pending_jobs` row `decided`; trimmed handoff POSTed (`dispatched → working`).
5. Worker streams rows → **activity writer** → SSE (`id: trace:seq`, heartbeat) → bubble.
6. Worker finishes → artifacts + final message + ref → bubble collapses (`done`).
7. Turn captured as a local L2 episode (+ local L4 skill if recurring). **Optionally** a lossy L2 observation is emitted to the team pool (§4.10, if that phase is built).
8. Objective outcome logged → autonomy ladder + spend meter update.
9. On app resume: recreate SSE with `Last-Event-ID` + reconcile the bubble against the job-store row.

---

## 6. Error handling

- **Malformed decision:** rejected at validation → answer/ask locally.
- **429 / quota:** circuit-breaker (§4.11 #2) — cooldown, halt-all, no retry.
- **Transient worker failure:** bounded retry (2), then `failed` with retry affordance; no self-re-escalation.
- **SSE drop / app resume:** recreate `EventSource` + replay by `seq` + reconcile via job-store GET (the correctness floor).
- **Cold local model:** surface a "waking Sully" state; re-warm on app focus. Ollama env (below) is a deployment precondition.
- **Budget hit / kill switch:** hard stop (budget) / gate + in-flight abort (switch); chat still works.

---

## 7. Token / quota efficiency

- **Deterministic routing first** — rules + value gate cost zero tokens.
- **Prompt caching is UNVERIFIED over OAuth — treat as explicit work.** Cached-read pricing and "cached tokens skip rate limits" are documented for API-key usage; not confirmed over `CLAUDE_CODE_OAUTH_TOKEN`. **Phase-1 acceptance check:** POST two identical-prefix requests via OAuth <5 min apart and confirm `usage.cache_read_input_tokens > 0`; if it fails, drop caching from the projection or use the API-key path for cached workloads. State savings as a **range** (idle gaps past the ~5 min TTL degrade to repeated cache-**write** penalties — request the **1 h TTL** for long dispatches). Keep the persona/canon/tool-defs as a byte-stable prefix; volatile suffix + run-id/timer **last**; never a timestamp early.
- **Local prefix/KV reuse** is free **only within continuous single-model residency** — any GPU model swap (reply↔embed↔classify, or voice's on-demand load/unload) discards the KV cache. So §8's swap-minimization rule is a _prerequisite_ for this win; it applies only to sustained multi-turn chat with no interleaved GPU calls.
- **Artifact + reference** — workers persist big output; pass back a short ref.
- **Summarizer for long briefs:** prefer the resident local model or a deterministic extractive/truncation summary (zero cloud tokens). **Forbid** a cloud summarization round-trip on the Max quota unless the brief exceeds a hard token threshold.

---

## 8. Hardware constraints (single 16 GB GPU) — with a real budget

- **Ollama env is a Phase-1 deployment PRECONDITION, set at the systemd level (drop-in `Environment=`), at boot — NOT in an error branch:** `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_KEEP_ALIVE=-1` (or 1h). The default is ~3/GPU; without this, Ollama can silently co-load reply + classifier + embedder + apprentice into a near-OOM box.
- **VRAM budget table** (commit to values in the plan; example targets, `num_ctx` and KV quant **fixed**, KV bytes folded in):

  | State                          | Resident GPU tenants                                               | Approx peak             |
  | ------------------------------ | ------------------------------------------------------------------ | ----------------------- |
  | Voice-ON                       | reply model + faster-whisper (tiny.en + small.en) + Chatterbox TTS | ~14.6 / 16.3 GB         |
  | Voice-OFF, teacher=cloud       | reply model only (Opus is cloud → 0 local for the brain)           | fits                    |
  | Voice-OFF, apprentice resident | apprentice (chosen quant/`num_ctx` + KV)                           | must be proven ≤ budget |

  **Implication:** with voice on there is **no room** for a resident classifier, embedder, or apprentice. Therefore: **the decision classifier rides the cloud Opus call** (§4.2), **the embedder runs CPU-resident** (§4.10), and **the apprentice is evicted during voice** (§4.9.5). Because `MAX_LOADED=1` makes every cross-model call a serial unload/reload (multi-second cliff), the design **minimizes distinct resident model names** to ideally one.

- **System RAM (32 GB) note:** since the embedder (and possibly classifier) move to CPU, confirm CPU tenants (embedder, Silero VAD, STT, Chatterbox/torch+CUDA context, SvelteKit) fit in 32 GB with margin — don't relocate the cliff.
- **Cloud-only concurrency.** Never two local models; fan heavy/parallel work to cloud.

---

## 9. Telemetry & calibration

Log every decision (category, confidence, escalated?, **objective outcome**, actual tokens where available). Tune the escalation threshold and the autonomy ladder on **the operator's own traffic**. Bias slightly toward over-escalation early (under-escalation = a confident-but-wrong local answer, the worse error for a companion) — but the ladder graduates on **outcomes**, not chip-tap streaks (§4.8).

---

## 10. Phasing

**Phase 1 is decomposed** (it bundled ~10 partly-independent subsystems with precondition blockers). Hard ordering:

- **1a — Unblocking layer:** companion dispatch enablement (new flag, replace the `+server.ts` short-circuit) + companion worker contract/route + the **activity writer**. _(Nothing streams until this exists.)_
- **1b — Backend:** `pending_jobs` + state machine + decision gate (rules + value gate + schema self-assessment + validation) + brakes (dispatch-count, 429 breaker, rate-limiter, fingerprint no-re-escalation, two-level kill switch). Pin starting defaults (retry = 2; a starting daily cap; value-gate heuristic = `est_scope:'single'` + low token estimate stays local). **Acceptance includes the schema-emission empirical test** (pass bar mirroring qwen2.5:7b 100 % vs qwen3.x 0/20).
- **1c — Frontend:** SSE (contract + headers + heartbeat + resolve-base) + **resume-reconciliation** + Working bubble + chips + Autonomy _Ask_ + the companion-app dispatch meter.
- Each sub-phase gets its own MVP acceptance slice (not one 11-clause list).

2. **Phase 2 — Autonomy ladder** (objective-outcome graduation, demotion, probation).
3. **Phase 3 — Teaching loop** (persona artifact, episode capture, local L4 skills) **and**, if approved, the **team-pool L2 emit** (§4.10) + the Console tracker.
4. **Phase 4 — Apprentice graduation** (local resident handoff; voice-eviction policy).
5. **Phase 5 — Animated avatar (Rive)** + accent **Theme** system + **APNs push** for the native app.
6. **Later project — full 4-layer memory** schema + retrieval.

---

## 11. Open questions / deferred

- Team-pool L2 emit (§4.10): build it at all, and the exact endpoint/partition contract — **open**.
- Teacher code path (router-with-OAuth-branch vs `consult_claude`-style direct) — decide in the 1a/1b plan.
- Final avatar character; daily dispatch-count + rate-limiter defaults (operator-tuned once real traffic exists).
- Whether the apprentice classify hop needs grammar-enforced decoding or a dedicated resident model — decided empirically in Phase 3/4.
- A real iOS notification channel (APNs vs PWA web-push subscription) — Phase 5.

---

## 12. Acceptance (per sub-phase)

- **1a:** an `@cc`/`@agy` (or gate-chosen) request actually reaches a worker on the companion; activity rows are written and readable by `trace_id`.
- **1b:** the gate proposes a dispatch on a qualifying request and refuses trivial/injected content; the schema-emission test passes; a 429 trips the circuit-breaker (halt-all, no retry); the kill switch **aborts an in-flight dispatch**; fingerprint + rate-limiter block a re-fired/looping dispatch; every decision is logged with its objective outcome.
- **1c:** the SSE bubble streams live activity through the `:8444` tailnet path and collapses to the final result; backgrounding-then-foregrounding **recreates the stream and reconciles the bubble** against the job store (no stale "working"); state survives a server restart; the companion-app meter shows dispatch count + wall-clock today. _(No push assertion — descoped.)_
