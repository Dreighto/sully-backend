// Turn replay — the reader API for the Task journal (Phase 1 of the task-first
// architecture).
//
// Purpose: give CC (and any future analysis) a single call that answers "what
// happened on turn X?" without the operator having to point at the chat logs.
// Every turn now mints a Task (pending_jobs row) + carries task_id on its
// chat_messages rows + emits journal events into chat_activity. This module
// stitches those three surfaces back into one structured TurnReplay object.
//
// It is READ-ONLY and best-effort: a turn that predates the Phase 1 migration
// (no task_id) returns null. Nothing here throws into a caller.

import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';

export interface TurnReplayMessage {
	id: number;
	sender: string;
	text: string;
	timestamp: string;
	model: string | null;
	provider: string | null;
	prompt_tokens: number | null;
	completion_tokens: number | null;
	latency_ms: number | null;
	error: string | null;
	quality_signal: number | null;
}

export interface TurnReplayEvent {
	action: string;
	target: string | null; // JSON or plain string
	timestamp: string;
}

export interface TurnReplayTask {
	task_id: string;
	thread_id: string | null;
	source: string | null;
	worker: string | null;
	status: string;
	current_activity: string | null;
	category: string | null;
	classification_tier: string | null;
	classification_payload: string | null;
	brief: string | null;
	result_ref: string | null;
	verification_state: string | null;
	verification_ref: string | null;
	synthesis_message_id: number | null;
	started_at: string | null;
	ended_at: string | null;
	predicted_tokens: number | null;
	actual_total: number | null;
}

export interface TurnReplay {
	task_id: string;
	thread_id: string | null;
	/** The Task row (pending_jobs) — the canonical state machine for the turn. */
	task: TurnReplayTask | null;
	/** Every chat_messages row carrying this task_id, oldest first. */
	messages: TurnReplayMessage[];
	/** Every journal event (chat_activity) for this task, oldest first. */
	events: TurnReplayEvent[];
	/** Whether a worker was actually dispatched (status passed the pre-dispatch stages). */
	dispatched: boolean;
}

function db(): Database.Database {
	return new Database(serverConfig.memoryDbPath, { readonly: true });
}

function rowToTask(r: Record<string, unknown> | undefined): TurnReplayTask | null {
	if (!r) return null;
	return {
		task_id: String(r.trace_id),
		thread_id: (r.thread_id as string) ?? null,
		source: (r.source as string) ?? null,
		worker: (r.worker as string) ?? null,
		status: String(r.status),
		current_activity: (r.current_activity as string) ?? null,
		category: (r.category as string) ?? null,
		classification_tier: (r.classification_tier as string) ?? null,
		classification_payload: (r.classification_payload as string) ?? null,
		brief: (r.brief as string) ?? null,
		result_ref: (r.result_ref as string) ?? null,
		verification_state: (r.verification_state as string) ?? null,
		verification_ref: (r.verification_ref as string) ?? null,
		synthesis_message_id: (r.synthesis_message_id as number) ?? null,
		started_at: (r.started_at as string) ?? null,
		ended_at: (r.ended_at as string) ?? null,
		predicted_tokens: (r.predicted_tokens as number) ?? null,
		actual_total: (r.actual_total as number) ?? null
	};
}

const PRE_DISPATCH = new Set(['proposed', 'classified', 'gated', 'held']);

/**
 * Full journal for a single Task. Returns null if no row anywhere carries the
 * task_id (e.g. a pre-migration turn).
 */
export function replayTurn(taskId: string): TurnReplay | null {
	if (!taskId || !fs.existsSync(serverConfig.memoryDbPath)) return null;
	const conn = db();
	try {
		const task = rowToTask(
			conn.prepare('SELECT * FROM pending_jobs WHERE trace_id = ?').get(taskId) as
				| Record<string, unknown>
				| undefined
		);

		const messages = (
			conn
				.prepare(
					`SELECT id, sender, message, timestamp, model, provider,
					        prompt_tokens, completion_tokens, latency_ms, error, quality_signal
					 FROM chat_messages WHERE task_id = ? ORDER BY id ASC`
				)
				.all(taskId) as Record<string, unknown>[]
		).map((r) => ({
			id: Number(r.id),
			sender: String(r.sender),
			text: String(r.message),
			timestamp: String(r.timestamp),
			model: (r.model as string) ?? null,
			provider: (r.provider as string) ?? null,
			prompt_tokens: (r.prompt_tokens as number) ?? null,
			completion_tokens: (r.completion_tokens as number) ?? null,
			latency_ms: (r.latency_ms as number) ?? null,
			error: (r.error as string) ?? null,
			quality_signal:
				r.quality_signal === null || r.quality_signal === undefined
					? null
					: Number(r.quality_signal)
		}));

		const events = (
			conn
				.prepare(
					'SELECT action, target, timestamp FROM chat_activity WHERE trace_id = ? ORDER BY id ASC'
				)
				.all(taskId) as Record<string, unknown>[]
		).map((r) => ({
			action: String(r.action),
			target: (r.target as string) ?? null,
			timestamp: String(r.timestamp)
		}));

		if (!task && messages.length === 0 && events.length === 0) return null;

		// Aged-out pre-flight rows land at 'aborted' without ever dispatching —
		// exclude them or the terminal status would falsely read as post-dispatch.
		const agedOut =
			task?.status === 'aborted' &&
			typeof task.current_activity === 'string' &&
			task.current_activity.startsWith('aged out');
		const dispatched = task
			? !PRE_DISPATCH.has(task.status) && task.worker !== 'sully' && !agedOut
			: false;

		return {
			task_id: taskId,
			thread_id: task?.thread_id ?? null,
			task,
			messages,
			events,
			dispatched
		};
	} catch (e) {
		console.error('replayTurn error:', e);
		return null;
	} finally {
		conn.close();
	}
}

/**
 * Find the Task a given chat_messages row belongs to, then replay it. Handy
 * when you have a message id (e.g. from the UI) but not the task_id.
 */
export function replayTurnByMessage(messageId: number): TurnReplay | null {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return null;
	const conn = db();
	let taskId: string | null = null;
	try {
		const row = conn.prepare('SELECT task_id FROM chat_messages WHERE id = ?').get(messageId) as
			| { task_id?: string }
			| undefined;
		taskId = row?.task_id ?? null;
	} catch (e) {
		console.error('replayTurnByMessage lookup error:', e);
	} finally {
		conn.close();
	}
	return taskId ? replayTurn(taskId) : null;
}

/**
 * The N most recent Tasks for a thread, newest first, each fully replayed.
 * The "what's been happening in this thread?" surface for CC.
 */
export function replayThreadRecent(threadId: string, n = 10): TurnReplay[] {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return [];
	const conn = db();
	let taskIds: string[] = [];
	try {
		taskIds = (
			conn
				.prepare(
					`SELECT trace_id FROM pending_jobs WHERE thread_id = ? ORDER BY started_at DESC LIMIT ?`
				)
				.all(threadId, n) as { trace_id: string }[]
		).map((r) => r.trace_id);
	} catch (e) {
		console.error('replayThreadRecent error:', e);
	} finally {
		conn.close();
	}
	return taskIds.map((id) => replayTurn(id)).filter((t): t is TurnReplay => t !== null);
}
