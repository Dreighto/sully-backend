# STT accuracy A/B harness

Turns "did the voice recognition get better?" into a **number** (WER %), so the
NIC-fix re-test — and any later model swap — is measured, not guessed.

It feeds clips with **known** transcripts to a live STT endpoint (the same
`POST /stt` path the companion app uses on the Jetson) and reports Word Error
Rate, domain-keyword recall, and latency per config.

## Why this exists

Until the NIC link-flap was fixed (2026-06-05, dual net-manager conflict on the
Jetson — _not_ the cable/driver), we couldn't tell "the model is bad" from "the
network was corrupting the audio." With the link clean (0% loss), this harness
answers it: run it now on the live STT — if WER is good, the model was never the
problem and no swap is needed. If it's still high, the swap (e.g. medium-q5 →
large-v3-turbo) has a clean baseline to beat.

## The endpoint it hits

`POST http://10.10.10.2:18780/stt` — body = raw PCM16 (16 kHz mono Int16-LE),
response `{"text": "..."}`. This is exactly what `jetson_vad_stt_bridge.py` calls
for transcription, so a score reflects the real deployed path. Point `--config`
at any compatible endpoint to A/B a different model/port.

## 1. Record the clips (ground truth)

Read each line of `phrases.tsv` **exactly** as written, saving each as its named
`.wav` into a clips dir (e.g. `~/voice_capture`). The text in the manifest is the
ground truth — it must match what you actually said, so re-record any flub.

> ⚠️ Do **not** reuse an STT's own past output (e.g. the existing
> `voice_capture/transcripts.log`) as the reference — that scores the model
> against itself and always looks perfect. Ground truth = a script you read.

Quick record helper (ROOM/Jetson with `arecord`):

```bash
cd ~/voice_capture
arecord -f S16_LE -r 16000 -c 1 clip01.wav   # Ctrl-C when done; repeat per line
```

(or record on the phone and copy them over — the harness resamples anything.)

## 2. Run it

```bash
cd ~/dev/LogueOS-Companion/tools/stt_ab

# baseline: the current live STT
python3 stt_ab.py --manifest phrases.tsv --clips ~/voice_capture \
    --config "current=http://10.10.10.2:18780/stt"
```

A/B two models in one run (if you stand a second whisper service on another port):

```bash
python3 stt_ab.py --manifest phrases.tsv --clips ~/voice_capture \
    --config "medium-q5=http://10.10.10.2:18780/stt" \
    --config "turbo-q8=http://10.10.10.2:18791/stt"
```

Single-endpoint flow (swap the model in place): run once with `--config
"medium-q5=...:18780/stt"`, then swap the Jetson whisper model + restart the
service, run again with `--config "turbo-q8=...:18780/stt"`, and diff the two
reports.

## 3. Read the result

Prints a Markdown summary and writes `results/stt_ab_<timestamp>.{md,json}`:

- **Corpus WER** — total word errors ÷ total reference words (the honest headline number).
- **Mean / median WER** — per-clip distribution.
- **Domain-keyword recall** — of the clips whose reference contains "jetson",
  "dispatch", etc., how many the model actually transcribed (the proper-noun test).
- **Mean latency** — ms per clip (watch this if you move to a bigger model —
  turbo keeps the full large encoder, so latency may rise even though WER drops).
- **Per-clip** table — reference vs each config's hypothesis + its WER.

Pure stdlib (`wave` + `audioop` + `urllib`), no pip install. `audioop` was removed
in Python 3.13 — on 3.13+, pre-convert clips to 16 kHz mono (or run on 3.12/3.10).
