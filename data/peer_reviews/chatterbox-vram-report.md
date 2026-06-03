# Chatterbox VRAM Report

**Generated:** 2026-06-03  
**GPU:** NVIDIA GeForce RTX 5060 Ti — 16,311 MiB (15.93 GB)  
**Tested by:** CC (VP Ops)

---

## Results

| State                                   | VRAM Used      | VRAM Free      |
| --------------------------------------- | -------------- | -------------- |
| **Baseline** (TTS stopped, STT running) | 544 MiB        | 15,307 MiB     |
| **Chatterbox warm** (TTS active)        | 3,799 MiB      | 12,052 MiB     |
| **Delta (Chatterbox cost)**             | **+3,255 MiB** | **−3,255 MiB** |

**Chatterbox uses 3,255 MiB (3.18 GB) of VRAM** once fully loaded and warm.

---

## Measurement Method

Services were already warm from the prior session (cold-start test). Took a snapshot via `nvidia-smi` with Chatterbox active, then stopped `logueos-companion-tts` and waited 3 seconds for the GPU memory to release before taking the baseline reading.

```
WARM:
  Total used:       3,799 MiB
  TTS process:      3,250 MiB  (pid 2644264 — Chatterbox)
  STT process:        534 MiB  (pid 2644263 — faster-whisper)
  System overhead:     15 MiB

BASELINE (TTS stopped):
  Total used:         544 MiB
  STT process:        534 MiB
  System overhead:     10 MiB

DELTA = 3,799 − 544 = 3,255 MiB
```

---

## Full VRAM Budget Picture

To make the long-term decision, here's how Chatterbox fits against everything else on the box:

| Component                                       | VRAM             | Notes                                                          |
| ----------------------------------------------- | ---------------- | -------------------------------------------------------------- |
| STT service (faster-whisper small.en + tiny.en) | 534 MiB          | Always on during voice mode                                    |
| Chatterbox TTS                                  | **3,255 MiB**    | On-demand fallback only                                        |
| companion-v1-voice (Qwen2 14.8B Q4_K_M)         | ~8,500–9,000 MiB | 9.0 GB model file; loads on first voice turn, stays for 10 min |
| **GPU total**                                   | **16,311 MiB**   |                                                                |

### Worst-case scenario during a voice session (all three loaded simultaneously)

|                    | MiB               |
| ------------------ | ----------------- |
| STT                | 534               |
| Chatterbox         | 3,255             |
| companion-v1-voice | ~8,750 (estimate) |
| System             | ~15               |
| **Total**          | **~12,554 MiB**   |
| **Remaining**      | **~3,757 MiB**    |

That leaves ~3.7 GB headroom. Tight for any other GPU work (Ollama won't evict companion-v1-voice until the 10-minute keep-alive expires, per `VOICE_KEEP_ALIVE = '10m'` in `voice_runtime.ts`).

### With Chatterbox removed from the equation

|                    | MiB            |
| ------------------ | -------------- |
| STT                | 534            |
| companion-v1-voice | ~8,750         |
| System             | ~15            |
| **Total**          | **~9,299 MiB** |
| **Remaining**      | **~7,012 MiB** |

Removing Chatterbox from the startup cycle frees ~3.2 GB and brings headroom from 3.7 GB to ~7 GB — enough to comfortably run a second Ollama model alongside a voice session.

---

## What This Means for the Decision

Chatterbox costs **3.18 GB** to hold in VRAM as a standby fallback for ElevenLabs. Since `VOICE_TTS_PROVIDER=elevenlabs` and ElevenLabs is averaging ~315ms per sentence (from the prior diagnostic), Chatterbox only activates if the daily character cap is hit.

That's a 3.18 GB reservation for an edge case. The two realistic paths:

**Option A — Skip Chatterbox startup when ElevenLabs is primary** (the Fix 1 from the previous diagnostic): saves the 21-second cold-start AND reclaims 3.18 GB from VRAM. If the cap is ever hit mid-session, the fallback cold-starts on-demand in ~21s — which is disruptive but rare.

**Option B — Keep Chatterbox always warm**: smooth fallback experience, but costs 3.18 GB permanently during voice sessions and tightens the headroom to ~3.7 GB while companion-v1-voice is resident.

Given the 16 GB budget and that Chatterbox is a rarely-triggered fallback, **Option A is the better trade**. The cap exhaustion path is the edge case; 3.18 GB of VRAM is not.
