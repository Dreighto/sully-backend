// Companion dispatch orchestrator (spec §4.3, §5, §6). gate -> brakes ->
// createJob(decided) -> HMAC handoff POST to the dispatch listener -> dispatched.
// Reuses dispatch-listener.ts's HMAC contract (sha256 hex in X-W4-HMAC).
import crypto from 'node:crypto';
import { serverConfig } from './config';
import * as jobs from './dispatchJobs';
import {
	fingerprintFor,
	checkDailyCap,
	checkFingerprint,
	breakerOpen,
	dispatchBucket,
	isKilled
} from './dispatchBrakes';
import { killWorker } from './dispatch-listener';

export interface DispatchInput {
	traceId: string;
	worker: 'claude-code' | 'gemini';
	category: string;
	brief: string;
	targetRepo: string;
	task: string;
	threadId: string;
}
export interface DispatchResult {
	ok: boolean;
	reason?: string;
}

function signBody(rawBody: string, secret: string): string {
	return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// The worker prompt that carries the companion callback URL + the activity
// vocabulary + the result-marker contract. The worker posts activity rows and
// (on close) its result-marker telemetry to POST <base>/api/chat/activity.
function buildWorkerPrompt(input: DispatchInput): string {
	const cbUrl = `${serverConfig.companionCallbackBaseUrl.replace(/\/+$/, '')}/api/chat/activity`;
	return `You are a background worker dispatched by Sully (the operator's companion app).
TASK: ${input.task}
TARGET REPO: ${input.targetRepo}
BRIEF: ${input.brief}

PROGRESS CALLBACK — POST each step to ${cbUrl} as JSON:
  { "trace_id": "${input.traceId}", "action": "reading|edited|ran|thinking", "target": "<path or cmd>" }
sign the raw JSON body with HMAC-SHA256 (hex) in the X-Companion-HMAC header using
the shared secret in your COMPANION_CALLBACK_SECRET env var.

CLOSING — POST a terminal row, then your result-marker telemetry:
  { "trace_id": "${input.traceId}", "action": "completed", "result_ref": "<final message or artifact ref>",
    "marker": { "worker": "claude-code", "model": "<model>", "usage": { "prompt": 0, "completion": 0, "cache_read": 0, "cache_creation": 0, "total": 0 } } }
On failure POST action "failed" with target set to a one-line reason.`;
}

export async function dispatchToWorker(input: DispatchInput): Promise<DispatchResult> {
	if (isKilled()) return { ok: false, reason: 'kill switch engaged' };
	if (breakerOpen()) return { ok: false, reason: '429 circuit breaker open' };
	const cap = checkDailyCap();
	if (!cap.allowed)
		return { ok: false, reason: `daily dispatch cap reached (${cap.used}/${cap.cap})` };
	const fp = fingerprintFor(input.brief, input.category, input.targetRepo);
	if (!checkFingerprint(fp).allowed) return { ok: false, reason: 'duplicate dispatch fingerprint' };
	if (!dispatchBucket.take()) return { ok: false, reason: 'rate limited' };

	jobs.createJob({
		traceId: input.traceId,
		worker: input.worker,
		category: input.category,
		brief: input.brief,
		fingerprint: fp,
		predictedTokens: 0
	});

	const secret = serverConfig.dispatchListenerHmacSecret;
	if (!secret) {
		jobs.markFailed(input.traceId, 'listener HMAC secret not configured');
		return { ok: false, reason: 'listener HMAC secret not configured' };
	}
	const url = `${serverConfig.dispatchListenerUrl.replace(/\/+$/, '')}/dispatch`;
	const body = JSON.stringify({
		task: input.task,
		scope: input.brief,
		target_repo: input.targetRepo,
		brief: input.brief,
		trace_id: input.traceId,
		worker: input.worker,
		prompt: buildWorkerPrompt(input)
	});
	try {
		const resp = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-W4-HMAC': signBody(body, secret) },
			body
		});
		if (!resp.ok) {
			jobs.markFailed(input.traceId, `listener HTTP ${resp.status}`);
			return { ok: false, reason: `listener HTTP ${resp.status}` };
		}
		jobs.markDispatched(input.traceId);
		return { ok: true };
	} catch (e) {
		jobs.markFailed(input.traceId, e instanceof Error ? e.message : String(e));
		return { ok: false, reason: 'listener unreachable' };
	}
}

/** Two-level kill: gate is in dispatchBrakes.isKilled(); this aborts in-flight. */
export async function killAll(): Promise<void> {
	for (const job of jobs.listInFlight()) {
		try {
			await killWorker(job.trace_id);
		} catch {
			/* best effort — abort the row regardless */
		}
		try {
			jobs.markAborted(job.trace_id);
		} catch {
			/* already terminal */
		}
	}
}
