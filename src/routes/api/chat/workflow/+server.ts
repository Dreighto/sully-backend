import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import Database from 'better-sqlite3';
import { serverConfig, runMode } from '$lib/server/config';
import { addChatMessage, getChatMessages } from '$lib/server/chat';

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

type WorkflowAction = 'critique' | 'build' | 'verify' | 'retry';
type AgentChoice = 'claude-code' | 'agy';

interface ChatMessageRow {
	id: number;
	sender: string;
	message: string;
	trace_id: string | null;
	timestamp: string;
	thread_id: string;
}

function fetchMessageById(messageId: number): ChatMessageRow | null {
	const db = new Database(serverConfig.memoryDbPath, { readonly: true });
	try {
		const row = db
			.prepare(
				'SELECT id, sender, message, trace_id, timestamp, thread_id FROM chat_messages WHERE id = ?'
			)
			.get(messageId) as ChatMessageRow | undefined;
		return row || null;
	} catch (e) {
		console.error('fetchMessageById error:', e);
		return null;
	} finally {
		db.close();
	}
}

// Find the operator message that triggered a given worker reply, so the
// retry action can re-fire it against a different agent. We look backward
// from the source row for the most recent operator message before it.
function findOperatorAncestor(sourceId: number): ChatMessageRow | null {
	const db = new Database(serverConfig.memoryDbPath, { readonly: true });
	try {
		const row = db
			.prepare(
				`SELECT id, sender, message, trace_id, timestamp
				 FROM chat_messages
				 WHERE id < ? AND sender = 'operator'
				 ORDER BY id DESC
				 LIMIT 1`
			)
			.get(sourceId) as ChatMessageRow | undefined;
		return row || null;
	} catch (e) {
		console.error('findOperatorAncestor error:', e);
		return null;
	} finally {
		db.close();
	}
}

function buildHistoryContext(threadId = 'default'): string {
	// Same convention as /api/chat: replay the last 30 messages, sliced at
	// the most recent "--- NEW CONVERSATION ---" marker. Workers benefit
	// from the same conversational context their parent dispatches used.
	// Scoped to the source message's thread so cross-thread context doesn't
	// leak into the worker's prompt.
	const all = getChatMessages(30, threadId);
	let lastResetIdx = -1;
	for (let i = all.length - 1; i >= 0; i--) {
		if (
			all[i].sender === 'system' &&
			all[i].message.startsWith('--- NEW CONVERSATION ---')
		) {
			lastResetIdx = i;
			break;
		}
	}
	const slice = lastResetIdx >= 0 ? all.slice(lastResetIdx + 1) : all;
	return slice.map((m) => `[${m.sender} - ${m.timestamp}]: ${m.message}`).join('\n');
}

function buildWorkflowPrompt(
	action: WorkflowAction,
	source: ChatMessageRow,
	targetRepo: string,
	originalOperatorRequest?: string
): { systemAnnouncement: string; workerPrompt: string } {
	const history = buildHistoryContext(source.thread_id || 'default');
	const sourceLabel =
		source.sender === 'operator'
			? 'the operator'
			: source.sender === 'cc'
				? 'Claude Code (CC)'
				: source.sender === 'agy'
					? 'Antigravity (AGY)'
					: source.sender;

	const sharedHeader = `You are a background agent in a co-working chat with the Operator (Captain).
Recent conversation history for context:
---
${history}
---`;

	const replyProtocolFooter = `

LEARNING — if you discover a non-obvious pattern, constraint, gotcha,
or repeatable lesson, emit an observation BEFORE your final message:

  python tools/emit_chat_observation.py \\
    --project-id ${targetRepo} \\
    --kind what-worked \\
    --text "<1-3 sentence statement of action + outcome>" \\
    --task-shape '["streaming","layout"]'

--kind values: what-worked | what-didnt-work | surprise | routing-correction
(aliases: lesson → what-worked, failure → what-didnt-work).

Not for trivial work. Only when the next worker doing similar work would
benefit. Keep observations concise — 1-3 sentences, action-oriented.

REPLY PROTOCOL — write your final response back to the chat with this EXACT shape:

  python tools/emit_chat_message.py --sender cc --trace_id "$LOGUEOS_TRACE_ID" --thread "${source.thread_id || 'default'}" --message "<your response>"

(use --sender agy instead of cc if you are Antigravity / a Gemini-class worker).

Both --trace_id and --thread are REQUIRED. The literal thread name for this workflow is "${source.thread_id || 'default'}".

After your final emit_chat_message, ALWAYS emit ONE terminal activity row:

  python tools/emit_chat_activity.py --trace-id "$LOGUEOS_TRACE_ID" --action completed
  # OR if the task ended badly:
  python tools/emit_chat_activity.py --trace-id "$LOGUEOS_TRACE_ID" --action failed --target "<brief reason>"

NARRATION STYLE — your stdout streams live to the operator's chat as a "streaming" bubble. NEVER write pause-framed narration like "I'll pause here until X finishes", "waiting for Y", "let me wait for...". That phrasing makes the operator think you've stalled. Instead, narrate as ACTIVE present-tense progress ("Running the build now.", "Type-checking the diff.") and emit an activity row for any long subprocess: \`python tools/emit_chat_activity.py --trace-id "$LOGUEOS_TRACE_ID" --action ran --target "<command>"\`. The chat already shows the activity ticker + spinner — don't announce that you're waiting.`;

	switch (action) {
		case 'critique':
			return {
				systemAnnouncement: `🔍 Critique requested on ${sourceLabel}'s reply (msg #${source.id}).`,
				workerPrompt: `${sharedHeader}

The Operator wants you to CRITIQUE the following reply from ${sourceLabel} (message #${source.id}). Focus on logical issues, edge cases, missing pieces, hidden assumptions, and risks. Be specific: cite exact lines or claims. If the reply is correct, say so confidently and explain why. If it's wrong or incomplete, lay out what's missing or flawed.

---
REPLY UNDER REVIEW:
${source.message}
---

Target repository for any code references: ${targetRepo}.${replyProtocolFooter}`
			};

		case 'build':
			return {
				systemAnnouncement: `🔨 Build requested from ${sourceLabel}'s proposal (msg #${source.id}).`,
				workerPrompt: `${sharedHeader}

The Operator wants you to IMPLEMENT the plan/proposal from ${sourceLabel} (message #${source.id}). Make the actual code/file changes in ${targetRepo}. Follow the standard worker flow: pre-flight checks → branch → implement → commit → PR if appropriate.

Use the worker prompt's recent conversation history for additional context about what the operator actually wants — the proposal may have been refined or critiqued in subsequent messages.

---
PROPOSAL TO IMPLEMENT:
${source.message}
---${replyProtocolFooter}`
			};

		case 'verify':
			return {
				systemAnnouncement: `🧪 Verification requested on ${sourceLabel}'s claim (msg #${source.id}).`,
				workerPrompt: `${sharedHeader}

The Operator wants you to VERIFY the implementation/claim from ${sourceLabel} (message #${source.id}). Independently check:
  1. Does the code on disk match what was claimed?
  2. Do the tests pass?
  3. Are there regressions or edge cases the implementer missed?
  4. Is the diff appropriately scoped (no unrelated changes)?

Run real checks — git diff, npm test or pytest, build commands as appropriate for ${targetRepo}. Report what you actually found, not what should be there in theory. If something looks wrong, say exactly what.

---
CLAIM/IMPLEMENTATION UNDER VERIFICATION:
${source.message}
---${replyProtocolFooter}`
			};

		case 'retry': {
			const original = originalOperatorRequest || source.message;
			return {
				systemAnnouncement: `↻ Retry of operator request (msg #${source.id}'s parent).`,
				workerPrompt: `${sharedHeader}

This is a RETRY of a previous operator request that the prior worker handled (or attempted). Take a fresh look, ignore the prior reply's framing, and produce your own answer.

Operator's request:
"${original}"

Target repository: ${targetRepo}.${replyProtocolFooter}`
			};
		}
	}
}

export const POST: RequestHandler = async ({ request }) => {
	// Workflow buttons (Critique/Build/Verify/Retry) dispatch workers through the
	// kernel gateway, which is off in companion mode. Buttons are also hidden
	// client-side; this is the server-side belt-and-suspenders.
	if (!runMode.dispatchEnabled) {
		return json(
			{ error: 'Workflow dispatch is a kernel feature and is not available in the Companion.' },
			{ status: 200 }
		);
	}
	try {
		const body = await request.json();
		const action: WorkflowAction = body.action;
		const sourceMessageId = Number(body.source_message_id);
		const targetAgent: AgentChoice = body.target_agent;
		const targetRepo: string = body.target_repo || 'LogueOS-Console';

		if (!action || !['critique', 'build', 'verify', 'retry'].includes(action)) {
			return json({ error: 'invalid action' }, { status: 400 });
		}
		if (!Number.isFinite(sourceMessageId) || sourceMessageId <= 0) {
			return json({ error: 'invalid source_message_id' }, { status: 400 });
		}
		if (!targetAgent || !['claude-code', 'agy'].includes(targetAgent)) {
			return json({ error: 'invalid target_agent' }, { status: 400 });
		}

		const source = fetchMessageById(sourceMessageId);
		if (!source) return json({ error: 'source message not found' }, { status: 404 });

		let originalOperatorRequest: string | undefined;
		if (action === 'retry') {
			const ancestor = findOperatorAncestor(sourceMessageId);
			if (!ancestor) {
				return json(
					{ error: 'no operator ancestor to retry — source not derived from an operator message' },
					{ status: 400 }
				);
			}
			originalOperatorRequest = ancestor.message;
		}

		const { systemAnnouncement, workerPrompt } = buildWorkflowPrompt(
			action,
			source,
			targetRepo,
			originalOperatorRequest
		);

		// Insert the announcement bubble FIRST so the operator sees the
		// action took effect before the dispatch round-trip finishes. Thread
		// scoping inherits from the source message so workflow chains stay
		// in the thread the operator was working in.
		const threadId = source.thread_id || 'default';
		addChatMessage('operator', systemAnnouncement, null, null, null, 'sent', threadId);

		const response = await fetchWithTimeout(
			`${serverConfig.gatewayUrl}/api/v1/dispatch`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					tool_profile: 'standard_worker',
					worker: targetAgent,
					target_repo: targetRepo,
					prompt: workerPrompt,
					thinking_level: 'none',
					model: 'claude-sonnet-4-6'
				})
			},
			GATEWAY_TIMEOUT_MS
		);

		if (response.ok) {
			const data = await response.json();
			addChatMessage(
				'system',
				`Agent dispatched: **${targetAgent}** is handling this ${action}. (Trace ID: ${data.trace_id || 'unknown'})`,
				data.trace_id || null,
				null,
				null,
				'sent',
				threadId
			);
			return json({ ok: true, trace_id: data.trace_id });
		}

		const text = await response.text();
		let reason = `HTTP ${response.status}`;
		try {
			const parsed = JSON.parse(text);
			if (typeof parsed?.error === 'string') reason = parsed.error;
		} catch {
			/* fallthrough */
		}
		addChatMessage(
			'system',
			`⚠️ **${action} dispatch failed.** ${targetAgent} on ${targetRepo}. Reason: \`${reason}\`.`,
			null,
			null,
			null,
			'sent',
			threadId
		);
		return json({ error: reason }, { status: 502 });
	} catch (e: unknown) {
		console.error('POST /api/chat/workflow error:', e);
		const msg = e instanceof Error ? e.message : 'unknown error';
		return json({ error: msg }, { status: 500 });
	}
};
