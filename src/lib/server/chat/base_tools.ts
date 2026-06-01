// LogueOS-on-SDK tools — read-only operator-context fetches the LLM can call
// when answering. PR 10a shipped the first tool; PR 10c added two more
// high-value reads. Future PRs (10d+) layer write-tools with operator-approval
// gates (linear_create_issue, service_restart) and the full MCP-gateway
// pass-through. See task #10.
//
// `baseTools` are always safe to expose (the operator's own chat context +
// service status). The SENSITIVE tools (read_file/list_directory/web_search/
// web_fetch, in companion_tools.ts) are attached PER REQUEST and ONLY when the
// request did not arrive over the public Tailscale Funnel — see the POST
// handler in sdk-stream/+server.ts. This keeps machine-read + web powers to the
// operator's own devices.

import { tool } from 'ai';
import { z } from 'zod';
import { getChatMessages, listChatThreads } from '$lib/server/chat';

export const baseTools = {
	list_chat_threads: tool({
		description:
			"Lists the operator's chat threads with message counts and latest activity. Use when the operator asks about their threads, history, or what conversations exist.",
		inputSchema: z.object({
			limit: z
				.number()
				.int()
				.min(1)
				.max(50)
				.default(10)
				.describe('How many threads to return (default 10, max 50)')
		}),
		execute: async ({ limit }: { limit?: number }) => {
			const all = listChatThreads();
			const n = Math.min(Math.max(limit ?? 10, 1), 50);
			return {
				count: all.length,
				returned: Math.min(all.length, n),
				threads: all.slice(0, n).map((t) => ({
					thread_id: t.thread_id,
					message_count: t.message_count,
					latest_ts: t.latest_ts
				}))
			};
		}
	}),
	read_thread_messages: tool({
		description:
			"Returns the most recent N messages from a specific chat thread. Use when the operator wants to recall, summarize, or refer back to a conversation — including the active thread when they ask 'what did I say earlier?' or 'summarize this thread'.",
		inputSchema: z.object({
			thread_id: z
				.string()
				.describe(
					'Thread id (use the active thread id from the system context if the operator does not specify one)'
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(50)
				.default(20)
				.describe('How many recent messages to return (default 20, max 50)')
		}),
		execute: async ({ thread_id, limit }: { thread_id: string; limit?: number }) => {
			const rows = getChatMessages(Math.min(Math.max(limit ?? 20, 1), 50), thread_id);
			return {
				thread_id,
				returned: rows.length,
				messages: rows.map((m) => ({
					sender: m.sender,
					message: m.message,
					timestamp: m.timestamp
				}))
			};
		}
	}),
	get_server_status: tool({
		description:
			'Reports the live status of the operator-facing LogueOS services on this machine (Console, dispatch listener, MCP gateway). Use when the operator asks if services are up, what is running, or troubleshoots a "why did nothing happen" symptom.',
		inputSchema: z.object({}),
		execute: async () => {
			const probes: { name: string; url: string }[] = [
				{ name: 'console', url: 'http://127.0.0.1:18767/console/' },
				{ name: 'dispatch_listener', url: 'http://127.0.0.1:19100/healthz' },
				{ name: 'mcp_gateway', url: 'http://127.0.0.1:18766/mcp' }
			];
			const results = await Promise.all(
				probes.map(async (p) => {
					try {
						const r = await fetch(p.url, {
							method: 'GET',
							signal: AbortSignal.timeout(2000)
						});
						return { name: p.name, url: p.url, ok: r.status < 500, status: r.status };
					} catch (err) {
						return {
							name: p.name,
							url: p.url,
							ok: false,
							error: (err as Error).message
						};
					}
				})
			);
			return { checked_at: new Date().toISOString(), services: results };
		}
	})
};
