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
const getEnv = (key: string, fallback: string): string =>
	privateEnv[key] ?? (typeof process !== 'undefined' ? (process.env[key] ?? fallback) : fallback);

// Validate parsed integers — parseInt accepts NaN, negatives, and "1foo",
// any of which would silently break the polling loop or return-window math.
// Fail loudly at startup instead.
const parsePositiveInt = (raw: string, name: string): number => {
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(
			`${name} must be a positive integer; got ${JSON.stringify(raw)} (parsed as ${value}).`
		);
	}
	return value;
};

// Defaults are Linux paths (the companion runs on the Linux ROOM box). All the
// kernel-artifact paths below (completion log, decisions, heartbeats, kill
// switch, adopted lessons) are behind mode-gated code in companion mode, so
// their values are irrelevant there — but they default to the canonical
// Orchestrator dirs (not a dead Windows D:\ path) so a stray read can never hit
// a nonexistent path. memoryDbPath + chatUploadsDir are overridden by the
// companion .env to the app's OWN private data dir.
export const serverConfig = {
	// Run mode (LogueOS-Companion fork). 'wired' (default) behaves like the
	// Console against the shared kernel DB + gateway; 'companion' is the
	// standalone local-model app (own DB, kernel features OFF, model companion-v1).
	// Default-wired is fail-closed — an unset/typo'd value is the safe clone.
	mode: getEnv('LOGUEOS_APP_MODE', 'wired'),
	// Default local model for companion mode (verified installed Ollama tag).
	companionDefaultModel: getEnv('COMPANION_DEFAULT_MODEL', 'companion-v1:latest'),
	// Cloud-only override for companion mode. When 'true' (operator flag),
	// Auto routing never falls through to the local provider — keeps the GPU
	// free for QLoRA training or other GPU workloads. The picker's explicit
	// "Local (Ollama)" option still works (operator opt-in only). Flip back
	// to 'false' once GPU is free again. Set via the companion .env.
	companionLocalDisabled: getEnv('COMPANION_LOCAL_DISABLED', 'false') === 'true',
	completionLogPath: getEnv(
		'LOGUEOS_COMPLETION_LOG_PATH',
		'/home/dreighto/dev/LogueOS-Orchestrator/data/cc_completion_log.jsonl'
	),
	decisionsLogPath: getEnv(
		'LOGUEOS_DECISIONS_LOG_PATH',
		'/home/dreighto/dev/LogueOS-Orchestrator/data/agent_decisions.jsonl'
	),
	workerLogPath: getEnv(
		'LOGUEOS_WORKER_LOG_PATH',
		'/home/dreighto/dev/LogueOS-Orchestrator/logs/dispatch_listener_stdout.log'
	),
	heartbeatsLogPath: getEnv(
		'LOGUEOS_HEARTBEATS_LOG_PATH',
		'/home/dreighto/dev/LogueOS-Orchestrator/data/cc_heartbeat_log.jsonl'
	),
	// Kill switch contract (tools/check_kill_switch.py): file presence at
	// killSwitchPath = ACTIVE. File absence = CLEAR. (Gated off in companion mode.)
	killSwitchPath: getEnv(
		'LOGUEOS_KILL_SWITCH_PATH',
		'/home/dreighto/dev/LogueOS-Orchestrator/data/system_halt'
	),
	killSwitchLogPath: getEnv(
		'LOGUEOS_KILL_SWITCH_LOG_PATH',
		'/home/dreighto/dev/LogueOS-Orchestrator/data/kill_switch_log.jsonl'
	),
	memoryDbPath: getEnv(
		'LOGUEOS_MEMORY_DB_PATH',
		'/home/dreighto/dev/LogueOS-Orchestrator/data/logueos_memory.db'
	),
	// The kernel's dispatch ledger DB — ALWAYS the orchestrator's logueos_memory.db
	// (where the dispatch_listener writes worker_runs), regardless of app mode. In
	// 'companion' mode memoryDbPath is overridden to companion.db (chat data), so
	// worker_runs is NOT there — read this path for per-worker token spend.
	kernelDbPath: getEnv(
		'LOGUEOS_KERNEL_DB_PATH',
		'/home/dreighto/dev/LogueOS-Orchestrator/data/logueos_memory.db'
	),
	// Directory for operator-pasted images in the Chat tab. Files are written
	// here by POST /api/chat/uploads and streamed back by GET
	// /api/chat/uploads/[filename]. Companion overrides this to its own data dir.
	chatUploadsDir: getEnv(
		'LOGUEOS_CHAT_UPLOADS_DIR',
		'/home/dreighto/dev/LogueOS-Orchestrator/data/chat_uploads'
	),
	// dispatch_listener writes worker stdout/stderr to <traceLogDir>/<trace_id>.*.log
	// (kernel feature; gated off in companion mode).
	traceLogDir: getEnv(
		'LOGUEOS_TRACE_LOG_DIR',
		'/home/dreighto/dev/LogueOS-Orchestrator/logs/dispatch_listener_traces'
	),
	adoptedLessonsPath: getEnv(
		'LOGUEOS_ADOPTED_LESSONS_PATH',
		'/home/dreighto/dev/LogueOS-Orchestrator/.logueos/overlays/adopted-lessons.md'
	),
	// Dispatch listener address (kernel feature; gated off in companion mode).
	dispatchListenerUrl: getEnv('LOGUEOS_DISPATCH_LISTENER_URL', 'http://127.0.0.1:19100'),
	dispatchListenerHmacSecret:
		getEnv('LOGUEOS_LISTENER_HMAC_SECRET', '') || getEnv('W4_LISTENER_HMAC_SECRET', ''),
	// LogueOS Gateway address (Console -> gateway for /api/v1/* read+dispatch).
	// Kernel feature; gated off in companion mode.
	gatewayUrl: getEnv('LOGUEOS_GATEWAY_URL', 'http://127.0.0.1:18766'),
	pollIntervalMs: parsePositiveInt(getEnv('LOGUEOS_RUN_POLL_MS', '5000'), 'LOGUEOS_RUN_POLL_MS'),
	feedLimit: parsePositiveInt(getEnv('LOGUEOS_RUN_FEED_LIMIT', '50'), 'LOGUEOS_RUN_FEED_LIMIT'),
	// Per-provider daily token caps for the LLM router.
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
	// VAPID keys for Web Push. VAPID subject MUST be mailto: — Apple returns 403
	// on bare-domain subjects.
	vapidPublicKey: getEnv('VAPID_PUBLIC_KEY', ''),
	vapidPrivateKey: getEnv('VAPID_PRIVATE_KEY', ''),
	vapidSubject: 'mailto:dreighto@gmail.com',
	// Feature flag: set ENABLE_WEB_PUSH=false to disable without a git revert.
	// (Companion defaults this OFF in its .env — no kernel completions to notify.)
	enableWebPush: getEnv('ENABLE_WEB_PUSH', 'true') !== 'false',
	// APNs (native iOS push) — delivers to the Capacitor/TestFlight app, which
	// runs the service worker inert so Web Push can't reach it. Empty until the
	// operator drops the .p8 + key id; the sender self-gates on apnsKeyPath being
	// set, so it's a no-op until configured. The .p8 lives OUTSIDE git.
	apnsKeyPath: getEnv('APNS_KEY_PATH', ''),
	apnsKeyId: getEnv('APNS_KEY_ID', ''),
	apnsTeamId: getEnv('APNS_TEAM_ID', 'G3KJW4VXM9'),
	apnsBundleId: getEnv('APNS_BUNDLE_ID', 'com.dreighto.sully'),
	// TestFlight + App Store builds use the PRODUCTION APNs endpoint. Set
	// APNS_PRODUCTION=false only for a development-signed build.
	apnsProduction: getEnv('APNS_PRODUCTION', 'true') !== 'false',
	// Path to LogueOS-Orchestrator/.env — used by the privacy redactor to scan
	// observation bodies before persisting. Fail-closed; gated off in companion mode.
	orchestratorEnvPath: getEnv(
		'LOGUEOS_ORCHESTRATOR_ENV_PATH',
		'/home/dreighto/dev/LogueOS-Orchestrator/.env'
	),
	// ── Companion dispatcher (Phase 1) ──────────────────────────────────────
	// Companion-native dispatch is gated by its OWN flag, NOT the kernel `_wired`
	// gate. `_wired`/`dispatchEnabled` stay false in companion mode (they govern
	// the kernel GATEWAY path); this flag governs the NEW companion->listener path.
	companionDispatchCap: parsePositiveInt(
		getEnv('COMPANION_DISPATCH_CAP', '20'),
		'COMPANION_DISPATCH_CAP'
	),
	companionDispatchWindowMin: parsePositiveInt(
		getEnv('COMPANION_DISPATCH_WINDOW_MIN', '1440'),
		'COMPANION_DISPATCH_WINDOW_MIN'
	),
	// Shared secret the dispatched worker uses to authenticate its activity
	// callback POST to /api/chat/activity (HMAC over the raw body). Empty =
	// callback auth disabled (callbacks rejected) — fail closed.
	companionCallbackSecret: getEnv('COMPANION_CALLBACK_SECRET', ''),
	// Absolute base URL the worker prompt embeds so the worker can reach this
	// app's callback endpoint (e.g. the :8444 tailnet origin).
	companionCallbackBaseUrl: getEnv(
		'COMPANION_CALLBACK_BASE_URL',
		'https://room.taila28611.ts.net:8444/companion'
	)
};

// ── Run-mode derived booleans ─────────────────────────────────────────────
// Single source of truth for kernel coupling. Every kernel-coupled call site
// reads ONE named boolean from here (greppable + unit-testable) instead of
// scattering `mode === 'companion'` string compares. A unit test asserts the
// full matrix: 'wired' -> all true, 'companion' -> all false, ''/garbage -> all
// true (the fail-closed default).
const _wired = serverConfig.mode !== 'companion';
const _companionDispatch =
	serverConfig.mode === 'companion' && getEnv('COMPANION_DISPATCH_ENABLED', 'false') === 'true';
export const runMode = {
	mode: serverConfig.mode,
	companion: !_wired,
	kernelWired: _wired, // master gate
	dispatchEnabled: _wired, // @cc/@agy + workflow gateway dispatch (KERNEL path)
	observationsEnabled: _wired, // Tier-0 observation emit to the shared DB
	gatewayWorkspaces: _wired, // fetch workspace list from the gateway
	completionPoller: _wired, // tail cc_completion_log.jsonl for push
	killSwitchEnabled: _wired, // read the system_halt kernel artifact
	companionDispatchEnabled: _companionDispatch // NEW companion->listener dispatch
} as const;

// ── App identity ──────────────────────────────────────────────────────────
// One place to ask "who am I" — fork-aware. The companion is NOT the Console,
// and shipping prompts/UI/pushes that say "LogueOS Console" in companion mode
// is a visible identity bug (the model literally tells itself it's the Console
// every turn). Read from here, do NOT hard-code 'LogueOS-Console' or '/console'
// anywhere fork-sensitive.
const _companionIdentity = {
	appName: 'LogueOS Companion',
	basePath: '/companion',
	/** The workspace string surfaced in the repo chip + persisted in thread state. */
	defaultWorkspace: 'companion',
	/** Pretty label for the sidebar footer "CORE:" pill — the model's name. */
	coreLabel: 'Sully',
	/** What the model calls itself in its system prompt (named after the operator's late rabbit). */
	personaName: 'Sully',
	pushIconUrl: '/companion/favicon.png',
	pushDefaultUrl: '/companion/chat'
} as const;
const _consoleIdentity = {
	appName: 'LogueOS Console',
	basePath: '/console',
	defaultWorkspace: 'LogueOS-Console',
	coreLabel: 'LogueOS-Console',
	personaName: 'Console assistant',
	pushIconUrl: '/console/favicon.png',
	pushDefaultUrl: '/console/chat'
} as const;
export const appIdentity = runMode.companion ? _companionIdentity : _consoleIdentity;

// Subset of serverConfig that's safe to expose to the client via load().
// Specifically excludes filesystem paths (leak risk).
export const clientSafeConfig = {
	pollIntervalMs: serverConfig.pollIntervalMs,
	feedLimit: serverConfig.feedLimit,
	// Public VAPID key is safe to expose — it's the public half of the pair.
	vapidPublicKey: serverConfig.vapidPublicKey,
	enableWebPush: serverConfig.enableWebPush,
	// Companion-mode flags drive client-side UI (surface companion model first,
	// hide @cc/@agy + workflow affordances). No server paths leaked.
	companionMode: serverConfig.mode === 'companion',
	companionDefaultModel: serverConfig.companionDefaultModel,
	// Gate for companion-native SSE dispatch (WorkingBubble). True only when
	// COMPANION_DISPATCH_ENABLED=true + mode=companion. Client reads this to
	// short-circuit the legacy 5s pollActivity loop.
	companionDispatchEnabled: runMode.companionDispatchEnabled,
	// Fork-aware identity — labels + the default workspace the chip starts on.
	// Read this on the client instead of hard-coding 'LogueOS-Console'.
	appIdentity: {
		appName: appIdentity.appName,
		defaultWorkspace: appIdentity.defaultWorkspace,
		coreLabel: appIdentity.coreLabel
	}
};
