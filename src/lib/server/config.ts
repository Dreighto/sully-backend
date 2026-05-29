// Server-only configuration. Lives under $lib/server/ so SvelteKit's
// build will refuse to import it from any client-reachable module —
// see https://svelte.dev/docs/kit/server-only-modules.
//
// Why this is a separate file: the previous shape (single $lib/config.ts)
// imported $env/dynamic/private, but $lib/config was also imported by
// +page.svelte (client). $env/dynamic/private "can only be imported into
// modules that only run on the server" — flagged Critical by CodeRabbit
// on PR #2. Splitting server vs. client config is the SvelteKit
// canonical pattern.

import { env as privateEnv } from '$env/dynamic/private';

// Same fallback chain as before: $env first (set via .env or platform
// secret manager), then process.env (local dev with raw shell exports),
// then the literal default. This survives both `vite dev` and a built
// `node build/` deployment.
//
// Nullish coalescing (??) instead of || so an env var explicitly set to ''
// (empty string, no value) doesn't silently fall through to the next tier.
// CodeRabbit Round 2 nit: previously used (privateEnv as Record<string,string>)
// which masked the actual `string | undefined` return type from $env.
const getEnv = (key: string, fallback: string): string =>
	privateEnv[key] ?? (typeof process !== 'undefined' ? (process.env[key] ?? fallback) : fallback);

// Validate parsed integers — CodeRabbit Major: parseInt accepts NaN,
// negatives, and "1foo", any of which would silently break the polling
// loop or return-window math. Fail loudly at startup instead.
const parsePositiveInt = (raw: string, name: string): number => {
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(
			`${name} must be a positive integer; got ${JSON.stringify(raw)} (parsed as ${value}).`
		);
	}
	return value;
};

// LOS-20: post-LOS-10 cutover (2026-05-11). Audit chain + listener logs now
// live in LogueOS-Orchestrator/data and /logs. Defaults updated; both env
// vars still overridable for dev/test isolation. Old project-miru paths are
// now the frozen v1 chain — Console reads the live v2 chain by default.
export const serverConfig = {
	completionLogPath: getEnv(
		'LOGUEOS_COMPLETION_LOG_PATH',
		'D:\\dev\\LogueOS-Orchestrator\\data\\cc_completion_log.jsonl'
	),
	decisionsLogPath: getEnv(
		'LOGUEOS_DECISIONS_LOG_PATH',
		'D:\\dev\\LogueOS-Orchestrator\\data\\agent_decisions.jsonl'
	),
	workerLogPath: getEnv(
		'LOGUEOS_WORKER_LOG_PATH',
		'D:\\dev\\LogueOS-Orchestrator\\logs\\dispatch_listener_stdout.log'
	),
	heartbeatsLogPath: getEnv(
		'LOGUEOS_HEARTBEATS_LOG_PATH',
		'D:\\dev\\LogueOS-Orchestrator\\data\\cc_heartbeat_log.jsonl'
	),
	// Kill switch contract (tools/check_kill_switch.py): file presence at
	// killSwitchPath = ACTIVE. File absence = CLEAR. Contents are free-form;
	// we write a small JSON payload on activate so future workers can see
	// who/when/why before deciding what to do. killSwitchLogPath is an
	// append-only audit of every activate/clear toggle for after-the-fact
	// review (separate from the existence-bit because the bit is destroyed
	// on clear).
	killSwitchPath: getEnv(
		'LOGUEOS_KILL_SWITCH_PATH',
		'D:\\dev\\LogueOS-Orchestrator\\data\\system_halt'
	),
	killSwitchLogPath: getEnv(
		'LOGUEOS_KILL_SWITCH_LOG_PATH',
		'D:\\dev\\LogueOS-Orchestrator\\data\\kill_switch_log.jsonl'
	),
	memoryDbPath: getEnv(
		'LOGUEOS_MEMORY_DB_PATH',
		'D:\\dev\\LogueOS-Orchestrator\\data\\logueos_memory.db'
	),
	// Directory for operator-pasted images in the Chat tab. Files are written
	// here by POST /api/chat/uploads and streamed back by GET
	// /api/chat/uploads/[filename]. Lives under the orchestrator data dir so
	// it shares the same backup-and-mount story as the JSONL chains and DBs.
	chatUploadsDir: getEnv(
		'LOGUEOS_CHAT_UPLOADS_DIR',
		'/home/dreighto/dev/LogueOS-Orchestrator/data/chat_uploads'
	),
	// dispatch_listener writes worker stdout/stderr to
	// <traceLogDir>/<trace_id>.stdout.log and .stderr.log (spawn.js:691). The
	// chat tab tails these via SSE so the operator sees in-flight worker
	// output as it lands, not just the final emit_chat_message.
	traceLogDir: getEnv(
		'LOGUEOS_TRACE_LOG_DIR',
		'/home/dreighto/dev/LogueOS-Orchestrator/logs/dispatch_listener_traces'
	),
	adoptedLessonsPath: getEnv(
		'LOGUEOS_ADOPTED_LESSONS_PATH',
		'D:\\dev\\LogueOS-Orchestrator\\.logueos\\overlays\\adopted-lessons.md'
	),
	// Dispatch listener address (Console -> listener for /kill and future
	// /restart). Same machine in production; configurable for dev so we can
	// point at a side-port instance without touching the live 19100. The
	// HMAC secret here MUST match the listener's W4_LISTENER_HMAC_SECRET
	// (the listener reads that exact env var) -- if the secrets disagree
	// every POST gets 401'd. Reads LOGUEOS_LISTENER_HMAC_SECRET first
	// (post-untie convention) then W4_LISTENER_HMAC_SECRET (legacy listener
	// env name) so an operator-side .env already configured for the
	// listener Just Works.
	dispatchListenerUrl: getEnv('LOGUEOS_DISPATCH_LISTENER_URL', 'http://127.0.0.1:19100'),
	dispatchListenerHmacSecret:
		getEnv('LOGUEOS_LISTENER_HMAC_SECRET', '') || getEnv('W4_LISTENER_HMAC_SECRET', ''),
	// LogueOS Gateway address (Console -> gateway for /api/v1/* read+dispatch).
	// Same machine in production; configurable for dev. The gateway gates
	// every /api/v1/* call behind is_trusted_origin (localhost / Tailscale
	// CGNAT only — see LogueOS-Orchestrator/tools/logueos_mcp_gateway/api_v1.py),
	// so this URL must reach the gateway from a trusted network position.
	gatewayUrl: getEnv('LOGUEOS_GATEWAY_URL', 'http://127.0.0.1:18766'),
	pollIntervalMs: parsePositiveInt(getEnv('LOGUEOS_RUN_POLL_MS', '5000'), 'LOGUEOS_RUN_POLL_MS'),
	feedLimit: parsePositiveInt(getEnv('LOGUEOS_RUN_FEED_LIMIT', '50'), 'LOGUEOS_RUN_FEED_LIMIT'),
	// Per-provider daily token caps for the LLM router (PR 1c).
	// Claude Max sub is generous — 1M cap is a safety valve, not a hard budget.
	// GEMINI_API_KEY is reserved for image gen, so the Gemini OAuth chat quota
	// is tracked separately but uses the same cap env var.
	anthropicDailyTokenCap: parsePositiveInt(
		getEnv('ANTHROPIC_DAILY_TOKEN_CAP', '1000000'),
		'ANTHROPIC_DAILY_TOKEN_CAP'
	),
	openaiDailyTokenCap: parsePositiveInt(
		getEnv('OPENAI_DAILY_TOKEN_CAP', '200000'),
		'OPENAI_DAILY_TOKEN_CAP'
	),
	geminiDailyTokenCap: parsePositiveInt(
		getEnv('GEMINI_DAILY_TOKEN_CAP', '2000000'),
		'GEMINI_DAILY_TOKEN_CAP'
	),
	// VAPID keys for Web Push (PR 6). Generate once with tools/generate_vapid_keys.js.
	// VAPID subject MUST be mailto: — Apple returns 403 on bare-domain subjects
	// per Decision Log entry 10.
	vapidPublicKey: getEnv('VAPID_PUBLIC_KEY', ''),
	vapidPrivateKey: getEnv('VAPID_PRIVATE_KEY', ''),
	vapidSubject: 'mailto:dreighto@gmail.com',
	// Feature flag: set ENABLE_WEB_PUSH=false to disable without a git revert.
	enableWebPush: getEnv('ENABLE_WEB_PUSH', 'true') !== 'false',
	// Path to LogueOS-Orchestrator/.env — used by the privacy redactor (PR 8) to
	// scan observation bodies for secret values before persisting to the memory DB.
	// Fail-closed: if this file is unreadable, Tier 0 emission is BLOCKED.
	orchestratorEnvPath: getEnv(
		'LOGUEOS_ORCHESTRATOR_ENV_PATH',
		'/home/dreighto/dev/LogueOS-Orchestrator/.env'
	)
};

// Subset of serverConfig that's safe to expose to the client via load().
// Specifically excludes completionLogPath (filesystem path leak risk).
export const clientSafeConfig = {
	pollIntervalMs: serverConfig.pollIntervalMs,
	feedLimit: serverConfig.feedLimit,
	// Public VAPID key is safe to expose — it's the public half of the pair.
	vapidPublicKey: serverConfig.vapidPublicKey,
	enableWebPush: serverConfig.enableWebPush
};
