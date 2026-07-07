# AssemblyAI Universal-Streaming (v3): protocol facts + techniques to port into Jetson STT

Engineering brief for the Sully Voice Mode STT track. Two goals: (A) enough protocol
detail to code the bridge that routes Voice Mode audio through AssemblyAI Universal-Streaming,
and (B) the model-agnostic engineering patterns behind why streaming STT feels good, ranked
and specified for our own Jetson whisper-family service.

Sources are cited inline as `[n]` and listed at the bottom. Anything not directly verified
in a primary source is tagged **[UNVERIFIED]**.

Last researched: 2026-07-07. AssemblyAI ships models fast, so re-check the live docs (they
publish an MCP docs server and an `llms.txt` index) before hardening anything.

---

## Important model-naming caveat (read first)

The ticket names `u3-rt-pro` / "v3 Universal-Streaming". There are now **two** models behind
the same `wss://streaming.assemblyai.com/v3/ws` endpoint, and they differ in turn detection:

- **Universal-Streaming** (the June 2025 launch model, `speech_model=u3-rt-pro`). Uses
  **confidence-based** end-of-turn detection with silence fallback. This is the model whose
  "immutable transcripts in ~300 ms" and "intelligent endpointing" the ticket is chasing [3][6].
- **Universal-3.5 Pro Streaming** (`speech_model=universal-3-5-pro`). Newer. Same v3 WebSocket,
  but uses **punctuation-based** turn detection, adds a `mode` param and a `SpeechStarted`
  message, and has different parameter names/defaults [1][2][7].

Both are documented below. For a voice agent, either works; pick one and pin it. The
confidence-based endpointing story (Universal-Streaming) is the more novel one to learn from.

---

# (A) Implementing the AssemblyAI v3 client

Everything here is enough to write a raw-WebSocket bridge without the SDK.

## A.1 Connection

- **Endpoint:** `wss://streaming.assemblyai.com/v3/ws` [1][2][3]. Regional endpoints exist
  (EU data zone); see AssemblyAI "endpoints and data zones" if residency matters [1].
- **Auth, two ways:**
  - **Server-side (our case):** put the raw API key in the WebSocket `Authorization` header,
    **no `Bearer` prefix** [1]. Example header: `{"Authorization": "<API_KEY>"}`.
  - **Query-param token:** some AssemblyAI blog samples pass the key as a `?token=<KEY>`
    query param instead [3]. For browser clients you must **not** ship the real key; mint a
    short-lived temporary token server-side and pass that [1]. Since our bridge is server-side
    (Jetson/backend), use the `Authorization` header form.
- **Config is passed as URL query params** on the connect URL (not a JSON "start" message).
  Build the query string and append it to the endpoint [1][3].

Minimal connect (Universal-Streaming, server-side):

```python
from urllib.parse import urlencode

PARAMS = {
    "speech_model": "u3-rt-pro",   # or "universal-3-5-pro"
    "sample_rate": 16000,
    "encoding": "pcm_s16le",       # 16-bit signed little-endian PCM
    "format_turns": "true",        # emit a formatted final after the raw final
}
URL = f"wss://streaming.assemblyai.com/v3/ws?{urlencode(PARAMS)}"
# header: {"Authorization": "<API_KEY>"}  (no Bearer prefix)
```

Notes:

- **Unrecognized query params are silently ignored, not rejected** [1]. The `Begin` message
  echoes back `configuration` (the config the server actually applied). **Always assert
  `configuration.model` matches what you requested** to catch a typo like `speechModel` [1].
- Auto-close: an idle/unterminated session **auto-closes after 3 hours** and you are billed
  for the full open duration (billing is on wall-clock session time, not audio sent) [1].
  Always send `Terminate` when done.

## A.2 Audio frame format

- **PCM path (use this):** mono, 16-bit signed PCM at `sample_rate` (16 kHz in our pipeline).
  Send as **binary WebSocket frames**. Do **not** base64-encode and do **not** wrap in JSON;
  a text frame that isn't valid JSON closes the session [1].
- **Chunk size / cadence:** ~50 ms per frame = **800 samples = 1600 bytes** at 16 kHz mono
  PCM16 [1][2]. This is the recommended cadence; the SDK uses `blocksize=800`.
- **Throughput cap:** you may send faster than real time (e.g. from a file), but the server
  throttles at **~1.25x real time**. If more than ~5 minutes of audio buffers ahead of
  processing, the session closes with **error 3007** ("Audio transmission rate exceeded") [1].
- **Opus is also accepted:** `encoding=ogg_opus` (Ogg-framed; arbitrary chunk boundaries OK)
  or `encoding=opus` (raw packets, exactly one packet per binary frame). For Opus, `sample_rate`
  is ignored because the stream is self-describing. ~8x less bandwidth than PCM [1]. For a
  LAN Jetson bridge PCM is simpler; Opus only matters over WAN.

## A.3 Client -> server messages

All are **text (JSON)** frames except audio (binary) [1]:

| Message                               | Frame  | Purpose                                                                                                                                                    |
| ------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| audio                                 | binary | raw PCM/Opus bytes, ~50 ms chunks                                                                                                                          |
| `{"type":"UpdateConfiguration", ...}` | JSON   | change turn-detection settings mid-session; applies to audio after the update; no ack; does not retroactively affect the in-flight turn                    |
| `{"type":"ForceEndpoint"}`            | JSON   | immediately end the current turn (e.g. push-to-talk or your own VAD decided the user is done). Server returns the `end_of_turn:true` message(s) right away |
| `{"type":"KeepAlive"}`                | JSON   | reset inactivity timer; only needed if you set `inactivity_timeout`                                                                                        |
| `{"type":"Terminate"}`                | JSON   | end the session                                                                                                                                            |

## A.4 Server -> client messages

| Message           | When                                 | Notes                                                                                                                                                   |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Begin`           | once, on connect                     | `{ "type":"Begin", "id", "expires_at", "configuration":{model,mode,api_version} }`. `expires_at` is Unix seconds; hitting it closes with error 3008 [1] |
| `SpeechStarted`   | per turn, **Universal-3.5 Pro only** | precedes the first `Turn`; carries `timestamp` (ms from stream start) and `confidence`. **Universal-Streaming skips this** [1]                          |
| `Turn`            | repeatedly                           | partial and final transcripts (detail below)                                                                                                            |
| `SpeakerRevision` | if `speaker_labels=true`             | revised speaker labels for earlier turns                                                                                                                |
| `Termination`     | once, last                           | `{ "audio_duration_seconds", "session_duration_seconds" }`; session billed on `session_duration_seconds`                                                |
| `Error`           | on failure                           | `{ "error_code", "error" }` then socket closes                                                                                                          |

### The `Turn` object (the one you handle)

```json
{
	"type": "Turn",
	"turn_order": 0,
	"end_of_turn": false,
	"turn_is_formatted": false,
	"transcript": "My name is",
	"end_of_turn_confidence": 0.0,
	"words": [
		{ "start": 1216, "end": 1627, "text": "My", "confidence": 0.95, "word_is_final": false }
	],
	"utterance": ""
}
```

Field semantics that matter for the bridge [1]:

- **`transcript` supersedes, never appends.** Each `Turn` for a given `turn_order` replaces the
  previous one. Render/replace the latest `transcript`; do not concatenate partials.
- **`turn_order`** is monotonically increasing; all messages for a turn arrive before the next
  turn's first message.
- **Partial:** `end_of_turn:false`. **Final:** `end_of_turn:true`.
- **Immutable transcripts:** words emitted as final (`word_is_final:true`) are **never revised**.
  This is the core AssemblyAI design choice: what lands on the socket is final from the outset,
  so downstream logic (the LLM) can start reasoning while the user is still talking [3][6].
  Contrast with the usual "mutable partials that get retroactively edited" model.
- **Formatting / the double-final trap (Universal-Streaming):** with `format_turns=true` you get
  **two** `end_of_turn:true` messages for the same `turn_order` — first the unformatted final
  (`turn_is_formatted:false`, lowercase, no punctuation), then a formatted final
  (`turn_is_formatted:true`, cased + punctuated) right after. **Treat a turn as complete only when
  BOTH `end_of_turn` and `turn_is_formatted` are true**, or you will process every turn twice [1].
  With `format_turns=false` you get a single unformatted final.
- Word timings (`start`/`end`) are in **milliseconds** from stream start.

## A.5 Shutdown sequence (do not truncate the last transcript)

After sending `{"type":"Terminate"}`, **keep reading the socket until you get `Termination`** [1].
The server flushes in-flight messages first: the final/formatted `Turn` for audio already sent,
a closing empty-transcript `Turn` for an unfinished turn (Universal-Streaming), and a
`SpeakerRevision` if enabled (adds ~400 ms at close). Closing the socket the instant you send
`Terminate` silently drops the user's last utterance. Server then closes with code `1000`.

## A.6 Reference bridge skeleton (raw WebSocket, server-side)

```python
import json, os, websocket
from urllib.parse import urlencode

API_KEY = os.environ["ASSEMBLYAI_API_KEY"]
PARAMS  = {"speech_model": "u3-rt-pro", "sample_rate": 16000,
           "encoding": "pcm_s16le", "format_turns": "true"}
URL = f"wss://streaming.assemblyai.com/v3/ws?{urlencode(PARAMS)}"

def on_message(ws, raw):
    m = json.loads(raw)
    t = m.get("type")
    if t == "Begin":
        assert m["configuration"]["model"] == "u3-rt-pro"  # catch silent typos
    elif t == "Turn":
        if m["end_of_turn"] and m["turn_is_formatted"]:
            emit_final(m["transcript"])      # -> LLM
        elif not m["end_of_turn"]:
            emit_partial(m["transcript"])    # -> UI / barge-in logic
    elif t == "Termination":
        pass  # session totals; nothing follows

ws = websocket.WebSocketApp(URL, header={"Authorization": API_KEY},
                            on_message=on_message)
# feed audio: ws.send(pcm_1600_bytes, websocket.ABNF.OPCODE_BINARY) every ~50 ms
# shutdown:   ws.send(json.dumps({"type":"Terminate"})); read until Termination
```

## A.7 Endpointing / turn detection — the crux

This is why streaming STT feels good versus a naive whisper loop. AssemblyAI does not bolt a
legacy VAD onto the model; it **integrates end-of-turn detection into the STT** and combines
acoustic + semantic signals with a silence fallback [3][6].

**Universal-Streaming — confidence-based** [7]:
The model predicts when speech _semantically_ ends. A turn ends when
`end_of_turn_confidence > end_of_turn_confidence_threshold` **and** `min_turn_silence` has
passed. Acoustic (silence-only) detection is the fallback after `max_turn_silence`.

| Param                              | Default   | Meaning                                                                                       |
| ---------------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `end_of_turn_confidence_threshold` | `0.4`     | semantic confidence needed to end a turn. Higher = waits to be more sure; lower = ends faster |
| `min_turn_silence`                 | `400 ms`  | silence required before a semantic end-of-turn can fire                                       |
| `max_turn_silence`                 | `1280 ms` | max silence before forcing a turn end via acoustic fallback                                   |
| `vad_threshold`                    | (unset)   | 0-1 frame speech-classification threshold; raise in noise                                     |

Quick-start profiles from the docs [7]:

- Aggressive (IVR/confirmations): thr `0.4`, min `160`, max `400`
- Balanced (support agents): thr `0.4`, min `400`, max `1280`
- Conservative (healthcare/legal, lets people think): thr `0.7`, min `800`, max `3600`
- To hand endpointing to your own VAD: set thr `1` (acoustic-only) or use `ForceEndpoint`.
  Setting thr `0` is discouraged — it fires a turn at every `min_turn_silence` pause and
  fragments mid-sentence thinking pauses [7].

**Universal-3.5 Pro — punctuation-based** [2][7]:
Turns end when terminal punctuation (`.` `?` `!`) is detected, or at `max_turn_silence` if none.
Adds a `mode` param (`min_latency` | `balanced` | `max_accuracy`) that ships its own defaults:

| Param                 | min_latency | balanced | max_accuracy | Meaning                                             |
| --------------------- | ----------- | -------- | ------------ | --------------------------------------------------- |
| `min_turn_silence`    | 96          | 224      | 800          | silence (ms) before a speculative end-of-turn check |
| `max_turn_silence`    | 416         | 1536     | 1536         | max silence (ms) before forcing a turn end          |
| `interruption_delay`  | 0           | 500      | 500          | time to first partial (ms); server adds ~300 ms min |
| `continuous_partials` | true        | true     | true         | emit a partial every ~3 s during long speech        |
| `vad_threshold`       | 0.3         | 0.2      | 0.2          | frame speech-classification threshold               |

Both models expose these via connect params or mid-session `UpdateConfiguration`. Useful
recipe: raise `min_turn_silence` right before prompting for a long utterance (credit card,
address) so brief pauses don't split the number, then restore it [7].

## A.8 Anti-hallucination on AssemblyAI's side (what we're trying to reproduce)

AssemblyAI's robustness claims and the mechanisms behind them [3][6]:

- **73% fewer false outputs from noise** vs Deepgram Nova-2 (28% better than Nova-3). "False
  outputs from noise" = the exact failure our Jetson `/stt` shows (hallucinating on silence).
- Mechanism 1 — **VAD/speech-frame gating with a tunable `vad_threshold`**: frames below the
  threshold are classified as non-speech and don't drive transcription; raise it in noise [7].
- Mechanism 2 — **integrated endpointing** means the model has an explicit notion of "no turn
  in progress," so silence produces _no turn_, not an invented one.
- Mechanism 3 — **immutable/confident emission**: subwords are emitted only when confident, and
  low-confidence content isn't retroactively surfaced [3].
- Mechanism 4 — **purpose-built training on real-world noisy/call-center audio** (205+ hours
  across noise/SNR/speech-to-silence ratios) rather than clean read speech [3][6]. This part is
  **not portable** to us without our own data; the gating/endpointing parts are.

---

# (B) Techniques to port into Jetson STT

Our Jetson `/stt` (whisper / faster-whisper family) hallucinates on silence and lacks real
turn detection. Whisper specifically invents text on non-speech because its training data had
subtitle artifacts over silent video, and it will loop the last phrase to "fill" silence [7src].
None of AssemblyAI's _model_ advantage is portable, but the **engineering scaffolding around the
model is** — and that scaffolding is most of the felt difference. Ranked by impact/effort.

### 1. VAD pre-gating before inference (highest impact, do this first)

- **What:** run a lightweight voice-activity detector on each incoming frame and only feed
  buffered audio to whisper when speech is actually present. Use **Silero VAD** (ONNX, runs in
  ~1 ms/frame on CPU, trivial on Jetson) or WebRTC VAD for the cheapest option. AssemblyAI's
  own knob is `vad_threshold`; this is the same idea, done client-side [7].
- **Why it helps:** whisper literally never sees silence, so it cannot hallucinate on it. This
  is cited as the single most effective fix (>80% reduction in non-speech hallucination with
  <0.1% WER change) [W1][W5]. It also saves GPU: no decode on silence.
- **How:** Silero VAD, `threshold≈0.5`. Maintain a rolling speech/non-speech state; require
  ~2-3 consecutive speech frames to enter "speaking," and ~3 consecutive non-speech frames to
  exit. Only the audio between those boundaries goes to whisper.

### 2. Whisper decode-parameter hardening (near-zero effort, stacks with #1)

- **What:** set the decode params that make whisper fail closed on silence instead of inventing.
- **Why:** these break the hallucination feedback loop and drop low-confidence/looping output.
- **How** (faster-whisper naming) [W1][W5]:
  - `condition_on_previous_text=False` — stops a single hallucination from seeding the next
    window and spiraling into repeated phrases. Biggest single flag.
  - `beam_size=1` (greedy) — greedy fails fast on silence rather than searching for a plausible
    completion.
  - `no_speech_threshold≈0.6` (raise toward `0.9` if still leaking) — drop segments the model
    itself flags as non-speech.
  - `logprob_threshold≈-1.0` — discard low-confidence segments.
  - `compression_ratio_threshold≈2.4` — detect and drop repetitive/looped text (loops compress).
  - `temperature=0` (no fallback sampling) for streaming; sampling invites hallucination.

### 3. Energy/RMS floor gate (cheap belt-and-suspenders)

- **What:** compute short-window RMS/energy per chunk; if below a floor (calibrate against room
  noise, e.g. around -50 dBFS) treat as silence regardless of VAD [W3][W8].
- **Why:** catches the low-energy edge cases VAD misclassifies; effectively free.
- **How:** `rms = sqrt(mean(x^2))` on the int16 frame; skip inference below threshold.
  Calibrate the floor from the first ~1 s of each session (adaptive noise floor).

### 4. Turn-endpointing state machine (this is what makes it "feel" like AssemblyAI)

- **What:** a small explicit state machine — `IDLE -> SPEAKING -> ENDPOINTING -> FINAL` — driven
  by the VAD from #1 plus silence timers. Mirror AssemblyAI's `min_turn_silence` /
  `max_turn_silence` semantics locally [7].
- **Why:** gives us real turn boundaries instead of a fixed-window whisper loop. It's the
  difference between "responds when you're actually done" and "chops every N seconds."
- **How:**
  - Enter `SPEAKING` on sustained VAD speech; buffer audio.
  - On speech->silence transition, start a timer. If silence exceeds `min_turn_silence`
    (start ~400 ms) → emit final for the buffered utterance.
  - Cap with `max_turn_silence` (~1200 ms) as a hard fallback.
  - Expose a `ForceEndpoint`-equivalent for push-to-talk / barge-in.
  - **[UNVERIFIED for us]** the _semantic_ half of AssemblyAI's endpointing (ending on
    linguistic completeness, not just silence) needs a model we don't have; a lightweight
    proxy is "did the last emitted text end on terminal punctuation" — approximate, not equal.

### 5. Chunk buffering + partial-emission cadence (latency/UX polish)

- **What:** buffer ~200-500 ms before running VAD/decode to avoid clipping onsets; emit interim
  (partial) hypotheses on a cadence while `SPEAKING`, then a stable final at endpoint [W4][W6].
- **Why:** matches the partials-then-immutable-final UX. Partials feed barge-in and give the UI
  something live; the final is the one the LLM consumes.
- **How:** decode a sliding window for partials; on endpoint, decode the whole buffered
  utterance once for the clean final. Note our whisper partials are _mutable_ (may change) —
  unlike AssemblyAI's immutable ones — so mark partials as provisional in the UI and only act
  on the final. This is a real architectural gap vs AssemblyAI, not a config we can flip.

### 6. Hallucination blocklist + repeat-loop breaker (last-line cleanup)

- **What:** post-filter finals against a known-hallucination phrase list (e.g. "thank you",
  "subtitles by...", "please subscribe") and detect degenerate repetition [W5][W2].
- **Why:** catches the residue that slips past #1-#3. Cheap, deterministic.
- **How:** case-insensitive exact/prefix match against a maintained `.txt` blocklist; if the
  decoder emits the same token span N+ times in a row, drop/force-advance. Keep the list short
  and reviewed so we don't suppress real short utterances.

## Suggested implementation order for the Jetson service

1. Silero VAD pre-gate (#1) + decode-param hardening (#2) — kills the silence hallucination now.
2. Energy floor (#3) — cheap safety net.
3. Turn-endpointing state machine (#4) — makes iteration feel like a real voice agent.
4. Partial cadence + buffering (#5) and blocklist (#6) — polish.

Steps 1-2 alone should stop the hallucination-on-silence bug and remove the hardware crutch;
3-6 close the UX gap with AssemblyAI's felt responsiveness.

---

## Sources

AssemblyAI primary (scraped 2026-07-07):

- [1] Streaming message sequence / WebSocket protocol reference — https://www.assemblyai.com/docs/streaming/message-sequence
- [2] Streaming quickstart (endpoint, auth header, PCM16/800-sample chunks, Turn object) — https://www.assemblyai.com/docs/streaming/getting-started/transcribe-streaming-audio
- [3] Blog: Introducing Universal-Streaming (immutable transcripts ~300 ms, integrated endpointing, noise robustness) — https://www.assemblyai.com/blog/introducing-universal-streaming
- [6] Blog: raw-WebSocket voice agent with Universal-3 Pro Streaming (u3-rt-pro, token param, format/endpoint knobs) — https://www.assemblyai.com/blog/raw-websocket-voice-agent-with-assemblyai-universal-3-pro-streaming
- [7] Streaming turn-detection / optimizing accuracy and latency (endpointing params + defaults for both models) — https://www.assemblyai.com/docs/streaming/getting-started/optimizing-accuracy-and-latency

Whisper / ASR engineering (via Perplexity, 2026-07-07):

- [W1] arXiv 2505.12969 (VAD gating + decode thresholds reduce Whisper silence hallucination)
- [W2] arXiv 2501.11378 (hallucination_silence_threshold, BoH removal)
- [W4] dev.to: "Whisper hallucination on silence — why your transcript loops the same phrase"
- [W5] Reddit r/LocalLLaMA: 135 collected Whisper hallucination phrases + blocklist/loop-breaker technique
- [W3][W8] OpenAI community threads on energy gating and avoiding hallucinations
- [7src] Healthcare Brew / Whisper training-data (subtitle-over-silence) cause of silence hallucination

Note: `[4][5]` in raw Perplexity output were third-party (Pipecat, FlutterFlow, Bubble) and are
not relied on for protocol facts above; AssemblyAI primary docs [1][2] are authoritative.
