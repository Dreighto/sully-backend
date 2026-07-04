import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getChatMessages, addChatMessage, deleteChatMessage } from '$lib/server/chat';
import { serverConfig, runMode } from '$lib/server/config';
import { callHermes, chatRowsToHermesHistory } from '$lib/server/hermes';
import { generateGeminiImage } from '$lib/server/gemini';
import { upsertThreadTier } from '$lib/server/thread_state';
import { routeChat } from '$lib/server/llm_router';
import type { RouterMessage } from '$lib/server/llm_router';
// touchLastActivity no longer imported here — persistAssistantTurn calls it.
import { emitDispatchLinkObservation, maybeMarkDeepCandidate } from '$lib/server/observation_emit';
import { buildMultimodalContent } from '$lib/server/multimodal';
import {
	persistUserTurn,
	classifyAndTouchThread,
	persistAssistantTurn,
	mintTaskId
} from '$lib/server/chat_turn';
import { buildSystemPrompt } from '$lib/server/chat_prompt';
import { dispatchToWorker } from '$lib/server/companionDispatch';
import { normalizeInputText } from '$lib/server/input_normalizer';
import { detectTargetRepo } from '$lib/server/chat/stream_prepare';
import { getHistorySinceReset } from '$lib/server/chat/history';

const GATEWAY_TIMEOUT_MS = 10_000;

// buildSystemPrompt: extracted to $lib/server/chat_prompt.ts (PR C). The
// legacy route does not take the sdk-stream's allowSensitive flag (no SDK
// tools attached on this path) — pass allowSensitive: false.

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

export const GET: RequestHandler = async ({ url }) => {
	try {
		const limitParam = url.searchParams.get('limit');
		const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
		const thread = (url.searchParams.get('thread') || 'default').trim() || 'default';
		const messages = getChatMessages(limit, thread);
		return json({ messages });
	} catch (e: unknown) {
		console.error('GET /api/chat error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};

// DELETE /api/chat?id=<n>  — drop a single chat message by id. Used by the
// regenerate flow to remove the old assistant reply before re-streaming a
// new one. Operator-only (gated by the auth hook on /api/chat/*).
export const DELETE: RequestHandler = async ({ url }) => {
	try {
		const idStr = url.searchParams.get('id');
		const id = idStr ? Number.parseInt(idStr, 10) : NaN;
		if (!Number.isFinite(id) || id <= 0) {
			return json({ error: 'invalid id' }, { status: 400 });
		}
		const deleted = deleteChatMessage(id);
		return json({ deleted });
	} catch (e: unknown) {
		console.error('DELETE /api/chat error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { sender, message, ticket_id } = body;
		// Explicit agent selection from the chat UI's pill switcher. Accepted
		// values: 'auto' | 'claude-code' | 'agy' | 'silent'. When set to anything
		// other than 'auto', it overrides the @-mention heuristic below.
		const explicitAgent: string =
			body && typeof body.agent === 'string' ? body.agent.trim().toLowerCase() : 'auto';
		// Thread scoping. Operators can have multiple parallel chats; each is
		// a separate thread_id. Default thread is 'default'.
		const threadId: string =
			(body && typeof body.thread === 'string' ? body.thread.trim() : '') || 'default';
		// Stage 2: client-supplied per-turn id. When present, a retry/regenerate
		// re-POST of the SAME turn reuses its original operator row + Task instead of
		// minting a duplicate. Absent → today's behaviour, byte-identical.
		const clientTurnId: string | null =
			body && typeof body.client_turn_id === 'string' && body.client_turn_id.trim()
				? body.client_turn_id.trim()
				: null;
		// Image-generation mode. When true, the operator's message is treated
		// as an image prompt instead of a chat message. Routes to
		// gemini-2.5-flash-image via the Gemini API. Independent of the
		// agent pill — though only AGY (Gemini-class) currently supports it.
		const imageMode: boolean = body && body.image === true;
		// Talkback flag: forces chat tier (Flash-lite) regardless of thread tier
		// per §2D.3 Step C / §2F decision 7. Hard-locked on the server so clients
		// cannot accidentally use a deep-tier model in the high-frequency loop.
		const isTalkback: boolean = body && body.talkback === true;
		const normalizedMessage = normalizeInputText(message || '', isTalkback ? 'walkie' : 'chat');

		if (!normalizedMessage.trim()) {
			return json({ error: 'Message content is required.' }, { status: 400 });
		}

		// Mint ONE turn task id before any DB write so the operator row, the task
		// row, and (if a worker fires) the gateway dispatch all share the same handle.
		// Behavior-neutral: proposed rows that never advance are already the Phase-1
		// norm for self-handled turns.
		const turnTaskId = mintTaskId();

		// 1. Persist the operator's turn + classify the conversation tier via
		// the shared chat_turn service (PR C). The legacy route alone needs the
		// returned row + the recent-message count for downstream side-effects.
		const persistedTurn = persistUserTurn({
			text: normalizedMessage,
			threadId,
			sender: sender || 'operator',
			ticketId: ticket_id || null,
			taskId: turnTaskId,
			source: isTalkback ? 'walkie' : 'chat',
			clientTurnId
		});
		const chatMsg = persistedTurn.row;
		// On a keyed reuse the EFFECTIVE task id is the original turn's task_id —
		// use it for classify AND any downstream dispatch so the reused row's Task
		// stays the single handle (a fresh id would orphan them). No key / new turn
		// → effectiveTaskId === turnTaskId, unchanged.
		const effectiveTaskId = persistedTurn.reused
			? (persistedTurn.taskId ?? turnTaskId)
			: turnTaskId;
		const { currentTier, threadState } = classifyAndTouchThread({
			threadId,
			userText: normalizedMessage,
			taskId: effectiveTaskId
		});
		// PR 8: silently mark Deep-tier threads with 3+ exchanges as observation
		// candidates. Count excludes the just-inserted operator message.
		const recentCount = Math.max(getChatMessages(30, threadId).length - 1, 0);
		maybeMarkDeepCandidate(threadId, currentTier, recentCount);
		let routerMeta: { provider_used: string; model_used: string } | null = null;

		// 2. Resolve worker selection. Operator's explicit pill wins if set;
		//    otherwise fall back to @-mention heuristic; otherwise 'auto'.
		const text = normalizedMessage.toLowerCase();
		let role = 'backend';
		let worker = 'auto';
		if (explicitAgent === 'claude-code' || explicitAgent === 'agy') {
			worker = explicitAgent;
		} else if (text.includes('@cc')) {
			worker = 'claude-code';
		} else if (text.includes('@agy') || text.includes('@gemini')) {
			worker = 'agy';
		}
		// Note: the previous bare-substring matching ('claude', 'cc', 'gemini')
		// was removed — it fired on unrelated mentions like "fix the Claude
		// config" or "the cc_completion_log path". Operators that want a
		// specific worker either use @cc / @agy explicitly or pick the pill.

		// Heuristic 2: Repository/Project selection. Use the canonical SDK-stream
		// detector so the legacy route honors the same Sully workspace/artifact rules.
		const targetRepo = detectTargetRepo(normalizedMessage);

		// Dispatch policy (revised 2026-05-26): default to CONVERSATIONAL reply
		// via the LLM router. Worker dispatch fires ONLY when the operator
		// signals explicit intent. Previous default (auto-dispatch every
		// message) was killing planning conversations with system-bubble noise
		// + worker-tone replies. Operator feedback: "it still reads like the
		// system is the one I am talking to when it should be a planning
		// partner... we are engaging in a conversation that will lead to a plan."
		//
		// Explicit dispatch signals:
		//   - explicitAgent === 'claude-code'  (operator picked CC in the pill)
		//   - @cc / @agy / @gemini in the message text (operator named a worker)
		//
		// Implicit conversational signals (default → llm_router, NO dispatch):
		//   - explicitAgent === 'auto' (default pill, no @-mention)
		//   - explicitAgent === 'agy'  (AGY chat mode — was already routing via llm_router)
		//
		// Workflow buttons (Critique/Build/Verify/Retry) still spawn workers
		// via /api/chat/workflow — that path is intentional and unchanged.
		//
		// Modes that don't fire a remote worker dispatch regardless:
		//   1. explicitAgent === 'silent' — chat note only.
		//   2. explicitAgent === 'hermes' — direct call to local Ollama.
		//   3. imageMode === true        — Gemini image generation.
		//   4. sender === 'system'       — system messages never re-dispatch.
		const isHermes = explicitAgent === 'hermes';
		const isAgyChat = explicitAgent === 'agy';
		const hasExplicitDispatchIntent =
			explicitAgent === 'claude-code' ||
			text.includes('@cc') ||
			text.includes('@agy') ||
			text.includes('@gemini');
		const shouldDispatch =
			hasExplicitDispatchIntent &&
			sender !== 'system' &&
			explicitAgent !== 'silent' &&
			!isHermes &&
			!imageMode;
		// Conversational path: everything that's not a dispatch, not Hermes,
		// not image-gen, not silent. Covers explicit 'agy' pill AND the new
		// default 'auto' chat behavior. Both route through llm_router.
		const shouldRouteChat =
			!shouldDispatch &&
			sender !== 'system' &&
			explicitAgent !== 'silent' &&
			!isHermes &&
			!imageMode;
		// Back-compat alias for the existing dispatch block below.
		const shouldTrigger = shouldDispatch;

		// Companion-native dispatch (Phase 1). When enabled, an explicit
		// @cc/@agy intent reaches a worker via the dispatch listener (HMAC) and
		// the worker streams activity back into companion.db. The KERNEL gateway
		// path below (runMode.dispatchEnabled) stays OFF in companion mode.
		if (shouldTrigger && !runMode.dispatchEnabled && runMode.companionDispatchEnabled) {
			// Use the effective task id so a reused turn's dispatch attaches to its
			// original Task rather than a fresh, orphaned handle.
			const traceId = effectiveTaskId;
			// `worker` was resolved above to 'claude-code' | 'agy' | 'auto'.
			// Spec §4.3: emit 'gemini' (the listener-accepted frontend name).
			const dispatchWorker = worker === 'claude-code' ? 'claude-code' : 'gemini';
			const res = await dispatchToWorker({
				traceId,
				worker: dispatchWorker,
				category: 'code',
				brief: normalizedMessage.trim().slice(0, 200),
				targetRepo,
				task: normalizedMessage.trim(),
				threadId
			});
			if (res.ok) {
				addChatMessage(
					'system',
					// Card-only in the UI (the morphing Task card renders this row); text
					// kept clean + trace-free for the stored record / non-UI surfaces.
					`Handing this to ${dispatchWorker === 'claude-code' ? 'CC' : 'AGY'}.`,
					traceId,
					ticket_id || null,
					null,
					'sent',
					threadId
				);
			} else {
				addChatMessage(
					'system',
					`⚠️ Dispatch held: ${res.reason}.`,
					null,
					ticket_id || null,
					null,
					'sent',
					threadId
				);
			}
			return json({ ok: true, trace_id: traceId });
		}

		// Companion mode WITHOUT the dispatch flag: @cc/@agy is unavailable.
		if (shouldTrigger && !runMode.dispatchEnabled) {
			addChatMessage(
				'system',
				'Worker dispatch (@cc / @agy) is a kernel feature and is not available in the Companion — this app talks to your local model. Just ask me directly.',
				null,
				null,
				null,
				'sent',
				threadId
			);
			return json({ ok: true });
		}

		// Hermes branch — local Ollama, no worker spawn, ~1-3s round-trip.
		// Skips the entire gateway/listener pipeline. Hermes has no file
		// access; it's a conversational sounding board with the operator
		// profile loaded as its system prompt.
		if (isHermes && sender !== 'system') {
			try {
				// Slice at the most recent NEW CONVERSATION marker, same as the
				// gateway-worker prompt builder. Hermes deserves the same fresh-
				// thread semantics.
				const { rows } = getHistorySinceReset(threadId, 30);
				// Exclude the operator message we JUST inserted (it's the
				// userMessage we pass separately to callHermes).
				const slice = rows.slice(0, -1);
				const history = chatRowsToHermesHistory(slice);
				const reply = await callHermes(history, normalizedMessage.trim());
				addChatMessage('hermes', reply, null, null, null, 'sent', threadId);
			} catch (err) {
				console.error('Hermes call failed:', err);
				const msg = err instanceof Error ? err.message : 'unknown error';
				addChatMessage(
					'system',
					`⚠️ **Hermes failed.** Local Ollama call errored: \`${msg.slice(0, 200)}\`. Check Ollama (\`ollama ps\`) and the qwen2.5:7b model.`,
					null,
					null,
					null,
					'sent',
					threadId
				);
			}
		}

		// Conversational chat branch — the DEFAULT path for any operator
		// message without explicit dispatch intent. Routes through the
		// tier-aware llm_router (Gemini OAuth primary, Anthropic fallback)
		// for a planning-partner-style reply. No worker spawn, no system
		// bubble. Workflow buttons (Build/Critique/Verify) still dispatch
		// the heavy worker via /api/chat/workflow when the operator wants
		// real file/code work — that path is unchanged.
		if (shouldRouteChat) {
			try {
				const { rows } = getHistorySinceReset(threadId, 30);
				const slice = rows.slice(0, -1);
				const routerMessages: RouterMessage[] = slice
					.filter((r) => r.sender !== 'system')
					.map((r) => ({
						role: (r.sender === 'operator' ? 'user' : 'assistant') as 'user' | 'assistant',
						content: r.message
					}));
				const lastContent = await buildMultimodalContent(normalizedMessage.trim());
				routerMessages.push({ role: 'user', content: lastContent });

				if (routerMessages.length > 20) {
					routerMessages.splice(0, routerMessages.length - 20);
				}

				const result = await routeChat(
					isTalkback ? 'chat' : currentTier,
					routerMessages,
					'gemini',
					undefined,
					await buildSystemPrompt({ targetRepo, currentTier, threadId }, normalizedMessage.trim())
				);
				addChatMessage('agy', result.reply, null, null, null, 'sent', threadId);
				upsertThreadTier(threadId, currentTier, result.model_used);
				routerMeta = { provider_used: result.provider_used, model_used: result.model_used };

				if (result.fell_forward) {
					addChatMessage(
						'system',
						`ℹ️ Primary provider unavailable — reply served by **${result.provider_used}** (${result.model_used}).`,
						null,
						null,
						null,
						'sent',
						threadId
					);
				}
			} catch (err) {
				console.error('LLM router chat call failed:', err);
				const msg = err instanceof Error ? err.message : 'unknown error';
				addChatMessage(
					'system',
					`⚠️ **LLM router failed.** \`${msg.slice(0, 200)}\`. Check provider keys and daily caps.`,
					null,
					null,
					null,
					'sent',
					threadId
				);
			}
		}

		// Image generation branch — uses gemini-2.5-flash-image regardless
		// of which pill the operator has set. The composer's image-mode
		// toggle is what flips this.
		if (imageMode && sender !== 'system') {
			try {
				const { url } = await generateGeminiImage(normalizedMessage.trim());
				const md = `![${normalizedMessage.trim().slice(0, 80) || 'generated image'}](${url})`;
				addChatMessage('agy', md, null, null, null, 'sent', threadId);
			} catch (err) {
				console.error('Gemini image gen failed:', err);
				const msg = err instanceof Error ? err.message : 'unknown error';
				// Only blame the key for genuine auth failures. The common case is
				// the model declining a prompt (copyrighted character, safety, etc.) —
				// show that real reason instead of a misleading "check your key".
				const isAuth = /not set in environment|HTTP 401|HTTP 403|API[_ ]?key/i.test(msg);
				const body = isAuth
					? `⚠️ **Image generation failed — API key problem.** \`${msg.slice(0, 300)}\``
					: `⚠️ **No image generated.** ${msg.slice(0, 400)}`;
				addChatMessage('system', body, null, null, null, 'sent', threadId);
			}
		}

		if (shouldTrigger && sender !== 'system') {
			// Trigger a background dispatch via the gateway!
			// Pull the last 30 messages, then trim to anything AFTER the most
			// recent "--- NEW CONVERSATION ---" system marker so operator-initiated
			// resets actually clear worker context (instead of leaking older
			// threads into the new one).
			const { formattedText: historyContext } = getHistorySinceReset(threadId, 30);

			const workerPrompt = `You are a background agent in a co-working chat with the Operator (Captain).
Here is the recent conversation history for context:
---
${historyContext}
---
The operator's latest command is: "${normalizedMessage}"

Please execute the request, make any necessary code/file modifications in your target repository (${targetRepo}).

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

  python tools/emit_chat_message.py --sender cc --trace_id "$LOGUEOS_TRACE_ID" --thread "${threadId}" --message "<your response>"

(use --sender agy instead of cc if you are Antigravity / a Gemini-class worker).

Both --trace_id and --thread are REQUIRED. Without --trace_id the chat UI
cannot match your reply to this dispatch and will show "Working..." forever.
Without --thread your reply lands in the default thread instead of the one
the operator was working in. Always include both — the literal thread name
for this dispatch is "${threadId}".

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

			try {
				// PR 8: emit a linking observation BEFORE dispatch so the dispatched
				// worker can receive operator chat context as injected memory.
				emitDispatchLinkObservation(threadId, normalizedMessage, targetRepo, currentTier);

				const response = await fetchWithTimeout(
					`${serverConfig.gatewayUrl}/api/v1/dispatch`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							tool_profile: 'standard_worker',
							worker: worker === 'auto' ? undefined : worker,
							role: worker === 'auto' ? role : undefined,
							target_repo: targetRepo,
							ticket_id: ticket_id || null,
							prompt: workerPrompt,
							thinking_level: 'none',
							// Sonnet by default for chat dispatches — 3-5x faster
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
						`Agent dispatched: **${worker === 'auto' ? 'Role Routing' : worker}** is spinning up to handle this request on **${targetRepo}**. (Trace ID: ${data.trace_id || 'unknown'})`,
						data.trace_id || null,
						ticket_id || null,
						null,
						'sent',
						threadId
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
						`⚠️ **Dispatch failed.** ${worker === 'auto' ? 'Role-routed worker' : worker} could not be spawned on **${targetRepo}**. Reason: \`${reason}\`. Check the dispatch_listener logs (\`journalctl -u logueos-dispatch-listener\`) for details, then retry.`,
						null,
						ticket_id || null,
						null,
						'sent',
						threadId
					);
				}
			} catch (err) {
				console.error('Auto-dispatch error in chat:', err);
				const msg = err instanceof Error ? err.message : String(err);
				addChatMessage(
					'system',
					`⚠️ **Dispatch errored before reaching the listener.** Could not reach the gateway: \`${msg.slice(0, 200)}\`. Check the gateway is running (\`systemctl status logueos-mcp-gateway\`).`,
					null,
					ticket_id || null,
					null,
					'sent',
					threadId
				);
			}
		}
		// No else-branch: shouldTrigger is now false only when the operator
		// explicitly picked the Silent pill, in which case the chat message
		// is logged but no worker spawns. That's the entire intent — no
		// system "no dispatch" warning needed.

		return json({
			message: chatMsg,
			current_tier: currentTier,
			...(routerMeta
				? { provider_used: routerMeta.provider_used, model_used: routerMeta.model_used }
				: {})
		});
	} catch (e: unknown) {
		console.error('POST /api/chat error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
