// Task close-out: post Sully's completion message into the originating thread,
// link it as the synthesis message, and fire a (self-gated) push. Extracted
// from the activity route so it is unit-testable and so BOTH bugs are fixed in
// one place: (1) empty-string thread_id must fall back to 'default'; (2) the
// post must happen even when the FSM rejects done→synthesized (e.g. a
// completed callback that lands after an abort) — synthesis is best-effort.
import { addChatMessage } from './chat';
import { logTaskEvent, hasTaskEvent } from './chatActivity';
import { getJob, markSynthesized, markVerified } from './dispatchJobs';
import { appIdentity } from './config';
import { sendPushToAll } from './web_push';
import { sendApnsToAll } from './apns';
import { synthesizeWorkerResult } from './routing/synthesize';
import { shouldReview, runAdversaryReview } from './routing/adversary';
import { runPoll } from './verifyPoll';
import type { EvidenceEnvelope } from './verifyPoll';

/** Empty string OR null/undefined thread_id → 'default'. (`??` alone misses ''.) */
export function resolveCompletionThread(threadId: string | null | undefined): string {
	return threadId && threadId.trim() ? threadId : 'default';
}

export async function closeOutTask(
	traceId: string,
	outcome: 'done' | 'failed',
	resultText: string,
	evidence: EvidenceEnvelope = {}
): Promise<void> {
	const job = getJob(traceId);
	// Idempotency guard: a retried/duplicate terminal callback (network hiccup,
	// at-least-once delivery) must NOT post a second message or fire a second
	// push. We've already closed this Task out if it reached 'synthesized' OR a
	// 'synthesis_completed' event was journaled — the latter covers the aborted/
	// failed path where markSynthesized can't flip the row, so the status check
	// alone would miss it.
	if (job?.status === 'synthesized') return;
	// Unbounded existence check (not capped to the first N activity rows) so a
	// late synthesis_completed event can't be missed → no duplicate post/push.
	if (hasTaskEvent(traceId, 'synthesis_completed')) return;
	const threadId = resolveCompletionThread(job?.thread_id);
	const text = resultText.trim();

	// ── Phase 4: deterministic Go/No-Go poll BEFORE synthesis (only on success). ──
	let pollPosture: 'confirmed' | 'hedge' | 'warn' = 'confirmed';
	if (outcome === 'done' && job) {
		try {
			const poll = await runPoll(job, evidence);
			pollPosture = poll.posture;
			logTaskEvent(traceId, 'verification_poll', {
				overall: poll.posture,
				needs_review: poll.needs_review,
				channels: poll.channels.map((c) => ({
					channel: c.channel,
					state: c.state,
					detail: c.detail
				}))
			});
			try {
				markVerified(
					traceId,
					poll.posture,
					poll.ledger.find((e) => e.critical)?.evidence_pointer ?? null,
					JSON.stringify(poll.channels)
				);
			} catch {
				/* terminal-state race — non-fatal */
			}
		} catch (e) {
			console.warn('[completionClose] poll skipped:', e);
		}
	}

	// ── Phase 5 (Plan B): stakes-gated adversary review. After the poll, before
	// synthesis. TOTAL (I7) — any error → no concerns, proceed; never blocks.
	let concerns: string[] = [];
	if (outcome === 'done' && job && text && shouldReview(job, evidence)) {
		try {
			const matrix = `posture=${pollPosture}`;
			const adv = await runAdversaryReview({ brief: job.brief ?? '', result: text, matrix });
			concerns = adv.findings.map((f) => f.concern);
			logTaskEvent(traceId, 'adversary_reviewed', {
				available: adv.available,
				count: adv.findings.length,
				findings: adv.findings
			});
		} catch (e) {
			console.warn('[completionClose] adversary skipped:', e); // never blocks (I7)
		}
	}

	// Real Sully synthesis (Phase 3): when there's a worker result, have Sully
	// summarize it in plain English (Haiku) so the Captain can digest it without
	// a follow-up. Best-effort — on any failure/timeout `summary` is null and we
	// fall back to posting the raw result verbatim (nothing is lost).
	const summary = text
		? await synthesizeWorkerResult({
				brief: job?.brief ?? '',
				result: text,
				posture: pollPosture,
				concerns
			})
		: null;
	const msg = summary
		? summary
		: outcome === 'done'
			? text
				? `Done. Here's what came back:\n\n${text}`
				: `That's finished — the task completed cleanly.`
			: text
				? `That one hit a snag: ${text}`
				: `That one didn't complete — I'll need another look.`;
	try {
		const row = addChatMessage('local', msg, traceId, null, null, 'sent', threadId, {
			taskId: traceId
		});
		logTaskEvent(traceId, 'synthesis_completed', { outcome, via: 'worker-result' });
		// Best-effort link — FSM may reject the transition from a terminal state;
		// the operator-facing message above has ALREADY landed regardless.
		try {
			markSynthesized(traceId, row.id);
		} catch {
			/* already terminal (aborted/failed/synthesized) — non-fatal */
		}
		// Push ONLY after the message persisted — otherwise a failed post would
		// still ping "task done" with nothing in the thread to show. Both legs are
		// self-gated (no-op until creds + a device exist).
		const pushPayload = {
			title: outcome === 'done' ? 'Sully — task done' : 'Sully — task needs you',
			body:
				outcome === 'done' ? 'Your task finished. Tap to see the result.' : 'A task hit a snag.',
			url: appIdentity.pushDefaultUrl
		};
		void sendPushToAll(pushPayload).catch((e) =>
			console.error('[completionClose] web push failed', e)
		);
		void sendApnsToAll(pushPayload).catch((e) =>
			console.error('[completionClose] apns push failed', e)
		);
	} catch (e) {
		console.error('[completionClose] message failed', e);
	}
}
