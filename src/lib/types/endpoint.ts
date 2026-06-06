/**
 * Shared Endpoint Shape — the canonical endpoint descriptor.
 *
 * Odysseus-adoption do-first #1 (see data/peer_reviews/2026-06-06_odysseus-adoption-roadmap.md).
 * This is the cross-repo contract: the kernel (LogueOS-Orchestrator) tracks MCP **tool**
 * endpoints; the Companion tracks LLM **model** endpoints. They are NOT one registry, but
 * they share THIS field vocabulary so a future operator UI + the Execution Capability Graph
 * can join across them without a translation layer.
 *
 * Canonical spec (authority): LogueOS-Orchestrator `.logueos/reference/endpoint_shape.md`.
 * Keep this type in sync with that spec.
 */

/** Where the endpoint lives relative to this host (Companion flavor of the kernel's `transport`). */
export type EndpointScope = 'local' | 'remote' | 'tailnet';

/** How the cached item list (models/tools) is refreshed. */
export type RefreshMode = 'manual' | 'on-demand' | 'interval';

/** Result of the last reachability probe. */
export type EndpointHealth = 'online' | 'offline' | 'degraded' | 'unknown';

/**
 * One endpoint, persisted as a row (Companion: `endpoints` table). The Companion flavor
 * describes an LLM model endpoint (Ollama / OpenAI / OpenRouter / vLLM / llama.cpp / …).
 * Field names match the kernel spec; where the two diverge the kernel name is noted.
 */
export interface ModelEndpoint {
	/** Stable id used everywhere in the UI + routing (never match by bare base_url). */
	endpointId: string;
	/** e.g. 'ollama' | 'openai' | 'openrouter' | 'vllm' | 'llamacpp'. */
	provider: string;
	/** Companion: local/remote/tailnet. (Kernel calls this `transport`: stdio/http/sse.) */
	scope: EndpointScope;
	/** Base URL, post normalization (Docker/Tailscale loopback rewrite applied). */
	baseUrl: string;
	/** Discovered items cached with the endpoint. Companion: model ids. (Kernel: tool ids.) */
	cachedItems: string[];
	/** Whether the endpoint's items support native function/tool calls. */
	supportsTools: boolean;
	/** Operator-pinned item ids (always-surfaced). */
	pinned: string[];
	/** Operator-hidden item ids (filtered from pickers). */
	hidden: string[];
	/** ISO timestamp of the last probe, or null if never probed. */
	lastProbeAt: string | null;
	/** Last probe error message, or null if healthy. */
	lastProbeError: string | null;
	/** Refresh policy for `cachedItems`. */
	refreshMode: RefreshMode;
	/** Companion: health. (Kernel: `visibility`.) */
	healthStatus: EndpointHealth;
}
