// AI-SDK tool wrappers for the Phase-1 READ-ONLY system-inspection functions in
// $lib/server/systemTools.ts. These let Sully's chat model look at the REAL
// state of the LogueOS services on ROOM mid-turn (is X up? recent logs? disk/
// memory?) instead of guessing — anti-hallucination is the whole point.
//
// Vercel AI SDK v6 shape (verified against ai@6.0.193): each tool is
// `tool({ description, inputSchema: z.object({...}), execute })`. The route
// attaches them to the DEFAULT streamText path with a `stopWhen: stepCountIs(n)`
// budget so the model can call a tool, read the result, and continue its reply.
//
// SAFETY: the `unit` argument is `z.enum(SERVICE_WHITELIST)` — the model can
// ONLY ever name one of the nine sanctioned units; a hallucinated unit name
// fails schema validation and the tool never runs. The underlying functions
// ALSO re-validate the whitelist and exec via arg-arrays (no shell). These tools
// are read-only: no start/stop/restart/edit anywhere.

import { tool } from 'ai';
import { z } from 'zod';
import {
	SERVICE_WHITELIST,
	serviceList,
	serviceStatus,
	serviceLogs,
	systemHealth
} from '$lib/server/systemTools';

// z.enum over the whitelist tuple — the model's `unit` arg is constrained to a
// sanctioned unit at the schema layer. Shared by the two unit-scoped tools.
const unitEnum = z
	.enum(SERVICE_WHITELIST)
	.describe('The exact LogueOS service unit to inspect. Only these nine are allowed.');

export const systemReadTools = {
	list_services: tool({
		description:
			'Lists every LogueOS service on this machine (ROOM) with its live active + enabled state. Use this FIRST when the operator asks "are the services up?", "what\'s running?", "is everything healthy?", or before claiming any service state — read the real status, never guess.',
		inputSchema: z.object({}),
		execute: async () => {
			const services = await serviceList();
			return { checked_at: new Date().toISOString(), count: services.length, services };
		}
	}),
	service_status: tool({
		description:
			'Detailed live status of ONE LogueOS service: active/enabled, sub-state (running/dead/failed), when it entered active, and its main PID. Use when the operator asks about a specific service or you need to confirm one unit before answering.',
		inputSchema: z.object({ unit: unitEnum }),
		execute: async ({ unit }: { unit: string }) => {
			return await serviceStatus(unit);
		}
	}),
	service_logs: tool({
		description:
			'Recent journal log lines for ONE LogueOS service (secrets scrubbed). Use to diagnose "why did X fail / restart / behave oddly?" — read the actual logs instead of speculating. Default 40 lines, up to 200.',
		inputSchema: z.object({
			unit: unitEnum,
			lines: z
				.number()
				.int()
				.min(1)
				.max(200)
				.default(40)
				.describe('How many recent log lines to return (default 40, max 200)')
		}),
		execute: async ({ unit, lines }: { unit: string; lines?: number }) => {
			return await serviceLogs(unit, lines ?? 40);
		}
	}),
	system_health: tool({
		description:
			'Machine-level health for ROOM: disk usage for / and the data mount, memory, load/uptime, and reachability of the key local ports (backend, MCP gateway, dispatch listener, voice bridges). Use when the operator asks "how\'s the box?", "are we low on disk/memory?", or troubleshoots a "why is nothing responding?" symptom.',
		inputSchema: z.object({}),
		execute: async () => {
			return await systemHealth();
		}
	})
};
