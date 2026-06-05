# Jetson Orin Nano Super — speech-stack research (STT + TTS), headroom-aware

**Date:** 2026-06-05 · **Method:** deep-research harness (6 angles, 25 sources fetched, 112 claims → 25 verified by 3-vote adversarial check → 9 confirmed / 16 refuted). · **For:** the voice-on-Jetson decision (alongside the NIC fix + the running benchmarks).

## Bottom line (the answer to "what should we run + is the trade worth it?")

**Recommended pairing — STT: `whisper.cpp large-v3-turbo` (q8_0, or f16 if it fits) · TTS: `Piper` (ONNX, CPU). Drop Kokoro.** **Yes — swapping Kokoro for a lighter TTS to enable a better STT is the right trade, and it's worth it.**

**Why it works (the memory lever):** Kokoro-82M is measured at **~2,900 MB always-on** (the `<1 GB VRAM` quote is weights-only; PyTorch CUDA FP16 runtime inflates it). **Piper runs on the CPU cores in `<100 MB` and consumes ZERO of the GPU/unified-VRAM headroom Kokoro was eating** — net **~2.7–2.8 GB freed**. That's exactly the headroom that was forcing STT down to `medium.en-q5_0` (because `medium.en-f16` OOMs today). With Kokoro gone you can run a _bigger_ model at _higher_ precision.

## Memory math (estimate — must verify on-box, see caveat)

|                                                                                          | RSS                                                                               |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| OS + always-on services (VAD, wakeword, MiniLM, bridge/health/watchdog)                  | ~1,800 MB                                                                         |
| STT — large-v3-turbo q8_0/f16 (whisper.cpp, quantized — NOT the ~6 GB desktop FP figure) | ~2,000–2,800 MB (est.)                                                            |
| TTS — Piper (CPU)                                                                        | <100 MB                                                                           |
| **Always-on total (speech up, on-demand idle)**                                          | **~3.9–4.7 GB** → **~2.9–3.7 GB free** ✅ (above your 1.5–2 GB target)            |
| When on-demand (OCR/YOLO/Qwen, up to ~2.16 GB) also active                               | headroom tightens to ~0.7–1.5 GB → **drop STT to distil-large-v3** in that window |

## The options, ranked (verified)

- **STT winner: `large-v3-turbo`** — 809M params, ~0.35pp WER behind full large-v3, the best English accuracy that fits once Kokoro's freed. Build with `-DGGML_CUDA=1 -DCMAKE_CUDA_ARCHITECTURES=87` (the `=87` is mandatory — confirmed at source level; whisper.cpp #3357).
- **STT fallback: `distil-large-v3`** (756M, ~49% smaller) — use ONLY for footprint/speed when on-demand services crowd memory. ⚠️ Its "within 1% WER of large-v3" claim was **REFUTED (0-3)** — treat it as lighter, NOT accuracy-equal; don't assume it beats medium-q5 on proper nouns without testing.
- **TTS winner: `Piper`** (e.g. `en_US-lessac-medium` 63 MB / -high 114 MB) — real-time on CPU, frees the 2.8 GB. Quality is the one subjective trade (see caveat).
- **RULED OUT: NVIDIA Riva / Parakeet / Canary / Magpie TTS** — infeasible on 8 GB. Parakeet ASR ~4.3–6.8 GB; Riva TTS needs ~16 GB VRAM / OOM-killed on Orin Nano (NVIDIA first-party docs + forum reports). High confidence. Don't chase the "NVIDIA-native" path on this box.
- **WhisperTRT, Canary-Qwen, Parakeet-as-fast-Jetson-option** — claims refuted/disputed in verification; don't rely on them.

## Important caveats (what this research did NOT settle — the on-box tests to run)

1. **Quantization-accuracy is UNRESOLVED.** Claims that whisper quantization preserves WER were **REFUTED (0-3)**. So your hypothesis that `q5_0` hurt recognition is _plausible but unconfirmed_. The recommendation **hedges** by upgrading BOTH model size (medium→turbo) AND quant level (q5→q8/f16) rather than betting quant is lossless.
2. **The on-device RSS of `large-v3-turbo` q8/f16 on THIS Jetson was NOT measured by any source** — the ~6 GB desktop figure does NOT apply to the quantized ggml build. The memory math above is an estimate. **Load it on the box + measure before committing.**
3. **Piper-vs-Kokoro voice quality is subjective** — Kokoro ranks higher on one leaderboard; do a side-by-side A/B listen on the phone and pick the Piper voice you like (or keep ElevenLabs Emma as the "premium" option and Piper as the fast local default).

## How this fits the other two threads

- The **NIC fix** (your benchmark agent, option 1) likely matters MORE for the _current_ STT regression: 54% packet loss corrupts audio in transit → bad transcription. **Re-test STT on the clean link first** — if accuracy returns, the model was never the problem and this swap is an _optimization_, not a fix.
- Regardless of the NIC outcome, **Kokoro→Piper + medium-q5→turbo-q8 is the right direction** — it removes the memory ceiling that forced the quantized STT and gives accuracy headroom.

## Recommended on-box sequence (after the NIC is fixed)

1. Re-test current STT on the clean link (is it already fine?).
2. Stand up Piper on the Jetson; A/B the voice vs Kokoro; if acceptable, make it the local default (keep ElevenLabs Emma as premium).
3. With Kokoro stopped, build + load `large-v3-turbo` q8_0; **measure its RSS**; confirm the headroom math.
4. A/B `turbo-q8` vs `medium-q5` on real captured clips + your proper nouns ("Jetson Orin Nano", "dispatch"). Keep whichever wins; distil-large-v3 is the fallback if memory's tight with on-demand services up.

_Sources: whisper.cpp #3357 + ggml CMakeLists (sm_87 flag), NVIDIA Riva/NIM support matrices + Orin-Nano-Riva-fail report, Northflank 2026 STT benchmarks, rhasspy/piper-voices, Kokoro/Piper footprint comparisons. Full verified claim set + refutations in the workflow transcript._
