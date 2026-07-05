// Auto-mode model resolution for sdk-stream.
//
// When the client omits `provider` (picker = Auto), classify the turn tier
// (already done in stream_prepare) then try providers in cost/capability order:
//   anthropic (tier matrix) → google (tier matrix) → Ollama Cloud DeepSeek
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

const OLLAMA_FLASH = process.env.SULLY_AUTO_OLLAMA_FLASH || 'deepseek-v4-flash:671b-cloud';
const OLLAMA_PRO = process.env.SULLY_AUTO_OLLAMA_PRO || 'deepseek-v4-pro:671b-cloud';

function ollamaCloudModelForTier(tier: Tier): string {
	return tier === 'chat' ? OLLAMA_FLASH : OLLAMA_PRO;
}

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

/**
 * Resolve the model for an Auto-mode turn. Throws only when every lane is
 * exhausted (same as today's credential_unavailable 503).
 */
export function resolveAutoModel(ctx: PreparedStreamContext): AutoResolveResult {
	const tier = ctx.currentTier;
	let fellForward = false;

	// 1) Anthropic — tier-appropriate Haiku / Sonnet / Opus
	if (!isAnthropicCapExceeded()) {
		const modelId = resolveChatModel({ tier, provider: 'anthropic' });
		if (anthropicCredentialAvailable(modelId)) {
			if (/sonnet|opus/i.test(modelId)) {
				return {
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
				};
			}
			const modelHandle = pickModel('anthropic', tier);
			return {
				kind: 'direct',
				modelHandle,
				route: buildRoute({
					provider: 'anthropic',
					modelId: modelHandle.modelId,
					tier,
					reason: 'auto_tier_primary',
					fell_forward: fellForward
				})
			};
		}
	}
	fellForward = true;

	// 2) Google Gemini — same tier matrix
	if (googleCredentialAvailable()) {
		const modelHandle = pickModel('google', tier);
		return {
			kind: 'direct',
			modelHandle,
			route: buildRoute({
				provider: 'google',
				modelId: modelHandle.modelId,
				tier,
				reason: 'auto_tier_fallback',
				fell_forward: fellForward
			})
		};
	}
	fellForward = true;

	// 3) Ollama Cloud DeepSeek — flash for chat tier, pro for planning/deep/local
	const cloudModel = ollamaCloudModelForTier(tier);
	const modelHandle = pickModel('local', tier, cloudModel);
	return {
		kind: 'direct',
		modelHandle,
		route: buildRoute({
			provider: 'local',
			modelId: modelHandle.modelId,
			tier,
			reason: 'auto_ollama_cloud',
			fell_forward: fellForward
		})
	};
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
	const cloudModel = ollamaCloudModelForTier(tier);
	const modelHandle = pickModel('local', tier, cloudModel);
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
