# AssemblyAI STT Bridge — Voice Mode

Routes Sully Voice Mode STT through AssemblyAI Universal-3 Pro (u3-rt-pro)
instead of the Jetson bridge, speaking the identical `/companion-voice` WS
protocol so the iOS app needs zero changes.

## Live wiring (2026-07-07)
- Service: `logueos-assemblyai-stt.service` → `server.js` on `127.0.0.1:18771`
- Proxy: `tailscale serve :8444 /companion-voice → :18771` (the app's prod host)
- Model: `ASSEMBLYAI_STT_MODEL` (default `u3-rt-pro`)
- Spend log: `data/assemblyai_stt_sessions.jsonl` (audio_seconds per session)

## Flip back to Jetson (instant, no app change)
```
sudo tailscale serve --bg --https=8444 --set-path /companion-voice http://127.0.0.1:18770
```
Flip to AssemblyAI:
```
sudo tailscale serve --bg --https=8444 --set-path /companion-voice http://127.0.0.1:18771
```

## Verified
End-to-end through `wss://room.taila28611.ts.net:8444/companion-voice`: streamed
16kHz PCM16 speech → exact transcript with punctuation, ready in ~180ms, one
clean final (double-final trap handled).
