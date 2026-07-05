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

function preferLastWorkingCandidate(
	candidates: AutoResolveResult[],
	lastModelUsed: string | null | undefined
): AutoResolveResult[] {
	if (!lastModelUsed || candidates.length < 2) return candidates;
	const idx = candidates.findIndex((c) => {
		const modelId = c.kind === 'cli' ? c.modelId : c.modelHandle.modelId;
		return modelId === lastModelUsed || lastModelUsed.includes(modelId.split(':')[0] ?? '');
	});
	if (idx <= 0) return candidates;
	return [candidates[idx], ...candidates.slice(0, idx), ...candidates.slice(idx + 1)];
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

	const anthropicInList = candidates.some((c) => familyFromCandidate(c) === 'anthropic');
	if (!anthropicInList && ctx.threadState.last_model_used) {
		return preferLastWorkingCandidate(candidates, ctx.threadState.last_model_used);
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
