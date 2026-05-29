// Client-side chat UI types. Extracted from chat/+page.svelte and
// Composer.svelte as the first slice of the +page.svelte decomposition
// (cleanup ③). Attachment / ComposerMode / TalkbackPhase were duplicated in
// both files (drift risk); Tier / ProviderPref / ModelChoice lived only in the
// page.
//
// NOTE: this is the CLIENT view layer. It deliberately does NOT reuse
//   - `$lib/types/chat`'s `ChatMessage` (that's the server/DB message shape:
//     sender union, trace_id, status, thread_id). The page renders a narrower
//     view model and keeps its own local `ChatMessage` for now.
//   - `$lib/server/phase_classifier`'s `Tier` (a $lib/server module can't be
//     imported into client code). The literal union is mirrored here.
// Reconciling those two duplications is a separate, behavior-touching task.

export type Tier = 'chat' | 'planning' | 'deep' | 'local';

// Client view-model for a rendered chat row. This is the NARROW UI shape the
// page + voice controller share — deliberately NOT the server/DB `ChatMessage`
// from `$lib/types/chat` (sender union, trace_id, status, thread_id). `sender`
// is a free string here because the renderer only branches on a few known
// values ('operator' / 'system' / agent ids) and tolerates anything else.
export type ChatMessage = {
	id: number;
	sender: string;
	message: string;
	timestamp: string;
	image_path?: string | null;
};

export type Attachment = {
	id: string;
	filename: string;
	url: string;
	mime: string;
	size: number;
	uploading?: boolean;
	text?: string;
};

export type ComposerMode = 'idle' | 'focused' | 'recording' | 'talkback';
export type TalkbackPhase = 'capture' | 'transcribe' | 'dispatch' | 'speak' | 'loop';

// Realtime Voice Mode (the immersive full-screen pipeline: local STT WS with
// live partials -> streaming local reply -> per-sentence Chatterbox TTS ->
// gapless playback + barge-in). Distinct from the legacy in-composer Talkback
// loop (Web Speech API + cloud STT/TTS + polling) above.
//   connecting — spinning up the on-demand speech services + opening the WS
//   listening  — PTT held, mic streaming, partials updating live
//   thinking   — utterance finalized, waiting on the model's first tokens
//   speaking   — reply streaming + TTS playing (barge-in returns to listening)
//   idle       — session open, ready for the next push-to-talk
//   error      — unrecoverable session error (message in errorMsg)
export type VoicePhase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'idle' | 'error';

export type ProviderPref = 'anthropic' | 'gemini' | 'local' | null;

// Concrete model-picker entry — translates to a (tier, provider) pair the
// router pins. tier === null + provider === null means 'auto' (smart routing).
export type ModelChoice = {
	id: string;
	label: string;
	sublabel: string;
	tier: Tier | null;
	provider: ProviderPref;
	// Optional explicit model id sent as `body.model` (overrides the tier→model
	// default). Used to pin a specific local/cloud Ollama model — e.g. an Ollama
	// Cloud `*-cloud` tag that the local daemon proxies up to ollama.com.
	model?: string;
};
