// Auto-mode model resolution for sdk-stream.
//
// When the client omits `provider` (picker = Auto), classify the turn tier
// (already done in stream_prepare) then try providers in cost/capability order:
//   anthropic (tier matrix) → google (tier matrix) → Ollama Cloud (qwen3-coder, gpt-oss, …)
//
// Ollama Cloud uses the local daemon + OLLAMA_API_KEY / `ollama signin` — same
// path as the explicit DeepSeek picker entries (`*-cloud` tags). No direct
// DeepSeek API key.

import type { Tier } from '$lib/server/phase_classifier';
import type { PreparedStreamContext, Provider } from '$lib/server/chat/stream_prepare';
import { resolveChatModel } from '$lib/server/model_catalog';
import type { SullyRoutingFrame } from '$lib/server/chat/sdk_stream_common';
import {
	isAnthropicCapExceeded,
	pickFallbackModel,
	pickModel
} from '$lib/server/chat/sdk_direct_reply';
import {
	isAutoProviderCooling,
	providerFamilyFromApi,
	syncAnthropicCapCooldown,
	type AutoProviderFamily
} from '$lib/server/chat/auto_provider_cooldown';
import { listOllamaCloudAutoModels } from '$lib/server/chat/ollama_cloud_chain';

// Escalation ordering for the sticky-thread rule. 'local' ranks with 'chat' —
// it is a cost tier, not a capability request.
const TIER_RANK: Record<Tier, number> = { local: 0, chat: 0, planning: 1, deep: 2 };

function anthropicCredentialAvailable(modelId: string): boolean {
	try {
		pickModel('anthropic', 'chat', modelId);
		return true;
	} catch {
		return false;
	}
}

function googleCredentialAvailable(): boolean {
	try {
		pickModel('google', 'chat');
		return true;
	} catch {
		return false;
	}
}

function buildRoute(args: {
	provider: Provider;
	modelId: string;
	tier: Tier;
	reason: string;
	fell_forward: boolean;
	handled_by?: 'sdk' | 'cli';
}): SullyRoutingFrame {
	const handled_by =
		args.handled_by ??
		(args.provider === 'anthropic' && /sonnet|opus/i.test(args.modelId) ? 'cli' : 'sdk');
	return {
		handled_by,
		model: args.modelId,
		provider: args.provider,
		tier: args.tier,
		reason: args.reason,
		fell_forward: args.fell_forward,
		source: 'auto'
	};
}

export type AutoResolveResult =
	| {
			kind: 'cli';
			modelId: string;
			route: SullyRoutingFrame;
	  }
	| {
			kind: 'direct';
			modelHandle: ReturnType<typeof pickModel>;
			route: SullyRoutingFrame;
	  };

function familyFromCandidate(candidate: AutoResolveResult): AutoProviderFamily {
	return providerFamilyFromApi(candidate.route.provider) ?? 'local';
}

function candidateModelId(c: AutoResolveResult): string {
	return c.kind === 'cli' ? c.modelId : c.modelHandle.modelId;
}

/** Exact-or-exact-root match — substring matching cross-matched size variants
 *  (gpt-oss:20b vs :120b would both split to 'gpt-oss'; in-house review). */
function modelMatches(modelId: string, lastModelUsed: string): boolean {
	if (modelId === lastModelUsed) return true;
	const a = modelId.split(':')[0];
	const b = lastModelUsed.split(':')[0];
	return a === b && modelId.split(':')[1] === lastModelUsed.split(':')[1];
}

function preferLastWorkingCandidate(
	candidates: AutoResolveResult[],
	lastModelUsed: string | null | undefined
): AutoResolveResult[] {
	if (!lastModelUsed || candidates.length < 2) return candidates;
	const idx = candidates.findIndex((c) => modelMatches(candidateModelId(c), lastModelUsed));
	if (idx <= 0) return candidates;
	return [candidates[idx], ...candidates.slice(0, idx), ...candidates.slice(idx + 1)];
}

/**
 * Construct a candidate for the thread's sticky model when the tier-ranked
 * list doesn't contain it (post-escalation gap: a thread that escalated to
 * Sonnet would otherwise silently revert to the chat-tier head on its next
 * plain turn — the exact ping-pong determinism forbids). Fails closed to
 * null; the caller falls back to normal ranking.
 */
function stickyCandidateFor(lastModelUsed: string, tier: Tier): AutoResolveResult | null {
	try {
		if (/sonnet|opus/i.test(lastModelUsed)) {
			if (isAnthropicCapExceeded() || isAutoProviderCooling('anthropic')) return null;
			return {
				kind: 'cli',
				modelId: lastModelUsed,
				route: buildRoute({
					provider: 'anthropic',
					modelId: lastModelUsed,
					tier,
					reason: 'auto_thread_sticky',
					fell_forward: false,
					handled_by: 'cli'
				})
			};
		}
		if (/^claude-/i.test(lastModelUsed)) {
			if (isAnthropicCapExceeded() || isAutoProviderCooling('anthropic')) return null;
			const modelHandle = pickModel('anthropic', tier, lastModelUsed);
			return {
				kind: 'direct',
				modelHandle,
				route: buildRoute({
					provider: 'anthropic',
					modelId: modelHandle.modelId,
					tier,
					reason: 'auto_thread_sticky',
					fell_forward: false
				})
			};
		}
		if (/^gemini-/i.test(lastModelUsed)) {
			if (isAutoProviderCooling('google')) return null;
			const modelHandle = pickModel('google', tier, lastModelUsed);
			return {
				kind: 'direct',
				modelHandle,
				route: buildRoute({
					provider: 'google',
					modelId: modelHandle.modelId,
					tier,
					reason: 'auto_thread_sticky',
					fell_forward: false
				})
			};
		}
		if (/-cloud$/.test(lastModelUsed)) {
			if (isAutoProviderCooling('local')) return null;
			const modelHandle = pickModel('local', tier, lastModelUsed);
			return {
				kind: 'direct',
				modelHandle,
				route: buildRoute({
					provider: 'local',
					modelId: modelHandle.modelId,
					tier,
					reason: 'auto_thread_sticky',
					fell_forward: false
				})
			};
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Ordered Auto-mode candidates. Runtime fallforward (sdk_auto_reply) walks this
 * list when a provider fails before any reply text is emitted — same tier,
 * next-cheapest provider, mirroring llm_router.ts. Providers in cooldown are
 * omitted so Auto stays on fallbacks until the lane cools down.
 */
export function listAutoModelCandidates(ctx: PreparedStreamContext): AutoResolveResult[] {
	syncAnthropicCapCooldown();
	const tier = ctx.currentTier;
	const candidates: AutoResolveResult[] = [];
	let fellForward = false;

	// 1) Anthropic — tier-appropriate Haiku / Sonnet / Opus
	if (!isAnthropicCapExceeded() && !isAutoProviderCooling('anthropic')) {
		const modelId = resolveChatModel({ tier, provider: 'anthropic' });
		if (anthropicCredentialAvailable(modelId)) {
			if (/sonnet|opus/i.test(modelId)) {
				candidates.push({
					kind: 'cli',
					modelId,
					route: buildRoute({
						provider: 'anthropic',
						modelId,
						tier,
						reason: 'auto_tier_primary',
						fell_forward: fellForward,
						handled_by: 'cli'
					})
				});
			} else {
				const modelHandle = pickModel('anthropic', tier);
				candidates.push({
					kind: 'direct',
					modelHandle,
					route: buildRoute({
						provider: 'anthropic',
						modelId: modelHandle.modelId,
						tier,
						reason: 'auto_tier_primary',
						fell_forward: fellForward
					})
				});
			}
		}
	}
	fellForward = true;

	// 2) Google Gemini — same tier matrix
	if (googleCredentialAvailable() && !isAutoProviderCooling('google')) {
		const modelHandle = pickModel('google', tier);
		candidates.push({
			kind: 'direct',
			modelHandle,
			route: buildRoute({
				provider: 'google',
				modelId: modelHandle.modelId,
				tier,
				reason: 'auto_tier_fallback',
				fell_forward: fellForward
			})
		});
	}

	// 3) Ollama Cloud — try each registered *-cloud model on this host
	if (!isAutoProviderCooling('local')) {
		for (const cloudModel of listOllamaCloudAutoModels(tier)) {
			const cloudHandle = pickModel('local', tier, cloudModel);
			candidates.push({
				kind: 'direct',
				modelHandle: cloudHandle,
				route: buildRoute({
					provider: 'local',
					modelId: cloudHandle.modelId,
					tier,
					reason: 'auto_ollama_cloud',
					fell_forward: true
				})
			});
		}
	}

	// Deterministic Auto (operator directive 2026-07-07): within a thread, Auto
	// sticks with the model that last answered it. Provider ranking decides only
	// (a) the first turn of a thread, (b) a genuine tier ESCALATION — the
	// operator asked for more than the thread has needed so far — or (c) when
	// the sticky model's provider is cooling (it won't be in candidates, so the
	// ranked head takes over). Tier DE-escalation does not unstick: a thread
	// stays on its model rather than ping-ponging provider-to-provider between
	// turns, which is what made Auto feel random (haiku → deepseek mid-thread,
	// 2026-07-07). ctx.threadState is the PRE-turn snapshot, so current_tier
	// here is the previous turn's tier.
	const escalated = TIER_RANK[tier] > TIER_RANK[ctx.threadState.current_tier ?? 'chat'];
	if (!escalated && ctx.threadState.last_model_used) {
		const last = ctx.threadState.last_model_used;
		const inList = candidates.some((c) => modelMatches(candidateModelId(c), last));
		if (!inList) {
			// Post-escalation: the sticky model may not be a candidate at this
			// tier (Sonnet on a chat turn). Construct it explicitly so the
			// thread genuinely stays on its model.
			const sticky = stickyCandidateFor(last, tier);
			if (sticky) return [sticky, ...candidates];
		}
		return preferLastWorkingCandidate(candidates, last);
	}
	return candidates;
}

export function resolveAutoModel(ctx: PreparedStreamContext): AutoResolveResult {
	const candidates = listAutoModelCandidates(ctx);
	if (candidates.length === 0) {
		throw new Error('Auto mode: no providers available (check keys and daily caps).');
	}
	return candidates[0];
}

/** Last-resort when explicit anthropic pick fails mid-route. */
export function resolveAutoFallback(tier: Tier): {
	modelHandle: ReturnType<typeof pickModel>;
	route: SullyRoutingFrame;
} {
	const fb = pickFallbackModel();
	if (fb) {
		return {
			modelHandle: fb,
			route: buildRoute({
				provider: 'local',
				modelId: fb.modelId,
				tier,
				reason: 'auto_chain_fallback',
				fell_forward: true
			})
		};
	}
	const cloudModels = listOllamaCloudAutoModels(tier);
	const modelHandle = pickModel('local', tier, cloudModels[0]);
	return {
		modelHandle,
		route: buildRoute({
			provider: 'local',
			modelId: modelHandle.modelId,
			tier,
			reason: 'auto_ollama_cloud',
			fell_forward: true
		})
	};
}

export function routingFrameForExplicitPick(args: {
	ctx: PreparedStreamContext;
	modelId: string;
	fell_forward?: boolean;
	fallbackReason?: string;
}): SullyRoutingFrame {
	return {
		handled_by:
			args.ctx.provider === 'anthropic' && /sonnet|opus/i.test(args.modelId) ? 'cli' : 'sdk',
		model: args.modelId,
		provider: args.ctx.provider,
		tier: args.ctx.currentTier,
		reason: args.fallbackReason ? 'explicit_fallback' : 'explicit_pick',
		fell_forward: args.fell_forward ?? false,
		source: 'picker'
	};
}
