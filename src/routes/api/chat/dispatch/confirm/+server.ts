import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runMode } from '$lib/server/config';
import { getProposalByTaskId, markAborted, markSelfHandled } from '$lib/server/dispatchJobs';
import { dispatchToWorker } from '$lib/server/companionDispatch';
import { addChatMessage, resolveProposalMessage } from '$lib/server/chat';
import { logTaskEvent } from '$lib/server/chatActivity';

const workerLabel = (w: 'claude-code' | 'gemini'): string => (w === 'gemini' ? 'AGY' : 'CC');

/**
 * Tap-to-confirm endpoint for ask-before-dispatch (the buttons on a proposal
 * bubble). POST { taskId, decision: 'run' | 'dismiss' }.
 *
 * Safe by construction: getProposalByTaskId returns ONLY a still-'gated' row, so
 * a double-tap or a tap after the proposal already expired/dispatched finds
 * nothing → we just clear the buttons (flip the message to 'denied') and report
 * `expired`, never a second dispatch. Auth = the tailnet boundary (same as the
 * other dispatch routes): public-Funnel callers are rejected.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!runMode.companionDispatchEnabled) {
		return json({ error: 'dispatch_disabled' }, { status: 404 });
	}
	if (request.headers.get('tailscale-funnel-request') !== null) {
		return json({ error: 'forbidden_public_callback' }, { status: 401 });
	}

	let body: { taskId?: string; decision?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'malformed_json' }, { status: 400 });
	}
	const taskId = (body.taskId || '').trim();
	const decision = body.decision;
	if (!taskId || (decision !== 'run' && decision !== 'dismiss')) {
		return json({ error: 'taskId_and_decision_required' }, { status: 400 });
	}

	const proposal = getProposalByTaskId(taskId);
	if (!proposal) {
		// Already consumed, dismissed, or expired (operator moved on). Clear the
		// stale buttons and report it — no error, nothing to dispatch.
		resolveProposalMessage(taskId, 'denied');
		return json({ ok: true, expired: true });
	}

	if (decision === 'dismiss') {
		markAborted(proposal.taskId);
		resolveProposalMessage(proposal.taskId, 'denied');
		logTaskEvent(proposal.taskId, 'gate_evaluated', {
			action: 'Ask',
			reason: 'operator-dismissed-button',
			worker: proposal.worker,
			dispatched: false
		});
		addChatMessage(
			'local',
			`No problem — I'll hold off on that.`,
			null,
			null,
			null,
			'sent',
			proposal.threadId
		);
		return json({ ok: true, dispatched: false });
	}

	// decision === 'run'
	const res = await dispatchToWorker({
		traceId: proposal.taskId,
		worker: proposal.worker,
		category: proposal.category,
		brief: proposal.brief,
		targetRepo: proposal.targetRepo,
		task: proposal.task,
		threadId: proposal.threadId
	});
	resolveProposalMessage(proposal.taskId, res.ok ? 'approved' : 'denied');
	logTaskEvent(proposal.taskId, 'gate_evaluated', {
		action: 'Dispatch',
		reason: 'operator-confirmed-button',
		worker: proposal.worker,
		dispatched: res.ok,
		held_reason: res.ok ? null : res.reason
	});
	const msg = res.ok
		? `On it — handing that to ${workerLabel(proposal.worker)} now. I'll drop the answer right here when it's ready.`
		: `⚠️ Dispatch held: ${res.reason}.`;
	addChatMessage(
		'system',
		msg,
		res.ok ? proposal.taskId : null,
		null,
		null,
		'sent',
		proposal.threadId,
		{
			taskId: proposal.taskId
		}
	);
	if (!res.ok) markSelfHandled(proposal.taskId);
	return json({ ok: true, dispatched: res.ok });
};
