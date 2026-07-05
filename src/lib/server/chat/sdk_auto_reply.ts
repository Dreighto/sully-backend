// Auto-mode orchestration: walk the tier provider chain and fall forward at
// runtime when a candidate fails before any reply text is emitted (mirrors
// llm_router.ts fall-forward semantics for sdk-stream).

import { generateId, type UIMessage, type UIMessageChunk } from 'ai';
import type { PreparedStreamContext } from '$lib/server/chat/stream_prepare';
import { getSensitiveTools } from '$lib/server/companion_tools';
import { baseTools } from '$lib/server/chat/base_tools';
import { streamViaClaudeCLI } from '$lib/server/claude_cli_stream';
import { persistAssistantTurn } from '$lib/server/chat_turn';
import { applyTurnDecision } from '$lib/server/chat/autonomous_dispatch';
import {
	beginActiveStream,
	emitRoutingFrame,
	finishWithReplyId,
	rollbackOrphanTurn,
	streamResponseFromBuffer,
	type SullyRoutingFrame
} from '$lib/server/chat/sdk_stream_common';
import {
	classifySullyError,
	emitSullyError,
	isAutoFallbackableError,
	runDirectStreamAttempt,
	type DirectStreamAttemptResult,
	type SullyErrorFrame
} from '$lib/server/chat/sdk_direct_reply';
import { listAutoModelCandidates, type AutoResolveResult } from '$lib/server/chat/auto_router';
import {
	providerFamilyFromApi,
	recordAutoProviderFailure,
	recordAutoProviderSuccess
} from '$lib/server/chat/auto_provider_cooldown';

function transcriptFrom(modelMessages: UIMessage[]): string {
	return modelMessages
		.map((m) => {
			const role = m.role === 'assistant' ? 'assistant' : 'user';
			const text = (m.parts || [])
				.filter((p) => p.type === 'text')
				.map((p) => (p as { type: 'text'; text: string }).text)
				.join('');
			return text ? `[${role}]: ${text}` : '';
		})
		.filter(Boolean)
		.join('\n\n');
}

async function runCliStreamAttempt(opts: {
	ctx: PreparedStreamContext;
	modelId: string;
	routing: SullyRoutingFrame;
	record: (chunk: UIMessageChunk) => void;
	turnAbort: AbortSignal;
	suppressErrorFrames?: boolean;
}): Promise<DirectStreamAttemptResult> {
	const { ctx, modelId, routing, record, turnAbort, suppressErrorFrames } = opts;
	let textEmitted = false;
	let errorFrame: SullyErrorFrame | undefined;

	const messageId = generateId();
	const textId = '0';
	record({ type: 'start', messageId });
	emitRoutingFrame({ write: (chunk) => record(chunk) }, routing);
	record({ type: 'start-step' });
	record({ type: 'text-start', id: textId });

	const transcript = transcriptFrom(ctx.modelMessages);
	let collected = '';
	let errored = false;

	for await (const chunk of streamViaClaudeCLI({
		model: modelId,
		systemPrompt: ctx.systemPrompt,
		userPrompt: transcript || 'hello',
		signal: turnAbort
	})) {
		if (chunk.type === 'text-delta') {
			textEmitted = true;
			collected += chunk.delta;
			record({ type: 'text-delta', id: textId, delta: chunk.delta });
		} else if (chunk.type === 'error') {
			errored = true;
			errorFrame = classifySullyError(chunk.message);
			if (!suppressErrorFrames) {
				emitSullyError({ write: (c) => record(c) }, errorFrame);
				record({ type: 'error', errorText: chunk.message });
			}
		}
	}

	record({ type: 'text-end', id: textId });
	record({ type: 'finish-step' });

	if (collected && !errored) {
		const replyId = persistAssistantTurn({
			text: collected,
			sender: 'cc',
			threadId: ctx.threadId,
			model: modelId,
			tier: ctx.currentTier,
			taskId: ctx.taskId,
			provider: 'anthropic',
			reused: ctx.reused
		});
		finishWithReplyId({ write: (c) => record(c) }, replyId, 'stop');
		void applyTurnDecision(ctx.shadowDecision, {
			taskId: ctx.taskId,
			threadId: ctx.threadId,
			targetRepo: ctx.targetRepo,
			userText: ctx.userText,
			reused: ctx.reused
		}).catch((e) => {
			console.error('[sdk-stream] autonomous-dispatch failed', e);
		});
		return { ok: true, textEmitted: true };
	}

	if (errored && !collected) {
		if (!suppressErrorFrames) {
			record({ type: 'finish', finishReason: 'error' });
		}
		return { ok: false, textEmitted, errorFrame };
	}

	errorFrame = classifySullyError('No reply was generated.', undefined);
	if (!suppressErrorFrames) {
		emitSullyError({ write: (c) => record(c) }, errorFrame);
		record({ type: 'finish', finishReason: 'error' });
	}
	return { ok: false, textEmitted, errorFrame };
}

function familyFromCandidate(candidate: AutoResolveResult) {
	return providerFamilyFromApi(candidate.route.provider) ?? 'local';
}

function routeForAttempt(candidate: AutoResolveResult, index: number): SullyRoutingFrame {
	return {
		...candidate.route,
		fell_forward: index > 0 || Boolean(candidate.route.fell_forward),
		reason: index > 0 ? 'auto_runtime_fallback' : candidate.route.reason,
		source: 'auto'
	};
}

function applyCandidateToCtx(ctx: PreparedStreamContext, candidate: AutoResolveResult): void {
	if (candidate.kind === 'cli') {
		(ctx as { provider: string }).provider = 'anthropic';
		(ctx as { resolvedModelId: string }).resolvedModelId = candidate.modelId;
		return;
	}
	(ctx as { provider: string }).provider = candidate.route.provider ?? 'google';
	(ctx as { resolvedModelId: string }).resolvedModelId = candidate.modelHandle.modelId;
}

export function handleAutoReply(ctx: PreparedStreamContext, _request: Request): Response {
	const candidates = listAutoModelCandidates(ctx);
	if (candidates.length === 0) {
		rollbackOrphanTurn(ctx.operatorRowId, ctx.taskId, ctx.reused);
		return new Response(
			JSON.stringify({ error: 'credential_unavailable', detail: 'No auto providers' }),
			{
				status: 503,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	}

	const tools = ctx.allowSensitive ? { ...baseTools, ...getSensitiveTools() } : baseTools;
	const turnAbort = new AbortController();
	const streamHandle = beginActiveStream(ctx.threadId, {
		onSupersede: () => turnAbort.abort('superseded')
	});

	void (async () => {
		try {
			for (let i = 0; i < candidates.length; i++) {
				const candidate = candidates[i];
				const route = routeForAttempt(candidate, i);
				const staging: UIMessageChunk[] = [];
				const record = (chunk: UIMessageChunk) => {
					staging.push(chunk);
				};
				const canRetry = i < candidates.length - 1;
				applyCandidateToCtx(ctx, candidate);

				let attempt: DirectStreamAttemptResult;
				if (candidate.kind === 'cli') {
					attempt = await runCliStreamAttempt({
						ctx,
						modelId: candidate.modelId,
						routing: route,
						record,
						turnAbort: turnAbort.signal,
						suppressErrorFrames: canRetry
					});
				} else {
					attempt = await runDirectStreamAttempt({
						ctx,
						modelHandle: candidate.modelHandle,
						tools,
						routing: route,
						record,
						turnAbort: turnAbort.signal,
						suppressErrorFrames: canRetry
					});
				}

				if (attempt.ok) {
					const family = familyFromCandidate(candidate);
					recordAutoProviderSuccess(family);
					for (const chunk of staging) streamHandle.record(chunk);
					return;
				}

				if (attempt.textEmitted) {
					for (const chunk of staging) streamHandle.record(chunk);
					rollbackOrphanTurn(ctx.operatorRowId, ctx.taskId, ctx.reused);
					return;
				}

				const code = attempt.errorFrame?.code;
				const family = familyFromCandidate(candidate);
				const hasMoreSameFamily = candidates
					.slice(i + 1)
					.some((c) => familyFromCandidate(c) === family);
				if (code && isAutoFallbackableError(code)) {
					const recordCooldown =
						!canRetry ||
						code === 'rate_limit' ||
						code === 'credential_unavailable' ||
						!hasMoreSameFamily;
					if (recordCooldown) {
						recordAutoProviderFailure(family, code, attempt.errorFrame?.message);
					}
				}

				if (canRetry && code && isAutoFallbackableError(code)) {
					console.error(
						`[auto] ${route.model} failed (${code}) — falling forward; ${family} cooling down`
					);
					continue;
				}

				for (const chunk of staging) streamHandle.record(chunk);
				if (attempt.errorFrame) {
					emitSullyError({ write: (c) => streamHandle.record(c) }, attempt.errorFrame);
				}
				if (!staging.some((c) => c.type === 'finish')) {
					streamHandle.record({ type: 'finish', finishReason: 'error' });
				}
				rollbackOrphanTurn(ctx.operatorRowId, ctx.taskId, ctx.reused);
				return;
			}
		} catch (e) {
			console.error('[sdk-stream] auto reply failed', e);
			rollbackOrphanTurn(ctx.operatorRowId, ctx.taskId, ctx.reused);
		} finally {
			streamHandle.end();
		}
	})();

	return streamResponseFromBuffer(ctx.threadId, 0);
}
