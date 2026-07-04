import { addChatMessage } from '$lib/server/chat';
import { serverConfig } from '$lib/server/config';
import { emitDispatchLinkObservation } from '$lib/server/observation_emit';
import { getHistorySinceReset } from '$lib/server/chat/history';
import type { ChatPostContext } from '$lib/server/chat/legacy_context';

const GATEWAY_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

function buildLegacyWorkerPrompt(ctx: ChatPostContext, historyContext: string): string {
	return `You are a background agent in a co-working chat with the Operator (Captain).
Here is the recent conversation history for context:
---
${historyContext}
---
The operator's latest command is: "${ctx.normalizedMessage}"

Please execute the request, make any necessary code/file modifications in your target repository (${ctx.targetRepo}).

LEARNING — if you discover a non-obvious pattern, constraint, gotcha,
or repeatable lesson, emit an observation BEFORE your final message:

  python tools/emit_chat_observation.py \\
    --project-id ${ctx.targetRepo} \\
    --kind what-worked \\
    --text "<1-3 sentence statement of action + outcome>" \\
    --task-shape '["streaming","layout"]'

--kind values: what-worked | what-didnt-work | surprise | routing-correction
(aliases: lesson → what-worked, failure → what-didnt-work).

Not for trivial work. Only when the next worker doing similar work would
benefit. Keep observations concise — 1-3 sentences, action-oriented.

REPLY PROTOCOL — write your final response back to the chat with this EXACT shape:

  python tools/emit_chat_message.py --sender cc --trace_id "$LOGUEOS_TRACE_ID" --thread "${ctx.threadId}" --message "<your response>"

(use --sender agy instead of cc if you are Antigravity / a Gemini-class worker).

Both --trace_id and --thread are REQUIRED. Without --trace_id the chat UI
cannot match your reply to this dispatch and will show "Working..." forever.
Without --thread your reply lands in the default thread instead of the one
the operator was working in. Always include both — the literal thread name
for this dispatch is "${ctx.threadId}".

If you need approval for commands, run 'wait_for_approval.py'.

PROGRESS REPORTING — emit fine-grained activity between tool calls so the
Operator can see what you're doing in the chat live. Call this between each
distinct step (reading a file, editing, running a command, finishing):

  python tools/emit_chat_activity.py --trace-id "$LOGUEOS_TRACE_ID" --action reading --target src/foo.svelte
  python tools/emit_chat_activity.py --trace-id "$LOGUEOS_TRACE_ID" --action edited --target src/foo.svelte
  python tools/emit_chat_activity.py --trace-id "$LOGUEOS_TRACE_ID" --action ran --target "npm test"
  python tools/emit_chat_activity.py --trace-id "$LOGUEOS_TRACE_ID" --action thinking

action vocab during work: reading | edited | ran | thinking.

CLOSING PROTOCOL — REQUIRED. After your final emit_chat_message above, ALWAYS
emit ONE terminal activity row so the chat tab knows you're done:

  python tools/emit_chat_activity.py --trace-id "$LOGUEOS_TRACE_ID" --action completed
  # OR if the task ended badly:
  python tools/emit_chat_activity.py --trace-id "$LOGUEOS_TRACE_ID" --action failed --target "<brief reason>"

Without this terminal emit the streaming bubble never closes. Treat it as
non-optional. The script is fast (~30ms).

NARRATION STYLE — your stdout streams live to the operator's chat as a
"streaming" bubble. NEVER write pause-framed narration like:

  ✗ "I'll pause here until the build finishes"
  ✗ "Waiting for the test suite to complete"
  ✗ "Let me wait for X..."
  ✗ "I'll hold here while..."

That phrasing makes the operator think you've stalled. Instead, narrate
as ACTIVE progress and emit an activity row for any long subprocess:

  ✓ "Running the build now."
    → python tools/emit_chat_activity.py --trace-id "$LOGUEOS_TRACE_ID" --action ran --target "npm run build"
  ✓ "Type-checking the diff."
    → python tools/emit_chat_activity.py --trace-id "$LOGUEOS_TRACE_ID" --action ran --target "svelte-check"

Keep stdout narration short and present-tense. The chat already shows
the activity ticker + spinner — you don't need to announce that you're
waiting.`;
}

export async function handleKernelDispatch(ctx: ChatPostContext): Promise<void> {
	// Trigger a background dispatch via the gateway!
	// Pull the last 30 messages, then trim to anything AFTER the most
	// recent "--- NEW CONVERSATION ---" system marker so operator-initiated
	// resets actually clear worker context (instead of leaking older
	// threads into the new one).
	const { formattedText: historyContext } = getHistorySinceReset(ctx.threadId, 30);
	const workerPrompt = buildLegacyWorkerPrompt(ctx, historyContext);

	try {
		// PR 8: emit a linking observation BEFORE dispatch so the dispatched
		// worker can receive operator chat context as injected memory.
		emitDispatchLinkObservation(
			ctx.threadId,
			ctx.normalizedMessage,
			ctx.targetRepo,
			ctx.currentTier
		);

		const response = await fetchWithTimeout(
			`${serverConfig.gatewayUrl}/api/v1/dispatch`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					tool_profile: 'standard_worker',
					worker: ctx.worker === 'auto' ? undefined : ctx.worker,
					role: ctx.worker === 'auto' ? ctx.role : undefined,
					target_repo: ctx.targetRepo,
					ticket_id: ctx.ticketId,
					prompt: workerPrompt,
					thinking_level: 'none',
					// Sonnet by default for chat dispatches - 3-5x faster
					// first-token + tool-call latency than Opus with no
					// meaningful quality drop for casual chat work. Heavy
					// tasks can override via a future model-pill toggle.
					model: 'claude-sonnet-4-6'
				})
			},
			GATEWAY_TIMEOUT_MS
		);

		if (response.ok) {
			const data = await response.json();
			// Emit system notification that the agent is starting
			addChatMessage(
				'system',
				`Agent dispatched: **${ctx.worker === 'auto' ? 'Role Routing' : ctx.worker}** is spinning up to handle this request on **${ctx.targetRepo}**. (Trace ID: ${data.trace_id || 'unknown'})`,
				data.trace_id || null,
				ctx.ticketId,
				null,
				'sent',
				ctx.threadId
			);
		} else {
			// Surface dispatch failures into the chat so the operator
			// isn't waiting on a worker that never started. The console
			// log keeps the full payload; the chat gets a one-line
			// summary with the status code + a sanitized reason.
			const text = await response.text();
			console.error('Dispatch failed in chat POST:', text);
			let reason = `HTTP ${response.status}`;
			try {
				const parsed = JSON.parse(text);
				const inner = parsed?.error;
				if (typeof inner === 'string') {
					reason = inner;
				} else if (inner && typeof inner === 'object') {
					reason = inner.error || JSON.stringify(inner);
				}
			} catch {
				// keep the HTTP-status fallback
			}
			addChatMessage(
				'system',
				`⚠️ **Dispatch failed.** ${ctx.worker === 'auto' ? 'Role-routed worker' : ctx.worker} could not be spawned on **${ctx.targetRepo}**. Reason: \`${reason}\`. Check the dispatch_listener logs (\`journalctl -u logueos-dispatch-listener\`) for details, then retry.`,
				null,
				ctx.ticketId,
				null,
				'sent',
				ctx.threadId
			);
		}
	} catch (err) {
		console.error('Auto-dispatch error in chat:', err);
		const msg = err instanceof Error ? err.message : String(err);
		addChatMessage(
			'system',
			`⚠️ **Dispatch errored before reaching the listener.** Could not reach the gateway: \`${msg.slice(0, 200)}\`. Check the gateway is running (\`systemctl status logueos-mcp-gateway\`).`,
			null,
			ctx.ticketId,
			null,
			'sent',
			ctx.threadId
		);
	}
}
