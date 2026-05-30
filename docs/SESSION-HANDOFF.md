# Sully Companion — Session Handoff

**Last updated:** 2026-05-30 (CC) · **Read this + memory `project_companion_repos` to resume.**

---

## TL;DR
Two big things shipped this session:
1. **iOS Capacitor shell → TestFlight** (working, installed on the operator's iPhone). Branch `feat/ios-capacitor-shell`.
2. **4-layer memory, Layers 1–3** (shipped to `main`, tuned with `mxbai-embed-large`, verified across all providers).

**Next, in order:** ① Layer 4 (procedural memory) · ② frontend rebuild · ③ ship the iOS shell via **GitHub Actions** CI (vs Codemagic).

---

## Project shape
- **Sully** = local companion, 2 repos: `~/dev/LogueOS-Companion` (app, port 18769) + `~/dev/companion-speech` (STT :18770 / TTS :18771, on-demand to free GPU).
- **Design spec (source of truth):** `docs/superpowers/specs/2026-05-30-sully-companion-rebuild-design.md`.
- **Decisions:** native iPhone shell (Capacitor) + keep the proven backend; partner-first, hub-later; local-first now, Supabase fallback later; apprentice (Hermes-pattern) graduates into that fallback.
- **Chat brain:** `companion-v1` (qwen3:14b) via `COMPANION_DEFAULT_MODEL`. **Embed model:** `mxbai-embed-large`.
- **App URLs:** tailnet-only `https://room.taila28611.ts.net:8444/companion` (private; needs Tailscale + MagicDNS on the phone) · public Funnel `https://room.taila28611.ts.net/companion`.

## Live services
`logueos-companion.service` (:18769) · `logueos-companion-stt`/`-tts` (on-demand). Restart after backend changes:
`npm run build && sudo systemctl restart logueos-companion.service`

---

## Shipped this session

### A. iOS / Codemagic (branch `feat/ios-capacitor-shell`, NOT merged to main)
- Capacitor 8 thin shell that loads the remote tailnet URL; `ios/` generated fresh in CI (not committed).
- **Build pipeline GREEN**: build → sign → TestFlight. Build 1 = **shell + mic** (push deferred to Build 2). Installed + loads on the operator's iPhone.
- **I drive Codemagic via API** (no dashboard): token `CODEMAGIC_API_TOKEN` in `.env`; app id `6a1b197bbf681e121fb06056`; `POST https://api.codemagic.io/builds {appId, workflowId:"ios-testflight", branch:"feat/ios-capacitor-shell", environment:{variables:{CERTIFICATE_PRIVATE_KEY:<contents of ~/.codemagic_sully_cert_key.pem>}}}`; poll `GET /builds/{id}`; logs via the `*_artifacts.zip` artefact (`-L` redirect to GCS).
- **Apple:** bundle `com.dreighto.sully` · Team `G3KJW4VXM9` · ASC API key `R8SY4X6JM4` (Codemagic integration named **`LogueOS`**) · Apple ID `6775013884`. TestFlight test-info filled (external submit now green).
- **Runbook:** `docs/ios-build-runbook.md`. **Sealed gotchas:** Cap8 defaults to SPM → `cap add ios --packagemanager CocoaPods`; fresh account had no dist cert → pass `--certificate-key`; integration name = `LogueOS`; Codemagic billing must be enabled (premium `mac_mini_m2` is paid ~$0.20/build); `xcode: latest`; **iCloud Private Relay breaks MagicDNS** so the phone can't reach the tailnet URL until it's off.

### B. 4-layer memory, Layers 1–3 (on `main`, committed)
- **L1 working** (`working_memory.ts`): rolling summary of pre-hot-window history → folded into the system prompt; regenerates in the background after assistant turns (≥30 msgs, every 10).
- **L2 episodic** (`episode_extractor.ts`): `remember_flag` → LLM extracts Captain-facts → embedded. Wired into the remember route.
- **L3 semantic** (`semantic.ts`): `mxbai-embed-large` embeddings, cosine recall, threshold `0.42` (`COMPANION_SEMANTIC_THRESHOLD`), per-fact `embed_model` tag.
- `buildSystemPrompt` is **async** now (`chat_prompt.ts`); both call sites awaited. Schema in `bootstrap.ts` (`episodic_facts`, `episodic_embeddings`).
- **Verified:** cross-provider recall (local/Sonnet/Opus/Gemini/Auto = 9/9, incl. oblique queries); memory rides in the **system prompt** so it persists regardless of model; Auto → `companion-v1` (local).

---

## NEXT — roadmap

### ① Layer 4 — Procedural memory (the immediate next task)
The seam is ready (`buildSystemPrompt` already composes layers). What's needed is a **design + impl**:
- The orchestrator's `lessons` table is **not** in `companion.db` and is team-ops advice (irrelevant) — do NOT read it.
- Create a **companion-owned** rules store (e.g., `sully_rules` table) + a writer (operator-authored "always do X" rules? and/or promotion from high-importance episodic facts?) + inject as `## Rules I follow:` in `buildSystemPrompt`.
- Decide the population mechanism before building. This is a brainstorm-worthy design question.

### ② Frontend rebuild (all LOCAL — zero CI)
Per the spec: tokenize the magenta brand (kill ~30 hardcoded hex), decompose the 1,200-line `chat/+page.svelte` into `MessageFeed`/`MessageBubble`/etc., clean-&-premium reply treatment, shared `IconButton`/`Popover`, focus-visible, fix the lime markdown-link bug. Use the `frontend-design` skill. **Loop:** edit → `npm run build` + restart → operator reopens Sully on phone (loads remote URL; no reinstall, no CI). Audit findings live in the 4-way review (this session's transcript) — re-run if needed.

### ③ Ship iOS via GitHub CI
- **Build 2 = push notifications:** add `@capacitor/push-notifications`, the `aps-environment` entitlement in `ci-ios-patch.sh`, the `plugins.PushNotifications` block in `capacitor.config.ts`, register/listener code in the **web app** (guarded by `Capacitor.isNativePlatform()`), and wire the APNs `.p8` into the push dispatcher. Also gate the web SW off in native.
- **GitHub vs Codemagic:** prep `.github/workflows/ios-testflight.yml` (macOS runner; secrets: ASC API key + `CERTIFICATE_PRIVATE_KEY`); fire both on Build 2 and compare cost/time. Codemagic `mac_mini_m2` is paid; GitHub macOS = 10× minute multiplier (~200 effective free min/mo). Confirm exact pricing when wiring.

---

## Landmines (don't re-learn these)
- `buildSystemPrompt` is **async** — any NEW caller must `await` it and pass the user message, or you get `[object Promise]` in the prompt.
- Semantic recall filters by `embed_model` — **changing the embed model orphans existing vectors** (re-embed needed). `ollama pull mxbai-embed-large` is required.
- `serverConfig.memoryDbPath` default in `config.ts` is the **shared orchestrator DB**; the `.env` `LOGUEOS_MEMORY_DB_PATH` override → the private `companion.db`. Keep the override or personal facts leak into the team DB.
- `chat_messages.sender` values are `operator`/`local`/`cc`/`agy` — **never** `user`/`assistant`.
- The iOS shell loads the **remote** URL — so frontend changes deploy by rebuilding the web app locally; only **native** changes (push, plugins, icon, permissions) need a CI build.

## Parked decisions
- `submit_to_testflight: true` (left as-is; works now). server.url = tailnet `:8444` (private). Layer 4 design open. Build-2 push design open.
