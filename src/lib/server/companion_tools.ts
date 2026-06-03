// Companion "powers" — the sensitive, tailnet-only tools the local model can
// call: read a file / list a directory on this machine, search / fetch the
// web, and consult a heavier model. These are DELIBERATELY gated and guarded
// because the companion chat is reachable over a public Tailscale Funnel URL
// and an LLM with file-read + web access is the textbook "lethal trifecta"
// (private data + untrusted content + an exfiltration channel). The defenses
// here cut two legs of that trifecta:
//
//   1. PRIVATE-DATA leg — read_file/list_directory are root-confined to the
//      operator's home, resolve symlinks before checking (the EscapeRoute CVE
//      class), and hard-deny a secret list (.env, ~/.ssh, ~/.claude, kernel
//      secrets + audit logs, card_catalog.db, *.pem/*.key, oauth creds).
//      Read-only, size-capped, binary-rejected. See chat/fs_guard.ts.
//   2. EXFILTRATION leg — the web tools only ever call two fixed trusted
//      backends (Perplexity, Firecrawl); the model cannot make an arbitrary
//      outbound request, and tool args are scanned for secret-shaped strings
//      so a poisoned page can't trick the model into shipping a key out. See
//      chat/web_search.ts + chat/secret_scan.ts.
//
// The THIRD gate (who can even reach these) lives in the route: these tools are
// only attached when the request did NOT arrive via the public Funnel — see
// sdk-stream/+server.ts. Every tool result is also labelled untrusted so the
// model treats fetched/read content as data, not instructions.
//
// This file is a THIN ASSEMBLER: the `tool({...})` definitions + the
// getSensitiveTools() export. All policy/client/adapter logic lives in the
// chat/ modules imported below.

import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
	resolveSafe,
	denyReason,
	MAX_FILE_BYTES,
	MAX_DIR_ENTRIES,
	FS_READ_ROOT
} from './chat/fs_guard';
import { carriesSecret } from './chat/secret_scan';
import {
	PERPLEXITY_KEY,
	FIRECRAWL_KEY,
	WEB_TIMEOUT_MS,
	MAX_WEB_CHARS,
	UNTRUSTED_NOTE,
	searchOllama,
	fetchOllama,
	searchPerplexity,
	searchFirecrawl,
	shouldFallForward,
	wouldExceedBudget,
	getTodayWebSpendCents,
	dailyBudgetCents,
	OLLAMA_API_KEY,
	type WebSearchOk,
	type WebSearchFail
} from './chat/web_search';
import { runDeepThink, runConsultClaude } from './chat/consult';

// Re-exported so existing importers of the fs-policy surface keep resolving.
export { resolveSafe, denyReason };

/**
 * The sensitive, tailnet-only tool set. Returned fresh per request so the route
 * can choose to include it (tailnet) or not (public Funnel).
 */
export function getSensitiveTools() {
	return {
		read_file: tool({
			description:
				"Read a UTF-8 text file from the operator's machine (read-only). Use to inspect code, configs, notes, or docs the operator points you at. Give an absolute path or a ~/path. Secrets (.env, SSH/OAuth keys, ~/.claude, credentials, the card database, kernel audit logs) are blocked, and binaries and files over 256KB are refused.",
			inputSchema: z.object({
				path: z.string().describe('Absolute path (or ~/relative) to the text file to read')
			}),
			execute: async ({ path: p }: { path: string }) => {
				const r = resolveSafe(p);
				if (!r.ok) return { error: r.error, requested: p };
				try {
					const stat = await fs.stat(r.real);
					if (stat.isDirectory())
						return { error: 'that is a directory — use list_directory', path: r.real };
					const buf = await fs.readFile(r.real);
					const slice = buf.subarray(0, MAX_FILE_BYTES);
					if (slice.includes(0))
						return { error: 'binary file — not readable as text', path: r.real };
					return {
						path: r.real,
						bytes: stat.size,
						truncated: stat.size > MAX_FILE_BYTES,
						note: UNTRUSTED_NOTE,
						content: slice.toString('utf-8')
					};
				} catch (e) {
					return { error: (e as Error).message, path: r.real };
				}
			}
		}),

		list_directory: tool({
			description:
				"List the files and subfolders in a directory on the operator's machine (read-only). Give an absolute path or a ~/path. Protected/secret entries are hidden.",
			inputSchema: z.object({
				path: z.string().describe('Absolute path (or ~/relative) to the directory to list')
			}),
			execute: async ({ path: p }: { path: string }) => {
				const r = resolveSafe(p);
				if (!r.ok) return { error: r.error, requested: p };
				try {
					const stat = await fs.stat(r.real);
					if (!stat.isDirectory()) return { error: 'that is a file — use read_file', path: r.real };
					const ents = await fs.readdir(r.real, { withFileTypes: true });
					const entries = ents
						.filter((e) => !denyReason(path.join(r.real, e.name)))
						.slice(0, MAX_DIR_ENTRIES)
						.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
					return {
						path: r.real,
						count: entries.length,
						hidden: ents.length - entries.length,
						entries
					};
				} catch (e) {
					return { error: (e as Error).message, path: r.real };
				}
			}
		}),

		web_search: tool({
			description:
				'Search the web for current, factual, or recent information. Use whenever the answer might be newer than your knowledge or you are unsure. Returns a list of results (title, url, snippet) and, when Perplexity is the active backend, a one-paragraph cited answer; call web_fetch on a result url to read its full page.',
			inputSchema: z.object({
				query: z.string().describe('The search query or question'),
				limit: z.number().int().min(1).max(10).default(5).describe('How many results (default 5)')
			}),
			execute: async ({ query, limit }: { query: string; limit?: number }) => {
				if (carriesSecret(query))
					return { error: 'refused: the query contains a secret-like string' };
				if (!OLLAMA_API_KEY && !PERPLEXITY_KEY && !FIRECRAWL_KEY) {
					return { error: 'web search is not configured on this server' };
				}
				const cap = Math.min(Math.max(limit ?? 5, 1), 10);

				// Provider chain (operator has Ollama Pro — flat-rate, primary):
				//   1. Ollama Pro hosted web_search  (no per-query budget)
				//   2. Perplexity                     (cited answers; daily-budget gated)
				//   3. Firecrawl                      (cheap raw fallback)
				// Same fall-forward shape as llm_router: try next on 401/429/5xx.
				const failures: string[] = [];

				if (OLLAMA_API_KEY) {
					const r = await searchOllama(query, cap);
					if ('results' in r) return { query, note: UNTRUSTED_NOTE, ...r };
					failures.push(`ollama: ${r.error}`);
				}

				const overBudget = PERPLEXITY_KEY && wouldExceedBudget();
				if (PERPLEXITY_KEY && !overBudget) {
					const r = await searchPerplexity(query, cap);
					if ('results' in r) return { query, note: UNTRUSTED_NOTE, ...r };
					failures.push(`perplexity: ${r.error}`);
				} else if (overBudget) {
					failures.push(
						`perplexity: daily web budget hit (${getTodayWebSpendCents().toFixed(2)}¢ of ${dailyBudgetCents().toFixed(0)}¢)`
					);
				}

				if (FIRECRAWL_KEY) {
					const r = await searchFirecrawl(query, cap);
					if ('results' in r) {
						return { query, note: UNTRUSTED_NOTE, ...r, priorFailures: failures };
					}
					failures.push(`firecrawl: ${r.error}`);
				}

				return { error: `web search failed (${failures.join('; ')})`, query };
			}
		}),

		web_fetch: tool({
			description:
				'Fetch the main text content of a single web page as clean markdown. Use after web_search when you need the full text of a specific result URL.',
			inputSchema: z.object({
				url: z.string().url().describe('The page URL to fetch')
			}),
			execute: async ({ url }: { url: string }) => {
				if (!OLLAMA_API_KEY && !FIRECRAWL_KEY)
					return { error: 'web fetch is not configured on this server' };
				if (carriesSecret(url)) return { error: 'refused: the URL contains a secret-like string' };

				// Ollama Pro web_fetch first (flat-rate); Firecrawl scrape fallback.
				if (OLLAMA_API_KEY) {
					const r = await fetchOllama(url);
					if ('content' in r) return { url, note: UNTRUSTED_NOTE, content: r.content };
					// fall through to Firecrawl on any Ollama failure
				}
				if (!FIRECRAWL_KEY) return { error: 'web fetch failed (ollama only, and it errored)', url };
				try {
					const resp = await fetch('https://api.firecrawl.dev/v2/scrape', {
						method: 'POST',
						headers: {
							Authorization: `Bearer ${FIRECRAWL_KEY}`,
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
						signal: AbortSignal.timeout(WEB_TIMEOUT_MS)
					});
					if (!resp.ok) return { error: `fetch failed (HTTP ${resp.status})`, url };
					const data = await resp.json();
					const md = data?.data?.markdown ?? data?.markdown ?? '';
					return { url, note: UNTRUSTED_NOTE, content: String(md).slice(0, MAX_WEB_CHARS) };
				} catch (e) {
					return { error: (e as Error).message, url };
				}
			}
		}),

		// ── Consultation tools — Sully calls a bigger brain behind the scenes ──
		// The operator's vision (2026-05-30): Sully as the front-of-house host,
		// quietly consulting heavier models when a question outgrows her own
		// reasoning. deep_think is the free everyday brain (Ollama Cloud);
		// consult_claude is the frontier-class escalation for the truly hard.
		// Outputs are CONSULT_NOTE-labelled so Sully treats them as advice, not
		// orders — defense against a poisoned page surfacing through web_search.
		// Implementations live in chat/consult.ts.

		deep_think: tool({
			description:
				'Quietly consult a much more capable model (default gpt-oss:120b on Ollama Cloud, free) when a question needs depth beyond your built-in knowledge or reasoning. Use for: hard analysis, unfamiliar domains, multi-step reasoning, "how does X really work" questions. Pass the full question + any context they need (they have NO memory of this conversation). Returns their answer — weave it into your reply naturally; you decide what to share.',
			inputSchema: z.object({
				question: z
					.string()
					.min(1)
					.describe('Full self-contained question + any context the consultant needs.')
			}),
			execute: async ({ question }: { question: string }) => {
				if (carriesSecret(question))
					return { error: 'refused: the question contains a secret-like string' };
				return runDeepThink(question);
			}
		}),

		consult_claude: tool({
			description:
				"Consult Claude (Anthropic's frontier model) for the absolute best answer on something genuinely hard. Most expensive of your help tools — use only for questions where deep_think isn't enough: nuanced reasoning, edge-case analysis, writing-quality matters. Pass the full question + any context they need (they have NO memory of this conversation). Returns Claude's answer — integrate it naturally; you decide what to share.",
			inputSchema: z.object({
				question: z
					.string()
					.min(1)
					.describe('Full self-contained question + any context Claude needs.'),
				model: z
					.enum(['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'])
					.optional()
					.describe('Tier override (default opus). Use sonnet/haiku for cheaper questions.')
			}),
			execute: async ({ question, model }: { question: string; model?: string }) => {
				if (carriesSecret(question))
					return { error: 'refused: the question contains a secret-like string' };
				return runConsultClaude(question, model);
			}
		})
	};
}

/** For diagnostics / tests: the active read root. */
export { FS_READ_ROOT };
