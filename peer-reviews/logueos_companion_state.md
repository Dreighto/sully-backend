# LogueOS Companion — State & Capabilities Audit

## 1. What It Is

LogueOS Companion is a standalone, local-model AI companion application. It was originally extracted and forked from the primary LogueOS Console chat surface. It is engineered to function as an installable Progressive Web App (PWA) over HTTPS, heavily optimized for a mobile/iOS experience.

It is designed with a "Copy-Boot-Strip + one mode flag" architecture. It operates primarily on SvelteKit 5 (runes) and an adapter-node backend.

## 2. What It Does

The Companion provides a full-featured AI interface (supporting text, voice, image-gen, code canvas, and threads) while being completely decoupled from the main LogueOS Orchestrator kernel.

It uses a server-side environment flag (`LOGUEOS_APP_MODE`) to toggle between two states:

- **`wired`**: Acts as a clone, sharing the kernel database and gateway.
- **`companion`**: Runs entirely independent with its own private `companion.db` and local Ollama instance, with the LogueOS kernel completely OFF.

To prevent crashes on a fresh database, it uses a self-initializing bootstrap routine that provisions necessary schema without relying on the Orchestrator:

```typescript
// Example conceptual bootstrap execution in hooks.server.ts
if (LOGUEOS_APP_MODE === 'companion') {
	await runCompanionBootstrap(); // Creates chat_messages and chat_user_state
}
```

## 3. What It Is Capable Of

Currently, the LogueOS Companion is capable of:

- **True Offline / Local Inference**: By default, it connects to a local Ollama instance running `companion-v1:latest` (or any cloud model if an API key is provided).
- **Advanced Voice Mode**: Features a real-time voice pipeline. It captures microphone input via WebSocket, processes it through a local RealtimeSTT server (faster-whisper), pipes to Ollama, and outputs via local streaming TTS (Piper/Kokoro) or ElevenLabs.
- **In-Thread Live Transcripts**: Mirrors modern interactions where interim speech transcripts render live in the composer and assistant replies stream as text, with options for barge-in (interrupt by speaking) and Push-to-Talk.
- **Fail-Safe Decoupling**: 7 kernel chokepoints (like worker dispatch, activity feeds, and approval pipelines) are strictly guarded and safely bypassed when running in `companion` mode.

```typescript
// Example decoupling guard
if (!dispatchEnabled) {
	return { error: 'Worker dispatch is a kernel feature. Companion mode active.' };
}
```

- **Mobile First PWA**: Served over a Tailscale Funnel with a dedicated web manifest, enabling it to be installed as a separate native-like app on iOS.

## 4. What It Is Going To Be

The roadmap positions the Companion to become a fully self-sufficient, highly personalized, and intelligent local assistant. Upcoming integrations include:

- **Persistent Cross-Conversation Memory**: Implementing explicit and inferred memory stores alongside user profiles and account-wide custom instructions.
- **Collapsible Reasoning (Chain-of-Thought) Panels**: Parsing `<think>` tags from local reasoning models (like deepseek or qwen) and rendering them in a collapsible UI with elapsed timers.
- **Local Web Search & Citations**: Self-hosted live search via SearXNG with RAG capabilities over user uploads, providing inline `[n]` citations without breaking the local privacy boundary.
- **Advanced Conversation branching**: Safely branching, editing, and regenerating response variants within the chat tree.
- **Cloud Fallback Flexibility**: Seamless utilization of Ollama Pro or other cloud endpoints for massive models when the local GPU constraints are exceeded.
