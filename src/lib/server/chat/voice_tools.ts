// Voice tool-calling loop. The voice path talks to Ollama /api/chat directly
// (low-latency local model for TTS), so it can't use the Vercel-AI-SDK tool
// framework the text path uses. This module gives the voice model the operator's
// Ollama-Pro web tools (web_search / web_fetch) via Ollama's native tool-calling
// protocol: pass tool schemas, and if the model emits tool_calls, execute them,
// feed the results back, and loop until it produces a spoken answer.
//
// Scope (operator ask 2026-06-03): web_search + web_fetch, backed by the Ollama
// Pro key. read_file/deep_think/etc. (the text-path sensitive tools) can be
// added later in the same loop; kept tight for now.

import { searchOllama, fetchOllama, OLLAMA_API_KEY, UNTRUSTED_NOTE } from './web_search';
import { logTaskEvent } from '../chatActivity';
import { VOICE_OLLAMA_URL } from '../voice_runtime';
import { composeTimeout } from './voice_seam_timeout';

// Voice inference runs on the Jetson Ollama, never the ROOM 5060 (see voice_runtime).
const OLLAMA = VOICE_OLLAMA_URL;

// WI-8 (voice seam timeouts): the non-streaming tool-loop /api/chat call passed
// only the client barge-in signal — a wedged Jetson hung the voice turn forever.
// Bound each round with a deadline composed onto the client signal (shared
// helper). Env-overridable for the field.
const VOICE_TOOL_TIMEOUT_MS = Number(process.env.VOICE_TOOL_TIMEOUT_MS) || 30000;

// Ollama tool schemas (OpenAI-function shape — what /api/chat expects).
export const VOICE_TOOL_SCHEMAS = [
	{
		type: 'function',
		function: {
			name: 'web_search',
			description:
				'Search the web for current, factual, or recent information when the answer might be newer than your knowledge. Returns a list of results (title, url, snippet).',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'The search query' },
					limit: { type: 'integer', description: 'How many results (default 5)' }
				},
				required: ['query']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'web_fetch',
			description:
				'Fetch the full clean text of a single web page. Use after web_search when you need more than the snippet.',
			parameters: {
				type: 'object',
				properties: { url: { type: 'string', description: 'The page URL' } },
				required: ['url']
			}
		}
	}
] as const;

type OllamaMessage = { role: string; content: string; tool_calls?: ToolCall[] };
type ToolCall = { function: { name: string; arguments: Record<string, unknown> } };

const TOOL_NAMES = new Set(['web_search', 'web_fetch']);

/**
 * Fallback parser for models (like companion-v1-voice) that emit tool calls as
 * inline TEXT instead of Ollama's structured `message.tool_calls`. Scans the
 * content for a JSON object shaped like {"name":"web_search","arguments":{…}}
 * and lifts it into a ToolCall. Returns the calls found + the content with the
 * JSON stripped (so we never speak raw tool JSON if a call is detected).
 */
function parseInlineToolCalls(content: string): { calls: ToolCall[]; stripped: string } {
	const calls: ToolCall[] = [];
	let stripped = content;
	// Match balanced-ish JSON objects that contain a "name" key. Greedy enough
	// for the single-object case these models emit; we validate by JSON.parse.
	const re = /\{[^{}]*"name"\s*:\s*"(\w+)"[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/g;
	for (const m of content.matchAll(re)) {
		try {
			const obj = JSON.parse(m[0]) as { name?: string; arguments?: Record<string, unknown> };
			if (obj.name && TOOL_NAMES.has(obj.name)) {
				calls.push({ function: { name: obj.name, arguments: obj.arguments ?? {} } });
				stripped = stripped.replace(m[0], '').trim();
			}
		} catch {
			/* not valid JSON — skip */
		}
	}
	return { calls, stripped };
}

async function execTool(name: string, args: Record<string, unknown>): Promise<string> {
	try {
		if (name === 'web_search') {
			const query = String(args.query ?? '').trim();
			const limit = Math.min(Math.max(Number(args.limit ?? 5) || 5, 1), 10);
			if (!query) return JSON.stringify({ error: 'empty query' });
			const r = await searchOllama(query, limit);
			return 'results' in r
				? JSON.stringify({ note: UNTRUSTED_NOTE, results: r.results })
				: JSON.stringify({ error: r.error });
		}
		if (name === 'web_fetch') {
			const url = String(args.url ?? '').trim();
			if (!url) return JSON.stringify({ error: 'empty url' });
			const r = await fetchOllama(url);
			return 'content' in r
				? JSON.stringify({ note: UNTRUSTED_NOTE, content: r.content })
				: JSON.stringify({ error: r.error });
		}
		return JSON.stringify({ error: `unknown tool ${name}` });
	} catch (e) {
		return JSON.stringify({ error: (e as Error).message });
	}
}

export interface ToolLoopResult {
	/** The model's final spoken answer (no more tool calls). */
	content: string;
	/** Names of tools the model invoked across the loop (for the journal). */
	toolsUsed: string[];
}

/**
 * Run the Ollama tool-calling loop to a final answer. NON-streaming per step
 * (we must inspect tool_calls cleanly); the caller streams `content` out to
 * the client/TTS afterward. Capped at maxSteps tool rounds so a confused model
 * can't loop forever. If OLLAMA_API_KEY is absent or no tool is ever called,
 * this still returns the model's plain answer in one round.
 */
export async function runVoiceToolLoop(args: {
	model: string;
	messages: OllamaMessage[];
	keepAlive: string | number;
	numCtx: number;
	signal?: AbortSignal;
	taskId?: string;
	maxSteps?: number;
	/**
	 * Fired the first time the loop is about to execute a tool, BEFORE the
	 * (slow) tool + follow-up inference run. The voice route uses this to speak
	 * a "let me look that up" filler so the operator isn't sitting in silence
	 * during the round-trip. `toolName` is the first tool being called.
	 */
	onToolStart?: (toolName: string) => void;
}): Promise<ToolLoopResult> {
	const messages = [...args.messages];
	const toolsUsed: string[] = [];
	const maxSteps = args.maxSteps ?? 3;
	const toolsEnabled = !!OLLAMA_API_KEY;
	let firedToolStart = false;

	for (let step = 0; step <= maxSteps; step++) {
		const body: Record<string, unknown> = {
			model: args.model,
			messages,
			stream: false,
			keep_alive: args.keepAlive,
			options: { num_ctx: args.numCtx }
		};
		// Offer tools only while we still have step budget; on the final allowed
		// step, omit them so the model is forced to answer rather than call again.
		if (toolsEnabled && step < maxSteps) body.tools = VOICE_TOOL_SCHEMAS;

		const resp = await fetch(`${OLLAMA}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: composeTimeout(args.signal, VOICE_TOOL_TIMEOUT_MS)
		});
		if (!resp.ok) throw new Error(`ollama /api/chat HTTP ${resp.status}`);
		const data = (await resp.json()) as { message?: OllamaMessage };
		const msg = data.message;
		if (!msg) return { content: '', toolsUsed };

		// Prefer Ollama's structured tool_calls; fall back to parsing inline JSON
		// for models (companion-v1-voice) that emit calls as text content.
		let calls = msg.tool_calls ?? [];
		let assistantContent = msg.content || '';
		if (calls.length === 0 && toolsEnabled && step < maxSteps) {
			const inline = parseInlineToolCalls(assistantContent);
			if (inline.calls.length > 0) {
				calls = inline.calls;
				assistantContent = inline.stripped;
			}
		}
		if (calls.length === 0) {
			return { content: assistantContent.trim(), toolsUsed };
		}

		// Speak the "let me look that up" filler before the first tool runs —
		// covers the multi-second search + follow-up-inference round-trip.
		if (!firedToolStart) {
			firedToolStart = true;
			try {
				args.onToolStart?.(calls[0]?.function?.name ?? 'tool');
			} catch {
				/* filler is best-effort */
			}
		}

		// Execute each requested tool, append the assistant tool-call turn + the
		// tool results, then loop so the model can use them.
		messages.push({ role: 'assistant', content: assistantContent, tool_calls: calls });
		for (const call of calls) {
			const name = call.function?.name ?? 'unknown';
			toolsUsed.push(name);
			if (args.taskId) logTaskEvent(args.taskId, 'tool_invoked', { tool: name, surface: 'voice' });
			const result = await execTool(name, call.function?.arguments ?? {});
			if (args.taskId)
				logTaskEvent(args.taskId, 'tool_result', { tool: name, bytes: result.length });
			messages.push({ role: 'tool', content: result });
		}
	}

	// Exhausted the step budget without a clean answer — return whatever the
	// last turn had (best-effort; rare).
	const last = messages[messages.length - 1];
	return { content: (last?.content || '').trim(), toolsUsed };
}
