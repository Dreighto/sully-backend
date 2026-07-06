import { type Tier } from '$lib/server/phase_classifier';
import { type ThreadState } from '$lib/server/thread_state';
import { runMode, serverConfig } from '$lib/server/config';
import { resolveChatModel } from '$lib/server/model_catalog';
import { providerPrefToApi } from '$lib/chat/model-registry';

export type Provider = 'anthropic' | 'google' | 'local';

export interface ResolvedProviderAndModel {
	/** True when the client omitted `provider` (picker = Auto). */
	autoMode: boolean;
	provider: Provider;
	resolvedModelId: string;
	useClaudeCLI: boolean;
}

/**
 * Provider preference:
 *   1. Explicit body.provider (client just chose a model)
 *   2. thread_state.provider_override (persisted via model picker)
 *   3. Default 'google' (matches legacy AGY-chat-lock UX). Operator can
 *      flip to Anthropic via picker; Anthropic-via-OAuth is free.
 * Tier 'local' implicitly selects the local provider unless the operator
 * has explicitly overridden. Lets the existing "Local (Ollama)" model
 * picker option route through Ollama without per-thread setup.
 * Companion mode defaults to the LOCAL provider (companion-v1) instead of
 * cloud Google — while keeping cloud models selectable via the picker.
 * COMPANION_LOCAL_DISABLED env flag (operator-controlled) suppresses the
 * implicit local default so Auto never loads a GPU model. Used when the
 * GPU is busy with QLoRA training or other workloads. The picker's
 * explicit "Local (Ollama)" option still works because that path sets
 * args.provider='local' which takes priority over this default.
 *
 * Resolve the model id up-front so we can decide between the direct API
 * route and the Claude CLI bridge. Anthropic's Claude Max OAuth only
 * grants direct API access to Haiku — Sonnet/Opus return 429 with a
 * mislabel'd "rate_limit_error". The CLI binary is the authorized client
 * that CAN reach Sonnet/Opus through OAuth. Operator directive 2026-05-27:
 * "use the CLI bridge, do NOT prompt for a billed API key — defeats the
 * purpose of paying for Max." So Sonnet/Opus ALWAYS route through CLI
 * regardless of any API-key env presence.
 * Resolve via the shared catalog — precedence: body.model → companion-mode
 * local default (companion-v1) → tier × provider matrix. Used here UP-FRONT
 * to decide between the direct API path and the CLI bridge.
 */
export function resolveProviderAndModel(opts: {
	argsProvider: Provider | undefined;
	requestedModel: string | undefined;
	currentTier: Tier;
	threadState: ThreadState;
}): ResolvedProviderAndModel {
	const { argsProvider, requestedModel, currentTier, threadState } = opts;

	const overrideFromState: Provider | undefined = providerPrefToApi(threadState.provider_override);
	const tierImpliesLocal: Provider | null = currentTier === 'local' ? 'local' : null;
	const companionDefault: Provider | null =
		runMode.companion && !serverConfig.companionLocalDisabled ? 'local' : null;
	const autoMode = argsProvider === undefined || argsProvider === null;
	// Auto mode resolves provider/model dynamically in auto_router.ts (tier →
	// anthropic → google → Ollama Cloud DeepSeek). The placeholder here is only
	// used for system-prompt assembly and CLI-bridge hints until +server.ts
	// overwrites it with the resolved lane.
	const provider: Provider = autoMode
		? 'anthropic'
		: (argsProvider ?? overrideFromState ?? tierImpliesLocal ?? companionDefault ?? 'google');

	const resolvedModelId = resolveChatModel({
		tier: currentTier,
		provider,
		requestedModel
	});
	const useClaudeCLI = provider === 'anthropic' && /sonnet|opus/i.test(resolvedModelId);

	return { autoMode, provider, resolvedModelId, useClaudeCLI };
}
