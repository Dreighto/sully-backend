// Companion dispatch orchestrator (spec §4.3, §5, §6). gate -> brakes ->
// createJob(decided) -> HMAC handoff POST to the dispatch listener -> dispatched.
// Reuses dispatch-listener.ts's HMAC contract (sha256 hex in X-W4-HMAC).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { serverConfig } from './config';
import * as jobs from './dispatchJobs';
import { RUNNING_STATES } from './dispatchJobs';
import {
	fingerprintFor,
	checkDailyCap,
	checkFingerprint,
	breakerOpen,
	dispatchBucket,
	isKilled
} from './dispatchBrakes';
import { killWorker } from './dispatch-listener';
import { ensureProject, commitWorkspace, deriveProject } from './workspace';
import type { WorkerName } from './worker-registry';

export interface DispatchInput {
	traceId: string;
	worker: WorkerName;
	category: string;
	brief: string;
	targetRepo: string;
	task: string;
	threadId: string;
	/**
	 * Role-based routing (LOS role-dispatch). When set AND pinWorker is not true,
	 * the kernel handoff sends `role` and OMITS `worker`, letting the dispatch
	 * listener rotate workers by role + trust (kernel precedence: explicit worker
	 * > role > default_role). Values: 'backend' | 'frontend'. When absent, or when
	 * pinWorker is true, we pin `worker` as before (explicit @worker override).
	 */
	role?: string;
	/** True = pin the concrete `worker` (explicit override). False/undefined with a
	 *  `role` set = let the kernel rotate by role. */
	pinWorker?: boolean;
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
	// Phase 5 / 5a: workspace builds get explicit project-folder + freshness +
	// commit-as-proof guidance, since you run in a WORKTREE of sully-workspace
	// (not the main checkout) and the project folder + any references were
	// committed to main before this dispatch.
	const workspaceGuidance =
		input.targetRepo === 'sully-workspace'
			? `

WORKSPACE BUILD (you are in a worktree of the sully-workspace repo):
  - FIRST sync to the latest main content (e.g. \`git fetch && git rebase origin/main\` or \`git reset --hard origin/main\`) so the project folder + any reference files committed before dispatch are present.
  - Build your artifact INSIDE the project folder \`${deriveProject(input.task)}/\` (it already exists). Reference files (if any) are in \`${deriveProject(input.task)}/refs/\`.
  - COMMIT your work — the commit is the proof Sully verifies. Put the commit SHA in the evidence envelope's git_ref below. Do NOT touch any folder other than your project folder.`
			: '';
	return `You are a background worker dispatched by Sully (the operator's companion app).
TASK: ${input.task}
TARGET REPO: ${input.targetRepo}
BRIEF: ${input.brief}${workspaceGuidance}

PROGRESS CALLBACK — POST each step to ${cbUrl} as JSON (no auth header needed; it's a local/tailnet callback):
  { "trace_id": "${input.traceId}", "action": "reading|edited|ran|thinking", "target": "<path or cmd>" }

CLOSING — POST a terminal row, then your result-marker telemetry AND an evidence envelope of POINTERS (include only what you actually did; omit the rest — a missing pointer just means Sully can't independently confirm that part):
  { "trace_id": "${input.traceId}", "action": "completed", "result_ref": "<final message or artifact ref>",
    "evidence": { "fs_paths": ["<files you created/edited>"], "artifacts": [{"path": "<ABSOLUTE path>", "label": "<name>", "importance": "primary|secondary|supporting"}], "git_ref": "<commit SHA>", "repo": "${input.targetRepo}", "pr_number": <PR number or null>, "health_url": "<service URL you can claim is up, or null>" },
    "marker": { "worker": "${input.worker}", "model": "<model>", "usage": { "prompt": 0, "completion": 0, "cache_read": 0, "cache_creation": 0, "total": 0 } } }
Declare high-value artifacts (e.g. built .ipa, .apk, .zip, or final report) in "artifacts" with absolute paths.
On failure POST action "failed" with target set to a one-line reason.`;
}

export async function dispatchToWorker(input: DispatchInput): Promise<DispatchResult> {
	if (isKilled()) return { ok: false, reason: 'kill switch engaged' };
	if (breakerOpen()) return { ok: false, reason: '429 circuit breaker open' };
	const cap = checkDailyCap();
	if (!cap.allowed)
		return { ok: false, reason: `daily dispatch cap reached (${cap.used}/${cap.cap})` };
	const fp = fingerprintFor(input.brief, input.category, input.targetRepo);
	if (!checkFingerprint(fp, input.threadId).allowed)
		return { ok: false, reason: 'duplicate dispatch fingerprint' };
	if (!dispatchBucket.take()) return { ok: false, reason: 'rate limited' };

	// ── Dispatch-rejection backstop (R2.2 §3): hard structural guard against
	//    mid-flight mutation. If the job row for this traceId already exists in a
	//    RUNNING state (dispatched/working/retry/decided), reject rather than
	//    mutating it. Complements the Mutation Gate — the gate prevents the turn
	//    from reaching this path; this backstop catches any residual code path
	//    that might slip through. ────────────────────────────────────────────────
	const existingJob = jobs.getJob(input.traceId);
	if (existingJob && RUNNING_STATES.has(existingJob.status)) {
		return { ok: false, reason: 'task already in flight — cannot mutate' };
	}

	// Promotes the turn's 'proposed' Task row to 'decided' (upsert on trace_id),
	// or inserts a fresh decided row for a legacy caller with no proposed row.
	// thread_id/source preserved via COALESCE when the proposed row already set
	// them; passed here so the legacy-insert path still links to the thread.
	jobs.createJob({
		traceId: input.traceId,
		worker: input.worker,
		category: input.category,
		brief: input.brief,
		fingerprint: fp,
		predictedTokens: 0,
		threadId: input.threadId,
		source: 'dispatch'
	});

	// Phase 5 / 5a: for a workspace build, create + COMMIT the project folder to
	// sully-workspace main BEFORE dispatch, so the worker's worktree (provisioned
	// from main) contains it. Deterministic file op (not the model). Best-effort:
	// a failure here shouldn't strand the dispatch — the worker can still create
	// the folder, just without the pre-commit. (Reference placement from chat
	// uploads is a follow-on — chat_uploads has no thread link yet.)
	if (input.targetRepo === 'sully-workspace') {
		try {
			const project = deriveProject(input.task);
			await ensureProject(project);
			await commitWorkspace(`5a: ensure project ${project} for ${input.traceId}`);
		} catch (e) {
			console.error('[companionDispatch] workspace prep failed (continuing)', e);
		}
	}

	const secret = serverConfig.dispatchListenerHmacSecret;
	if (!secret) {
		jobs.markFailed(input.traceId, 'listener HMAC secret not configured');
		return { ok: false, reason: 'listener HMAC secret not configured' };
	}
	const url = `${serverConfig.dispatchListenerUrl.replace(/\/+$/, '')}/dispatch`;
	// The listener reads the prompt from a FILE (prompt_path), not inline. Write
	// it to an absolute path under the companion data dir — the co-located
	// listener (loopback, same machine) reads it directly.
	let promptPath: string;
	try {
		const dir = path.join(path.dirname(serverConfig.memoryDbPath), 'dispatch-prompts');
		fs.mkdirSync(dir, { recursive: true });
		// The listener JSON.parses the prompt file and reads `.prompt` (dispatch
		// listener index.js ~L365) — it wants an envelope, not raw text. Write
		// `{ prompt: <worker prompt string> }` as a .prompt.json (kernel convention).
		promptPath = path.join(dir, `${input.traceId}.prompt.json`);
		fs.writeFileSync(promptPath, JSON.stringify({ prompt: buildWorkerPrompt(input) }), 'utf8');
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		jobs.markFailed(input.traceId, `prompt write failed: ${why}`);
		return { ok: false, reason: `prompt write failed: ${why}` };
	}
	// Role-dispatch (kernel precedence: explicit worker > role > default_role).
	// When a role is set AND we're NOT pinning a concrete worker, send `role` and
	// OMIT `worker` so the listener rotates by role + trust. Otherwise pin `worker`
	// exactly as before (explicit @worker override / legacy path). createJob above
	// still stores input.worker as the expected/fallback attribution — the real
	// worker overwrites it via its LOS-191 callback marker.
	const roleRoute = !!input.role && input.pinWorker !== true;
	const body = JSON.stringify(
		roleRoute
			? {
					trace_id: input.traceId,
					role: input.role,
					target_repo: input.targetRepo,
					prompt_path: promptPath
				}
			: {
					trace_id: input.traceId,
					worker: input.worker,
					target_repo: input.targetRepo,
					prompt_path: promptPath
				}
	);
	try {
		const resp = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-W4-HMAC': signBody(body, secret) },
			body,
			// Bound the handoff so a wedged listener can't hold the caller open — the
			// voice path now AWAITS this before closing the audio stream, so an
			// unbounded fetch would hang the operator's mic. Timeout → markFailed.
			signal: AbortSignal.timeout(5000)
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
