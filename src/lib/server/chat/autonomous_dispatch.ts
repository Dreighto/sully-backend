// Autonomous dispatch (spec §4.2) — shared by BOTH streaming paths in
// src/routes/api/chat/sdk-stream/+server.ts.
//
// After producing a reply, the route decides whether to hand the operator's
// request off to a coding worker (CC / AGY) in the background. The two paths
// reach this decision slightly differently:
//
//   CLI-bridge path (Sonnet/Opus): the teacher (Opus) appends a hidden
//     <<<SULLY_GATE {...}>>> self-assessment block to its reply. The route
//     extracts that block and passes it here as `gateBlock`. The escalate
//     decision then ALSO requires the gate to validate + say escalate:true,
//     AND the deterministic valueGate to qualify.
//
//   Direct/local path (Haiku/Gemini/Ollama): streamText output can't be
//     cleanly stripped of a gate block, so there is NO gate block. `gateBlock`
//     is omitted and the deterministic gates alone decide: ruleGate (@cc/@agy
//     override) + valueGate (file/code/repo/long-imperative signals).
//
// In BOTH cases ruleGate (@cc/@agy literal mention) forces a dispatch. The
// worker/brief/category derivation differs: with a valid gate block the route
// prefers the teacher's choices; without one it falls back to claude-code /
// userText-slice / 'code'. This helper unifies the dispatchToWorker call + the
// system "sent to worker" message write while preserving each path's exact
// escalate condition and worker/brief/category derivation.

import { addChatMessage } from '$lib/server/chat';
import { runMode } from '$lib/server/config';
import { validateGate } from '$lib/server/decisionGate';
import { decide } from '$lib/server/routing/decide';
import { dispatchToWorker } from '$lib/server/companionDispatch';
import { logTaskEvent } from '$lib/server/chatActivity';
import { mintTaskId } from '$lib/server/chat_turn';
import { markSelfHandled } from '$lib/server/dispatchJobs';
import { captureGateBlock } from '$lib/server/routing/captureGate';
import { env } from '$env/dynamic/private';
import type { Tier } from '$lib/server/phase_classifier';

export interface AutonomousDispatchArgs {
	/** The latest user message text (space-joined, trimmed). */
	userText: string;
	targetRepo: string;
	threadId: string;
	/**
	 * The pre-extracted SULLY_GATE self-assessment block, if any. Present only
	 * on the CLI-bridge path. When provided, it is validated and its
	 * escalate/worker/brief/category steer the decision; when omitted (direct/
	 * local path), the deterministic gates alone decide.
	 */
	gateBlock?: string | null;
	/**
	 * The Task id minted in prepareStream for this turn. When present, the
	 * dispatched job + the system "sent to worker" message reuse it (instead of
	 * minting a fresh sully-* id), so the whole turn — operator row, reply,
	 * dispatch, journal — shares one handle. The 'proposed' Task row created at
	 * turn start gets promoted to 'decided' by the dispatch. Falls back to a
	 * minted id if absent (legacy callers).
	 */
	taskId?: string;
	/** The thread's classified tier this turn — gates brainstorm suppression. */
	tier?: Tier;
}

/**
 * Evaluate the autonomous-dispatch gates and, if they fire, hand the request
 * to a background worker + write the system "sent to worker" chat message.
 *
 * No-op when companion dispatch is disabled — matches both paths' top-level
 * `runMode.companionDispatchEnabled` guard. The CLI path additionally gates on
 * `!errored` BEFORE calling this (a half/failed gen should never dispatch).
 */
export async function maybeAutonomousDispatch(args: AutonomousDispatchArgs): Promise<void> {
	if (!runMode.companionDispatchEnabled) return;

	const { userText, targetRepo, threadId } = args;
	// Reuse the turn's Task id so the dispatch promotes the existing 'proposed'
	// row rather than creating an orphan. Fall back to a minted id for legacy
	// callers that don't pass one.
	const taskId = args.taskId ?? mintTaskId();

	// The single source of truth for the route — same function the scorecard
	// grades, so test and production can't drift. gateBlock is undefined on the
	// direct/local path (no model vote to strip).
	const d = decide({
		userText,
		fromTool: false,
		recentTier: args.tier,
		gateBlock: args.gateBlock
	});

	// Preserve the teacher's brief/category when a valid gate block is present;
	// otherwise fall back to a userText slice + 'code'.
	const gate = args.gateBlock !== undefined ? validateGate(args.gateBlock ?? null) : null;
	const category = gate && gate.ok ? gate.gate.category : 'code';
	const brief = gate && gate.ok ? gate.gate.brief : userText.slice(0, 200);

	// Capture the teacher's model-vote block (CLI path) for later OFFLINE scoring
	// of the SULLY_GATE layer. Free, env-gated, best-effort — off by default.
	if (args.gateBlock !== undefined && env.ROUTING_CAPTURE_GATES === '1') {
		captureGateBlock({ userText, gateBlock: args.gateBlock ?? null, tier: args.tier });
	}

	if (d.action === 'Dispatch' && d.worker) {
		// taskId is the trace_id — dispatchToWorker → createJob upserts the
		// 'proposed'/'classified' row to 'decided'.
		const res = await dispatchToWorker({
			traceId: taskId,
			worker: d.worker,
			category,
			brief,
			targetRepo,
			task: userText,
			threadId
		});
		logTaskEvent(taskId, 'gate_evaluated', {
			action: d.action,
			reason: d.reason,
			worker: d.worker,
			category,
			dispatched: res.ok,
			held_reason: res.ok ? null : res.reason
		});
		addChatMessage(
			'system',
			res.ok
				? `On it — this one needs some real digging, so give me a few minutes. I'll drop the answer right here the moment it's ready.`
				: `⚠️ Dispatch held: ${res.reason}.`,
			res.ok ? taskId : null,
			null,
			null,
			'sent',
			threadId,
			{ taskId }
		);
		// If the dispatch was HELD (brakes/cap/dedupe/kill-switch), no worker took
		// the turn — close the arc as self-handled rather than stranding the Task
		// at proposed/classified (the reaper only scans dispatched/working, so it
		// would never reach it).
		if (!res.ok) markSelfHandled(taskId);
		return;
	}

	// Talk or Ask — no worker fired this turn. Journal the routing decision (a
	// training pair for v3: turn → reason → no-dispatch) AND close the
	// self-handled arc so the Task reaches a real terminal (Phase 0 fix 0.3).
	logTaskEvent(taskId, 'gate_evaluated', { action: d.action, reason: d.reason, dispatched: false });
	markSelfHandled(taskId);
}
