# Refactor Audit - Sully Backend

Audit target: deployed backend line `origin/cc/sully-backend-deployed` at `42325f416e26007b21d99ed87019797f8cc1fb6d`.

Scope: `src/lib/server/**` and `src/routes/api/**`. This is read-only analysis; no application code was changed.

## Top 5 Highest-Impact

1. **Split the SDK streaming route into path handlers and a shared stream finalization helper.** `src/routes/api/chat/sdk-stream/+server.ts` is 1,185 lines; `POST` alone is about 861 lines with six reply/persist branches and repeated `data-sully-reply-id` terminal frame logic at lines 285, 518, 687, 854, 896, and 1117. EFFORT L / IMPACT high. PR batch: `stream-route-split`.
2. **Collapse legacy `/api/chat` and SDK-stream turn setup into one chat-turn service.** `src/routes/api/chat/+server.ts` still carries a 559-line `POST` that duplicates target-repo detection, history slicing, image generation, dispatch prompt assembly, and provider routing now partly centralized in `src/lib/server/chat/stream_prepare.ts`. EFFORT L / IMPACT high. PR batch: `chat-turn-consolidation`.
3. **Extract reusable dispatch prompt/history builders.** The worker prompt and reply-protocol blocks are embedded separately in `src/routes/api/chat/+server.ts:454` and `src/routes/api/chat/workflow/+server.ts:113`; reset-marker history slicing is repeated in `/api/chat` at lines 301, 345, 438 and in workflow at lines 76-94. EFFORT M / IMPACT high. PR batch: `dispatch-prompt-builder`.
4. **Unify artifact metadata/read-path ownership.** Artifact type maps and classifier functions exist in both `src/lib/server/artifactStore.ts:154` and `src/routes/api/artifacts/_artifactService.ts:71`; the route service also defines its own `ArtifactMetadata` instead of importing the store type. EFFORT M / IMPACT high. PR batch: `artifact-service-unification`.
5. **Create a voice/TTS service layer for repeated local synthesis, restart, SSE, and persistence code.** `src/routes/api/chat/voice-reply/+server.ts` is 435 lines, `src/lib/server/chat/voice_stream.ts` is 431 lines, and local TTS retry logic appears in both `src/routes/api/chat/speak/+server.ts:33` and `src/routes/api/chat/speak-local/+server.ts:51`. EFFORT L / IMPACT high. PR batch: `voice-service-extraction`.

## 1. Structure & Module Boundaries

### 1.1 SDK stream route is an orchestration module, not a route

Concrete finding: `src/routes/api/chat/sdk-stream/+server.ts` is 1,185 lines. Its exported `POST` at `src/routes/api/chat/sdk-stream/+server.ts:325` owns body parsing, image short-circuiting, model/auth selection, CLI streaming, local model escalation, direct SDK streaming, tool wiring, reply persistence, artifact promotion, orphan rollback, and autonomous dispatch side effects.

Suggested refactor: keep `+server.ts` as parse/validate/dispatch only. Move branch handlers into server modules such as `chat/sdk_image_reply.ts`, `chat/sdk_cli_reply.ts`, `chat/sdk_local_reply.ts`, and `chat/sdk_direct_reply.ts`. Extract a small helper for "persist assistant turn, emit reply id, finish stream" because the same sequence repeats across branches.

EFFORT: L. IMPACT: high. PR batch: `stream-route-split`.

### 1.2 Legacy `/api/chat` route still owns multiple generations of behavior

Concrete finding: `src/routes/api/chat/+server.ts` is 632 lines; `POST` starts at `src/routes/api/chat/+server.ts:74` and runs through line 632. It includes legacy direct chat, Hermes, image generation, companion-native dispatch, kernel-gateway dispatch, target repo selection, dispatch prompt construction, and response shaping. Several responsibilities now also exist in `stream_prepare.ts`, `autonomous_dispatch.ts`, and `workflow/+server.ts`.

Suggested refactor: first extract pure helpers without changing behavior: `resolveChatRequestMode`, `buildHistorySinceReset`, `buildRouterMessages`, `legacyImageReply`, and `kernelDispatchRequest`. Then delete only after the SDK route fully replaces the legacy path.

EFFORT: L. IMPACT: high. PR batch: `chat-turn-consolidation`.

### 1.3 Database table ownership is split across feature helpers

Concrete finding: `chat_thread_meta` schema creation lives in `src/lib/server/thread_meta.ts:38`, but `src/lib/server/chat.ts:276` and `src/lib/server/chat.ts:341` also create the table; `chat.ts:290` repeats the `deleted_at` migration. This makes schema drift likely because different call sites create slightly different table shapes.

Suggested refactor: move all chat thread schema bootstrapping to one `chat_schema.ts` or expose `ensureThreadMetaTable(db)` from `thread_meta.ts`, then call that helper from search/list code.

EFFORT: M. IMPACT: med-high. PR batch: `db-schema-ownership`.

### 1.4 Artifact store and artifact API service overlap

Concrete finding: artifact write/store ownership is in `src/lib/server/artifactStore.ts` (495 lines), while `src/routes/api/artifacts/_artifactService.ts` (529 lines) owns read/list/serve/bundle support. The route service imports store helpers at `_artifactService.ts:14` but then redefines metadata shape and classifiers locally at `_artifactService.ts:18` and `_artifactService.ts:71`.

Suggested refactor: move route-independent read/list/bundle helpers under `src/lib/server/artifacts/` and leave `src/routes/api/artifacts/**/+server.ts` as thin HTTP adapters. Import `ArtifactMetadata` and `classifyArtifactType` from the store-side module.

EFFORT: M. IMPACT: high. PR batch: `artifact-service-unification`.

### 1.5 `dispatchJobs.ts` is a full task lifecycle subsystem in one file

Concrete finding: `src/lib/server/dispatchJobs.ts` is 666 lines. It owns schema creation (`getDb` at line 160), FSM transitions (`TRANSITIONS` at line 62 and `transition` at line 313), proposal storage/expiry (`markGatedProposal` at line 462, `expireProposalsForThread` at line 495), task query helpers, stale reaping, and synthesis state.

Suggested refactor: split by stable boundaries: `dispatch_jobs/schema.ts`, `dispatch_jobs/fsm.ts`, `dispatch_jobs/proposals.ts`, and `dispatch_jobs/queries.ts`. Keep a barrel export initially so callers do not churn in the first PR.

EFFORT: M. IMPACT: med-high. PR batch: `dispatch-jobs-modularize`.

## 2. Duplication & Consolidation

### 2.1 Reply persistence + stream terminal frames are repeated six times

Concrete finding: `persistAssistantTurn` and `data-sully-reply-id` emission repeat in `src/routes/api/chat/sdk-stream/+server.ts` at lines 285/317, 518/546, 687/711, 854/871, 896/916, and 1117/1159. Each branch hand-rolls the same guard: only emit a reply id if a row was persisted and the id is positive.

Suggested refactor: extract `persistAndEmitReplyId(writer, persistArgs)` or a smaller `emitReplyId(writer, replyId)` plus `finishWriter(writer, reason)`. Start with the no-behavior-change helper before splitting the route.

EFFORT: S. IMPACT: high. PR batch: `stream-finalization-helper`.

### 2.2 Reset-marker history slicing is repeated

Concrete finding: `/api/chat` has three local scans for the most recent `"--- NEW CONVERSATION ---"` marker at `src/routes/api/chat/+server.ts:301`, `src/routes/api/chat/+server.ts:345`, and `src/routes/api/chat/+server.ts:438`. Workflow dispatch repeats the same convention in `src/routes/api/chat/workflow/+server.ts:76`.

Suggested refactor: add `getHistorySinceReset(threadId, limit)` in a chat history module that returns rows and optional formatted text. This also reduces the chance that Hermes, router chat, worker dispatch, and workflow buttons drift.

EFFORT: S. IMPACT: high. PR batch: `chat-history-helper`.

### 2.3 Target repo detection exists in two places

Concrete finding: `detectTargetRepo` in `src/lib/server/chat/stream_prepare.ts:41` handles repo keywords plus `sully-workspace` artifact-routing phrases. Legacy `/api/chat` has a separate keyword chain at `src/routes/api/chat/+server.ts:167` that does not include the workspace/artifact rules.

Suggested refactor: call `detectTargetRepo` from the legacy route and remove the local branch once behavior parity is confirmed.

EFFORT: S. IMPACT: med-high. PR batch: `target-repo-helper`.

### 2.4 Dispatch prompt boilerplate is duplicated and long

Concrete finding: `/api/chat` builds a large worker prompt inline at `src/routes/api/chat/+server.ts:454`; workflow builds similar shared header/reply-protocol/footer text at `src/routes/api/chat/workflow/+server.ts:113`. Both embed observation instructions, `emit_chat_message`, terminal activity, and narration rules.

Suggested refactor: extract a `buildChatWorkerPrompt({ threadId, targetRepo, task, history, mode })` helper with templates for standard dispatch, critique, build, verify, and retry. Keep copy-paste-sensitive content in one tested string.

EFFORT: M. IMPACT: high. PR batch: `dispatch-prompt-builder`.

### 2.5 Artifact classifiers and metadata types are duplicated

Concrete finding: `ARTIFACT_TYPE` and `classifyArtifactType` are defined in `src/lib/server/artifactStore.ts:154` and again in `src/routes/api/artifacts/_artifactService.ts:71`. The metadata interface is defined in the store at `artifactStore.ts:130` and again in `_artifactService.ts:18`.

Suggested refactor: move MIME-only serving concerns to `_artifactService.ts`, but import type/classification from the store module.

EFFORT: S. IMPACT: high. PR batch: `artifact-service-unification`.

### 2.6 Local TTS retry/restart path is duplicated

Concrete finding: when cloud TTS is disabled, `/api/chat/speak` defines a local `synth` closure and restart/retry path at `src/routes/api/chat/speak/+server.ts:33`; `/api/chat/speak-local` defines a similar `synth` closure and restart/retry path at `src/routes/api/chat/speak-local/+server.ts:51`. `voice_stream.ts:216` has a third direct local TTS fetch path without the restart retry.

Suggested refactor: extract `synthesizeLocalTts({ text, voice, signal, padMs?, retryRestart? })` in `src/lib/server/voice_tts.ts`. Let HTTP routes handle response format only.

EFFORT: M. IMPACT: high. PR batch: `voice-tts-service`.

### 2.7 Provider/model auth logic is scattered

Concrete finding: SDK route model/auth selection lives in `src/routes/api/chat/sdk-stream/+server.ts:93` through `src/routes/api/chat/sdk-stream/+server.ts:164`; `src/lib/server/llm_router.ts` and `src/lib/server/providers/*` also carry provider-specific chat logic. `model_catalog.ts` centralizes ids, but auth and stream-path selection are still route-local.

Suggested refactor: create a provider factory that returns `{ model, modelId, path: 'direct' | 'cli' | 'local' }` for the SDK route. This gives tests a small surface for OAuth/API key behavior.

EFFORT: M. IMPACT: med-high. PR batch: `provider-factory`.

## 3. Dead / Unused Code

This category has less high-confidence deletion than the consolidation findings. I verified candidates with `rg` across `src` and `tests` and avoided flagging SvelteKit route exports, internal helpers referenced in their own files, or convention-driven files.

### 3.1 `src/lib/server/usage.ts` appears unreferenced

Concrete finding: `src/lib/server/usage.ts` exports `getUsageMetrics` at line 113, `getUsageHistory` at line 176, `getTicketLeaderboard` at line 296, and `getHourlyActivity` at line 343. `rg` found no external imports or references in `src` or `tests`. The active `/api/chat/usage` route uses `getTodayTokenUsage` from `thread_state` at `src/routes/api/chat/usage/+server.ts:5`, and `/api/chat/spend` uses `getSpend` from `src/lib/server/spend.ts` at `src/routes/api/chat/spend/+server.ts:7`.

Suggested refactor: confirm no historical UI route still imports it outside the audit scope; if clear, delete this file and any orphan `src/lib/types/usage` types in a dedicated cleanup PR.

EFFORT: S. IMPACT: med. PR batch: `dead-usage-cleanup`.

### 3.2 Old Gemini direct-chat helpers appear unused except image generation

Concrete finding: `src/lib/server/gemini.ts` still exports `callGeminiChat` at line 104, `chatRowsToGeminiHistory` at line 164, and `isGeminiAvailable` at line 313. `rg` found no external references to those names. The same file's `generateGeminiImage` at line 197 is live and imported by `/api/chat` and `/api/chat/sdk-stream` (`src/routes/api/chat/+server.ts:6`, `src/routes/api/chat/sdk-stream/+server.ts:73`).

Suggested refactor: keep `generateGeminiImage`; delete or move the unused AGY chat helpers after confirming no external dynamic import uses them. A smaller alternative is to split `gemini_image.ts` first and leave the old chat module for later deletion.

EFFORT: S. IMPACT: low-med. PR batch: `dead-gemini-chat-cleanup`.

### 3.3 L2 classifier scaffold is explicitly not wired live

Concrete finding: `src/lib/server/phase_classifier.ts:104` comments that L2 is scaffolded but not wired live, and `classifyTierL2` at line 108 returns `null`. `rg` found no external references to `classifyTierL2`.

Suggested refactor: either remove the scaffold or convert it into a tracked TODO with a test if the feature is still planned. This is low impact; do it only if it reduces confusion during classifier work.

EFFORT: S. IMPACT: low. PR batch: `classifier-scaffold-cleanup`.

### 3.4 Several exported maintenance helpers may only be future/API surface

Concrete finding: `markRetry` in `src/lib/server/dispatchJobs.ts:348`, `clearKill` in `src/lib/server/dispatchBrakes.ts:144`, and kill-switch mutators in `src/lib/server/kill-switch.ts:65` and `src/lib/server/kill-switch.ts:81` had no external references in `src` or `tests` from the grep pass. These are plausible admin/test hooks, so I would not delete them without checking deploy scripts and external callers.

Suggested refactor: mark intentionally exported maintenance APIs with comments/tests, or make them local if no external runtime calls exist. Do not bundle with high-risk refactors.

EFFORT: S. IMPACT: low. PR batch: `maintenance-export-audit`.

## 4. Complexity Hotspots

### 4.1 `sdk-stream` POST is the hardest path to reason about

Concrete finding: the crude branch/length scan measured `src/routes/api/chat/sdk-stream/+server.ts:325` at about 861 lines and 140 branch points. The handler contains nested manual stream writers, `onError`/`onFinish` callbacks, multiple early returns, and side-effect sequencing around rollback, persistence, and dispatch.

Suggested refactor: start by extracting pure helpers inside the same file, then move branch handlers once tests cover stream event order. High-risk behavior to preserve: orphan rollback, reused-turn guard, reply-id-before-finish, and no dispatch on errored empty turns.

EFFORT: L. IMPACT: high. PR batch: `stream-route-split`.

### 4.2 Legacy `/api/chat` POST is long and branchy

Concrete finding: the branch/length scan measured `src/routes/api/chat/+server.ts:74` at about 559 lines and 135 branch points. It still mixes request normalization, DB writes, dispatch gating, multiple chat providers, image generation, gateway dispatch, and response formatting.

Suggested refactor: split by mode after computing a small `ChatPostContext`: `handleHermes`, `handleConversationalChat`, `handleImageGeneration`, `handleCompanionDispatch`, `handleKernelDispatch`.

EFFORT: L. IMPACT: high. PR batch: `legacy-chat-route-split`.

### 4.3 Voice reply route combines lifecycle, prompt construction, streaming, truncation, and persistence

Concrete finding: `src/routes/api/chat/voice-reply/+server.ts:80` measured about 356 lines with 66 branch points. It owns dispatch proposal metadata, lifecycle preparation, prompt augmentation, realtime streaming path, truncation persistence, non-streaming fallback, and autonomous dispatch side effects.

Suggested refactor: extract `buildVoiceChatMessages`, `buildDispatchProposalMeta`, `handleStreamingVoiceReply`, and `handleBufferedVoiceReply`.

EFFORT: M-L. IMPACT: high. PR batch: `voice-reply-split`.

### 4.4 `companion_tools.getSensitiveTools` returns a large inline tool registry

Concrete finding: `src/lib/server/companion_tools.ts:68` measured about 196 lines with 45 branch points. It builds sensitive tool definitions and their implementations in a single closure, mixing schema/description with filesystem and command behavior.

Suggested refactor: split tool groups into modules: filesystem, web, dispatch/status, and allowlist. Keep `getSensitiveTools()` as the public aggregator.

EFFORT: M. IMPACT: med-high. PR batch: `tool-registry-split`.

### 4.5 `surfaceAdapter` activity humanization is branch-heavy

Concrete finding: `src/lib/server/surfaceAdapter.ts:434` measured about 74 lines but 42 branch points. The same file also has `liveSurfaceFromTrace` at line 18 and `buildPhases` at line 224, making it both data adapter and presentation-humanizer.

Suggested refactor: move activity label/humanization tables into a data-driven map and keep `surfaceAdapter` focused on assembling the surface model.

EFFORT: M. IMPACT: med. PR batch: `surface-adapter-humanizer`.

### 4.6 Manual ZIP creation is specialized complexity inside artifact service

Concrete finding: `_artifactService.ts:427` implements a 63-line store-only ZIP writer with CRC/date/central-directory logic. It is compact, but it is low-level binary code inside the artifact API service.

Suggested refactor: either move it to `src/lib/server/artifacts/zip.ts` with focused tests, or replace it with a small maintained ZIP library if adding a dependency is acceptable. The move-only path is safer.

EFFORT: S-M. IMPACT: med. PR batch: `artifact-zip-helper`.

## Suggested PR Order

1. `stream-finalization-helper`: extract reply-id/finish helpers inside `sdk-stream` with focused tests or snapshot checks.
2. `chat-history-helper` + `target-repo-helper`: low-risk consolidation shared by legacy route, workflow, voice/text paths.
3. `dispatch-prompt-builder`: centralize worker prompt boilerplate and history formatting.
4. `artifact-service-unification`: remove duplicated artifact types/classifiers and move route-independent artifact reads to server lib.
5. `voice-tts-service`: centralize local TTS fetch/restart/padding and then split `voice-reply`.
6. `dead-usage-cleanup` and `dead-gemini-chat-cleanup`: conservative cleanup after the structure work lands.
