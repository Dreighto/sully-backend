// escalation_telemetry.ts — append-only log of Specialist (Claude Agent SDK)
// turns. Companion's first JSONL telemetry sink.
//
// One row per `handled_by: "sdk"` turn. The row carries enough context that
// the next pass (model-selection learner / Hermes shadow / cost audit) can
// reason about WHY the heavy lane fired without needing chat_messages access.
//
// Pattern matches the orchestrator's existing jsonl writers (captureGate.ts:19
// + kill-switch.ts:62): direct fs.appendFileSync of JSON.stringify(row) + '\n'.
// No batching, no rotation — that's intentional. If the file ever grows past
// the operator's comfort window we add a rotation step then; until then,
// append-only is the contract per the kernel's standing JSONL discipline.

import fs from 'node:fs';
import path from 'node:path';

import { serverConfig } from './config';

const CORPUS_FILENAME = 'escalation_corpus.jsonl';

export type EscalationRow = {
	at: string; // ISO timestamp
	thread_id: string;
	task_id: string | null;
	user_prompt: string;
	system_prompt_head: string; // first 800 chars — full prompt would balloon the file
	provider: string;
	model: string;
	current_tier: string;
	target_repo: string;
	/** Discriminates text-chat escalations from voice-specialist escalations.
	 *  Default 'text' for back-compat with rows written before Rank 2 shipped. */
	source?: 'text' | 'voice';
	/** Voice-only correlation id (mirrors the voice-reply `response_id` pattern).
	 *  Set when `source === 'voice'`, omitted otherwise. */
	voice_session_id?: string;
	/** Free-form caller-supplied metadata. Voice clients use this to record
	 *  device/preset/turn context that isn't worth its own column. */
	metadata?: Record<string, unknown>;
	// Filled in by the stream handler once the reply lands:
	reply_text?: string;
	reasoning?: string | null; // model's <thinking>/reasoning block if surfaced
	tools_used?: string[]; // tool-call names that fired during the turn
	prompt_tokens?: number;
	completion_tokens?: number;
	latency_ms?: number;
	error?: string;
};

/** Resolve the JSONL path. Lives next to companion.db (per memory:
 *  reference_sully_backend_live_db_and_uploads_paths). */
function corpusPath(): string {
	// serverConfig.memoryDbPath is the live companion.db; the corpus sits in the
	// same data/ directory so backup/rsync scripts pick it up automatically.
	const dataDir = path.dirname(serverConfig.memoryDbPath);
	return path.join(dataDir, CORPUS_FILENAME);
}

/** Append one escalation row. Best-effort: a write failure is logged via
 *  console.error and never throws into the SSE path — telemetry must not
 *  break the reply. */
export function logEscalation(row: EscalationRow): void {
	try {
		fs.appendFileSync(corpusPath(), JSON.stringify(row) + '\n', 'utf-8');
	} catch (err) {
		console.error('[escalation] write failed:', err);
	}
}
