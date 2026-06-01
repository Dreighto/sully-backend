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
import { ruleGate, valueGate, validateGate } from '$lib/server/decisionGate';
import { dispatchToWorker } from '$lib/server/companionDispatch';

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
	const hasGate = args.gateBlock !== undefined;

	const forced = ruleGate(userText);
	const vg = valueGate({ text: userText, fromTool: false });

	if (hasGate) {
		// CLI-bridge path — gate-block-aware escalate decision.
		const gate = validateGate(args.gateBlock ?? null);
		const autonomous = gate.ok && gate.gate.escalate && vg.qualifies && !vg.forceAsk;
		if (forced.forced || autonomous) {
			const worker =
				forced.forced && forced.worker ? forced.worker : gate.ok ? gate.gate.worker : 'claude-code';
			const brief = gate.ok ? gate.gate.brief : userText.slice(0, 200);
			const category = gate.ok ? gate.gate.category : 'code';
			const traceId = `sully-${Date.now()}`;
			const res = await dispatchToWorker({
				traceId,
				worker,
				category,
				brief,
				targetRepo,
				task: userText,
				threadId
			});
			addChatMessage(
				'system',
				res.ok
					? `Sully sent this to **${worker === 'claude-code' ? 'CC' : 'AGY'}** on **${targetRepo}** — watching it now.`
					: `⚠️ Dispatch held: ${res.reason}.`,
				res.ok ? traceId : null,
				null,
				null,
				'sent',
				threadId
			);
		}
		return;
	}

	// Direct/local path — deterministic gates only, no gate block to strip.
	if (forced.forced || (vg.qualifies && !vg.forceAsk)) {
		const worker = forced.forced && forced.worker ? forced.worker : 'claude-code';
		const traceId = `sully-${Date.now()}`;
		const res = await dispatchToWorker({
			traceId,
			worker,
			category: 'code',
			brief: userText.slice(0, 200),
			targetRepo,
			task: userText,
			threadId
		});
		addChatMessage(
			'system',
			res.ok
				? `Sully sent this to **${worker === 'claude-code' ? 'CC' : 'AGY'}** on **${targetRepo}** — watching it now.`
				: `⚠️ Dispatch held: ${res.reason}.`,
			res.ok ? traceId : null,
			null,
			null,
			'sent',
			threadId
		);
	}
}
