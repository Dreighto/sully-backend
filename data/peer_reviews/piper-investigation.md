# Piper TTS Investigation

**Generated:** 2026-06-03  
**Researched by:** CC (VP Ops)

---

## Bottom Line Up Front

Piper cannot replace Chatterbox for the current use case. The reason Chatterbox is here is voice cloning — Piper has none. Swapping it in as the fallback would mean Emma's fallback sounds like a different person, and Goodman-Sulley disappears entirely. The VRAM problem is real but Piper is the wrong lever to pull.

The right lever is already identified in the prior diagnostic: **don't start Chatterbox at all unless ElevenLabs caps out.** That reclaims the same 3.2 GB without changing a voice or degrading quality.

---

## Why Chatterbox Was Chosen

There's no "we evaluated Piper and ruled it out" commit — it was never a candidate. The initial TTS proxy commit (May 29, `2ab26c9`) named Chatterbox from the start, and the voice catalog commit (`6a17f97`) makes the actual requirement explicit in the message:

> "Goodman-Sulley clone is local-only + private personal use (ElevenLabs won't clone it)."

Two things were needed that forced zero-shot cloning:

1. **Emma fallback** — when ElevenLabs caps out, the fallback needs to still sound like Emma. That requires cloning from the `emma.mp3` reference clip. You can't get there with a fixed pre-trained voice.

2. **Goodman-Sulley** — ElevenLabs declined to clone it, so it could only exist as a local voice. Zero-shot cloning from `sully_goodman.wav` was the only path.

Piper can't do either of those. It ships with pre-trained voices and stops there. Chatterbox wasn't chosen over Piper — Piper wasn't in the running because it doesn't clone.

---

## What Piper Actually Is

Piper is a VITS-based TTS engine from the Rhasspy project, purpose-built for edge and embedded devices. It exports models to ONNX and runs inference on CPU. The design priority is speed on constrained hardware, not quality or flexibility.

| Property              | Piper                                  | Chatterbox (current)                                |
| --------------------- | -------------------------------------- | --------------------------------------------------- |
| **VRAM at inference** | **< 500 MB** (usually 0 — CPU)         | 3,255 MiB (measured)                                |
| **Voice cloning**     | **None**                               | Zero-shot from ~5s clip                             |
| **Quality**           | Good — "robotic on prosody-heavy text" | Excellent — beats ElevenLabs in blind tests (65.3%) |
| **Inference speed**   | Real-time on CPU                       | RTF ~0.55 on the 5060 Ti                            |
| **Available voices**  | 100+ pre-trained                       | Any voice you have a clip for                       |
| **Parameters**        | 28–90M (per voice model)               | 500M (full), 350M (Turbo)                           |
| **Model file size**   | 10–75 MB                               | ~3.5 GB on disk                                     |
| **GPU required**      | No                                     | Yes (CUDA)                                          |
| **License**           | MIT                                    | MIT                                                 |

The VRAM figure for Piper at inference is effectively **zero on GPU** — it runs through ONNX Runtime on CPU by default. You could load it alongside everything else and it would consume CPU RAM (under 500 MB) rather than eating into the 16 GB budget at all.

---

## The Cloning Gap Is Not Bridgeable at Runtime

This is the central problem. There is a workflow called Piper Express Clone that can produce a custom Piper voice from a reference clip, but it is a training pipeline:

1. Use Chatterbox to synthesize 1,500+ audio clips in the target voice from the reference
2. Fine-tune a Piper model on that synthetic dataset (~300–500 epochs)
3. Export to ONNX

This takes **2–4 hours on a GPU** and produces a standalone `.onnx` file. It is not zero-shot — you do the work once offline, get a fixed model, and then Piper runs it cheaply forever. This could be a path for Goodman-Sulley (you'd train the model once, bake it in), but it cannot replace the Emma fallback dynamically because Emma is used as a voice clone of whatever reference clip the operator provides.

More importantly: if you went this route for Goodman-Sulley, you'd still need Chatterbox on the box to run Stage 1 of that pipeline.

---

## What It Would Actually Look Like to Swap Piper In

If you decided to use a baked-in Piper voice as the ElevenLabs fallback instead of a Chatterbox clone of Emma, here's what changes:

**On the Python side (`companion-speech/`):**

- Replace `tts_server.py` with a Piper HTTP wrapper (or use `piper` CLI via subprocess)
- No reference clip parameter — voice is baked into the `.onnx` file at load time
- Response would be WAV at 22050 Hz instead of 24000 Hz (minor, handled in `_wav_bytes`)

**On the SvelteKit side:**

- `voices.ts`: remove `fallbackVoiceRef` and per-voice synthesis knobs from Emma's entry
- `speak/+server.ts`: remove the `voice_ref` / `cfg_weight` / `exaggeration` / `temperature` forwarding
- No other route changes — the HTTP contract (`POST /tts {text}` → `audio/wav`) stays the same

**What you lose:**

- Emma fallback sounds like whoever the Piper voice is (a noticeably different person)
- Goodman-Sulley voice goes away unless you run the Express Clone training pipeline offline first
- Quality drops from "Excellent / beats ElevenLabs" to "Good / sounds robotic on expressive text"

**What you gain:**

- Zero GPU VRAM at inference time
- No cold-start penalty at all (Piper loads in under 1 second, model is tiny)

---

## Alternatives Worth Considering

If the goal is purely VRAM recovery, there are better paths than Piper:

### Option 1: Just don't pre-start Chatterbox (Fix 1 from prior diagnostic)

This is the right fix. When ElevenLabs is configured and the daily cap isn't hit — which is almost always — skip starting Chatterbox on `enter()`. If the cap is ever exhausted mid-session, cold-start on demand (~21s, disruptive but rare). **Reclaims 3.2 GB, keeps all voices intact, zero quality change.**

### Option 2: Chatterbox Turbo as a drop-in

Resemble AI's 350M Turbo variant uses ~4 GB VRAM (slightly more than current based on external benchmarks, but with faster generation). Not a VRAM win, but worth watching for a future swap since it supports paralinguistic tags like `[laugh]`.

### Option 3: F5-TTS

~335M parameters, zero-shot voice cloning, ~3–4 GB VRAM. Directly comparable to Chatterbox's capability at somewhat lower cost. The integration work would be similar to the current Chatterbox setup (HTTP server, WAV output, reference clip). This would be a real Chatterbox replacement if you want to trade some quality for less VRAM.

### Option 4: Piper for Goodman-Sulley only (after offline training)

If you run the Express Clone pipeline offline (2–4 hours, uses the GPU once), you get a 75 MB ONNX model that speaks in Goodman's voice at CPU speed, zero VRAM. Chatterbox would still be needed for Emma's fallback. Net effect: Goodman-Sulley moves to CPU, Emma fallback stays on GPU. Partial win.

---

## Summary

| Question                                             | Answer                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Why was Chatterbox chosen over Piper?                | Zero-shot cloning was the requirement. Piper doesn't clone.                                       |
| Can Piper replace Chatterbox as the fallback?        | Not without losing voice identity and quality.                                                    |
| Piper VRAM vs Chatterbox VRAM                        | Piper: ~0 MB GPU / <500 MB CPU. Chatterbox: 3,255 MiB GPU.                                        |
| Is voice quality comparable?                         | No. Piper is "Good" / robotic on expressive text. Chatterbox beats ElevenLabs in blind tests.     |
| Is there a bad-fit issue for current setup?          | Yes — no cloning means no Emma fallback and no Goodman-Sulley.                                    |
| Best path to reclaim VRAM without breaking anything? | Fix 1: skip Chatterbox startup when ElevenLabs is active. Same voices, same quality, 3.2 GB back. |
