# Sully Vision / Multimodal — Design Spec

- **Date:** 2026-05-31
- **Status:** Approved (2026-05-31). Operator decisions: **student vision = `qwen2.5-vl:7b` on-demand** (load per image-turn, unload after, evict for voice); **sequencing = build after the dispatcher core** (Phase 1 1a/1b/1c) lands. Teacher vision rides the 2026-06-15 Agent SDK swap.
- **Repo:** LogueOS-Companion ("Sully")
- **Related:** `2026-05-31-sully-dispatcher-design.md` (teacher seam §4.1/§13, decision gate §4.2, VRAM §8, on-demand eviction §4.9.5).

---

## 0. Ground truth (verified 2026-05-31)

The multimodal pipeline is **~80% built** — the gaps are specific and small.

**Already works:**

- **Upload UI** — file picker (`accept="image/*"`), drag-drop, paperclip, attachment chips (`Composer.svelte:312-320`, `chat/+page.svelte:524-527`). On send, attachments become markdown `![file](url)`.
- **Server multimodal** — `multimodal.ts:23-76` `buildMultimodalContent()` extracts markdown image URLs → base64 `ContentPart[]`. The LLM router accepts `ContentPart[]` (`llm_router.ts:50-56`). **All providers implement image content:** Anthropic (`providers/anthropic.ts:30-31`), Gemini (`gemini.ts:131`), OpenAI, and **Ollama** (`providers/ollama.ts:42-46` already splits images into the Ollama `images` base64 array).
- Upload endpoint exists (`api/chat/uploads/+server.ts`).

**The three real gaps:**

1. **Streaming endpoint doesn't wire it.** `api/chat/sdk-stream/+server.ts:478` uses `convertToModelMessages()` and **never calls `buildMultimodalContent()`** → attached images stay literal markdown text and never become image parts. So even Gemini/Haiku (which _can_ see images) don't, on the streaming path.
2. **The CLI-bridge teacher is text-only.** `claude_cli_stream.ts:148-195` writes a text `userPrompt` to stdin; there is no image-input mechanism. Claude Code's CLI has no `--files`/stdin image support (confirmed upstream issue). So **Opus/Sonnet-via-CLI cannot see images today.**
3. **Image-gen is text-only.** `gemini.ts:203` `generateGeminiImage(prompt: string)` takes no reference image; the `imageMode` branch (`chat/+server.ts:340-357`) doesn't forward attachments. (Gemini 2.5 Flash Image supports **up to 3 reference images** for editing/fusion via `inlineData` parts.)
4. (Minor) No image persistence in the chat DB — images live only as markdown URLs; chips clear after send.

---

## 1. Goals

- The operator can attach images (mockups, screenshots, references) and have the model **see** them — both the **student** (local) and the **teacher** (cloud Opus).
- **Image-gen accepts reference images** (image-to-image / editing), not just text→image.
- All of it respects the single-16GB-GPU budget (voice peaks ~14.6 GB) and the one-warm-model invariant.

## Non-goals

- Image-based _training_ of the shadow loop (text-only today; deferred per dispatcher spec §4.10 — note the existing roadmap memory `image_training_planned`).
- A second resident local vision model (would break the VRAM budget).

---

## 2. Design decisions

### 2.1 Input vision — who sees images

- **Cloud reasoning on images → Gemini, now.** Gemini is vision-capable and already wired; the only fix needed is closing gap #1 (wire `buildMultimodalContent()` into the streaming path). This unblocks cloud image-understanding **immediately**, with no new model.
- **Local image turns → `qwen2.5-vl:7b`, on-demand.** Keep the resident text student (`qwen2.5:7b`, ~4–5 GB). When an image is attached and the turn is local, **load `qwen2.5-vl` on-demand** (~7–7.5 GB Q4), run the turn, then unload. Ollama's image path already exists (`providers/ollama.ts`), so this is `ollama pull qwen2.5-vl` + routing + load/unload. **Never two resident models**; evict the VLM during voice (extends the apprentice eviction pattern, dispatcher §4.9.5).
- **Teacher (Opus) vision → via the Agent SDK after 2026-06-15.** The CLI bridge can't pass images; the Agent SDK supports native image content blocks (`{type:'image', source:{type:'base64',...}}`). So **teacher-sees-images comes for free with the already-planned teacher-seam swap** (dispatcher §13). Interim: image turns that need cloud reasoning route to **Gemini**, not CLI-Opus.

### 2.2 Routing (a deterministic gate signal, not a new classifier)

Add an **`imageAttached`** boolean to the decision gate (dispatcher §4.2, alongside the value gate — deterministic, model-independent):

- text turn → resident text student / normal tier.
- image turn, local → `qwen2.5-vl` on-demand (load → run → unload; log the swap to `pending_jobs`).
- image turn, cloud → Gemini now; Opus via Agent SDK post-June-15.

### 2.3 Image generation — reference-image input

- Extend `generateGeminiImage(prompt, referenceImages?)` to accept up to 3 base64 reference images as `inlineData` parts (Gemini 2.5 Flash Image editing/fusion).
- In the `imageMode` branch (`chat/+server.ts:340`), forward image-MIME attachments (fetched from the uploads dir, base64) to `generateGeminiImage`.
- Composer toggle: **text→image** vs **image→edit** when `imageMode` is on.

---

## 3. Phasing

- **V0 — Ops (1 min):** `ollama pull qwen2.5-vl:7b` on ROOM (no code).
- **V1 — Quick wins (standalone, buildable now; do NOT conflict with the dispatcher backend build):**
  - V1a: wire `buildMultimodalContent()` into `sdk-stream/+server.ts` before the model call → unblocks Gemini/Haiku vision. _(Touches `sdk-stream`; sequence AFTER dispatcher task 1b.6 which also edits the chat POST, to avoid a merge clash.)_
  - V1b: `generateGeminiImage` reference-image input + `imageMode` attachment forwarding + composer toggle.
- **V2 — Local vision routing:** the gate's `imageAttached` signal → on-demand `qwen2.5-vl` load/unload, with voice eviction. _(Builds on the dispatcher decision gate, §4.2.)_
- **V3 — Teacher vision:** rides the 2026-06-15 Agent SDK teacher-seam swap (dispatcher §13) — `callTeacher()` passes image content blocks to Opus.
- **V4 — Polish:** chat-DB attachment metadata + history thumbnails + auto-select a vision model when images are attached.

## 4. Model-picker tie-in

This makes vision-capable models first-class in the **role-organized model picker** (the earlier cleanup): the "image turn" path advertises which vision model is active (local `qwen2.5-vl` / cloud Gemini / Opus). Curate, don't dump.

## 5. VRAM check (why this is safe)

| State              | Resident                                  | Peak      |
| ------------------ | ----------------------------------------- | --------- |
| Voice ON           | reply + STT + TTS                         | ~14.6 GB  |
| Text turn          | `qwen2.5:7b`                              | ~4–5 GB   |
| Image turn (local) | `qwen2.5-vl:7b` on-demand (unloads after) | ~7–7.5 GB |

Never two residents; the VLM is on-demand and evicted for voice. Teacher vision is cloud (0 local VRAM). Throughput on the 5060 Ti: ~50–80 tok/s for a 7B VLM at Q4.

---

## 6. Acceptance

- **V1a:** attach an image, send on the streaming path → the model's reply references the image content (not "I can't see it"). Verified on Gemini.
- **V1b:** with `imageMode` + an attached reference image → the generated image is an edit/fusion of the reference, not an unrelated text→image.
- **V2:** an image turn on local tier loads `qwen2.5-vl`, replies about the image, and unloads (verify VRAM returns to baseline); voice still works after.
- **V3:** post-June-15, an image attached to a teacher turn is seen by Opus via the SDK.
