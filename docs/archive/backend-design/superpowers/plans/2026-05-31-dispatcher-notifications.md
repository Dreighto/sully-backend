# Sully Dispatcher — Notifications (N1/N2/N3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sully (LogueOS-Companion) able to wake the iPhone-as-app from a _closed_ state and surface actionable notifications for the dispatcher: lock-screen completion, approve/retry buttons that round-trip while the app is closed, quota/digest summaries, and a live "Working…" Dynamic Island card. APNs is the only channel that reaches the Capacitor WebView app (Web Push is inert there by design — `capacitor.config.ts:53-58`), so this builds a net-new APNs server spine behind a channel-agnostic envelope, mirroring the existing VAPID sender + dead-sub reaper pattern in `src/lib/server/web_push.ts`.

**Architecture:** Server emits ONE channel-agnostic envelope (`NotifyEnvelope`); `notify.ts` fans it to per-channel adapters (`apns.ts` for the app, the existing `web_push.ts` for desktop/Safari). `apns.ts` is a Node-built-in HTTP/2 + ES256-JWT(`.p8`) sender that maps the envelope to `aps.*` payload fields + APNs headers (`apns-collapse-id`, `apns-push-type`, `apns-priority`, `apns-topic`). Device tokens live in a new `chat_apns_tokens` table in `companion.db` with a 410-Gone reaper exactly like `chat_dead_subscriptions`. The client (Capacitor `@capacitor/push-notifications`) registers a device token and POSTs it to a new tailnet-gated route. `completion_poller.ts` is upgraded from flat `{title,body,url}` to envelopes. N2 adds notification categories/actions + a committed native `UNUserNotificationCenterDelegate` Swift handler (lock-screen buttons while CLOSED, keyed on `trace_id`) + a `trace_id→message_id` lookup on `/api/chat/approve` + a `/api/chat/dispatch/rerun` route + quota-warning + daily digest. N3 (build last) adds the SwiftUI Widget Extension Live Activity (`ActivityAttributes`/`ContentState`), the `ludufre/capacitor-live-activities` wiring, and the committed `codemagic.yaml` post-`cap add ios` injection step (because `ios/` is regenerated fresh every build).

**Tech Stack:** SvelteKit (adapter-node) + Svelte 5 runes + TypeScript; `better-sqlite3` (idempotent `CREATE TABLE IF NOT EXISTS` migrations, mirrored from `src/lib/server/web_push.ts:21-41` and `src/lib/server/usage.ts:37-50`); Node built-in `http2` + `crypto` (ES256 over the `.p8` PKCS#8 EC P-256 key — **no `jsonwebtoken` dep**, verified `crypto.sign('sha256', …, {dsaEncoding:'ieee-p1363'})` yields a 64-byte JWS sig on Node v22.22.2); Capacitor 8 (`@capacitor/push-notifications`, `@capacitor/app`); Swift (Widget Extension, `UNUserNotificationCenterDelegate`); Codemagic CI. Tests = vitest (`tests/**/*.test.ts`, `npx vitest run tests/<file>`); Swift/CI tasks are config — not vitest-testable — so they use a **verify** step (on-device / build check) instead of a unit test. Build+deploy of the server = `npm run build` then `sudo systemctl restart logueos-companion` (serves :18769, base path `/companion`, reachable at the `:8444` tailnet origin).

---

## File Structure

| File                                                                                                                    | Create/Modify | Single responsibility                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/types/notify.ts`                                                                                               | **create**    | The channel-agnostic `NotifyEnvelope` type + `NotifyAction`, `NotifyKind`, `InterruptionLevel` unions + the `ApnsPayload` shape. Pure types, importable client+server.                                             |
| `src/lib/server/notify.ts`                                                                                              | **create**    | The dispatcher: `dispatchEnvelope(env)` fans one envelope to channel adapters (APNs always; web-push when `enableWebPush`); `buildWebPushPayload(env)` down-maps the envelope to the legacy `{title,body,url}`.    |
| `src/lib/server/apns.ts`                                                                                                | **create**    | HTTP/2 + ES256-JWT(`.p8`) APNs sender. `sendApns(env)` → maps envelope to `aps.*` + headers, sends to every token in `chat_apns_tokens`, reaps 410-Gone tokens. Token CRUD + reaper mirror `web_push.ts`.          |
| `tests/notify-envelope.test.ts`                                                                                         | **create**    | Pins envelope→`aps.*` mapping, header derivation (`apns-push-type`, `apns-collapse-id`, `apns-priority`), and the web-push down-map.                                                                               |
| `tests/apns-tokens.test.ts`                                                                                             | **create**    | Pins the `chat_apns_tokens` table migration (idempotent), upsert, 410 reaper into `chat_apns_dead_tokens`.                                                                                                         |
| `tests/apns-jwt.test.ts`                                                                                                | **create**    | Pins the ES256 JWT builder: header `{alg:ES256,kid}`, claim `{iss,iat}`, 64-byte sig, 50-min cache reuse.                                                                                                          |
| `src/lib/client/apns-register.ts`                                                                                       | **create**    | Capacitor client: `registerApnsToken()` — `PushNotifications.requestPermissions()` → `register()` → on `registration` POST `/api/chat/push/apns/register`. No-op off-native.                                       |
| `src/routes/api/chat/push/apns/register/+server.ts`                                                                     | **create**    | Tailnet-gated POST `{device_id, token, environment}` → `upsertApnsToken`.                                                                                                                                          |
| `capacitor.config.ts`                                                                                                   | **modify**    | Add the BUILD-2 `plugins.PushNotifications` block + the `aps-environment` entitlement note.                                                                                                                        |
| `src/lib/server/completion_poller.ts`                                                                                   | **modify**    | Emit a `NotifyEnvelope` via `dispatchEnvelope` instead of the flat `sendPushToAll`.                                                                                                                                |
| `ios/App/App/NotificationService.swift` (committed source under `ios-native/NotificationService.swift`, injected by CI) | **create**    | `UNUserNotificationCenterDelegate` background-action handler: POSTs the chosen action to the server keyed on `trace_id` while the app is CLOSED.                                                                   |
| `src/routes/api/chat/notify/action/+server.ts`                                                                          | **create**    | Tailnet-gated POST `{trace_id, action_id, category}` from the native delegate → routes to approve/rerun/skip; records for JS reconciliation.                                                                       |
| `src/routes/api/chat/approve/+server.ts`                                                                                | **modify**    | Accept `trace_id` (in addition to `message_id`); resolve `trace_id→message_id` via `chat_messages`.                                                                                                                |
| `src/routes/api/chat/dispatch/rerun/+server.ts`                                                                         | **create**    | Tailnet-gated POST `{trace_id}` → re-emit a dispatch for that trace (DISPATCH_RETRYABLE / rerun action target).                                                                                                    |
| `src/lib/server/notify_categories.ts`                                                                                   | **create**    | Canonical category/action registry (`DISPATCH_RESULT`, `APPROVAL_REQUEST`, `DISPATCH_RETRYABLE`, `QUOTA_WARNING`, `DIGEST`, `LIVE_STATUS_FALLBACK`) shared by server emitters + the Swift category-mirror comment. |
| `src/lib/server/quota_digest.ts`                                                                                        | **create**    | `emitQuotaWarning(provider, …)` + `emitDailyDigest()` envelope emitters.                                                                                                                                           |
| `tests/notify-categories.test.ts`                                                                                       | **create**    | Pins the category registry (ids, action ids, `interruption_level`, per-provider `collapse_id` for QUOTA_WARNING).                                                                                                  |
| `tests/notify-routes.test.ts`                                                                                           | **create**    | Pins `/api/chat/approve` trace_id lookup + `/api/chat/notify/action` routing logic (the pure resolver, not the HTTP layer).                                                                                        |
| `ios-native/SullyWidget/SullyWidgetLiveActivity.swift`                                                                  | **create**    | SwiftUI Widget Extension: `ActivityAttributes` + `ContentState` + the lock-screen/Dynamic Island view with `Text(timerInterval:)`. Injected into `ios/` by CI.                                                     |
| `ios-native/SullyWidget/Info.plist`                                                                                     | **create**    | Widget extension Info.plist (`NSExtensionPointIdentifier=com.apple.widgetkit-extension`).                                                                                                                          |
| `scripts/ci-ios-liveactivity.sh`                                                                                        | **create**    | The committed post-`cap add ios` patch step: creates the widget target, copies the Swift/plist, sets `NSSupportsLiveActivities` + App Group, wires `aps-environment`.                                              |
| `codemagic.yaml`                                                                                                        | **modify**    | Add the "Inject Live Activity widget extension" step that runs `scripts/ci-ios-liveactivity.sh` after `cap add ios`.                                                                                               |
| `scripts/ci-ios-patch.sh`                                                                                               | **modify**    | Add the `aps-environment` entitlement + `NSSupportsLiveActivities` Info.plist keys (BUILD-2 push).                                                                                                                 |

---

## Tasks

### N1 — APNs spine

---

### Task 1 — The channel-agnostic envelope type

**Files:** create `src/lib/types/notify.ts`; create `tests/notify-envelope.test.ts`

The envelope is the single shape the server emits; adapters translate it. Fields are taken verbatim from spec §4.13. There is no existing `notify.ts` type file (verified). The `ApnsPayload` here is the on-wire `aps.*` shape `apns.ts` will produce in Task 3.

- [ ] **Write the failing test.** Create `tests/notify-envelope.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeEnvelope } from '../src/lib/types/notify';
import type { NotifyEnvelope } from '../src/lib/types/notify';

describe('NotifyEnvelope', () => {
	it('makeEnvelope fills defaults and is well-typed', () => {
		const env: NotifyEnvelope = makeEnvelope({
			kind: 'dispatch_result',
			trace_id: 'trace-abc',
			title: 'Dispatch complete',
			body: 'PRO-1 — done',
			category: 'DISPATCH_RESULT'
		});
		expect(env.v).toBe(1);
		expect(env.kind).toBe('dispatch_result');
		expect(env.trace_id).toBe('trace-abc');
		expect(env.category).toBe('DISPATCH_RESULT');
		// Defaults applied when omitted:
		expect(env.interruption_level).toBe('active');
		expect(env.actions).toEqual([]);
		expect(env.relevance_score).toBe(0);
	});

	it('preserves explicit optional fields', () => {
		const env = makeEnvelope({
			kind: 'approval_request',
			trace_id: 't1',
			title: 'Approve?',
			body: 'cc wants to run a command',
			category: 'APPROVAL_REQUEST',
			interruption_level: 'time-sensitive',
			collapse_id: 'approve-t1',
			thread_group: 'approvals',
			deep_link: '/companion/chat?thread=default',
			actions: [{ id: 'APPROVE', title: 'Approve' }],
			ticket_id: 'PRO-2'
		});
		expect(env.interruption_level).toBe('time-sensitive');
		expect(env.collapse_id).toBe('approve-t1');
		expect(env.actions[0].id).toBe('APPROVE');
		expect(env.ticket_id).toBe('PRO-2');
	});
});
```

- [ ] **Run it (expected FAIL — module does not exist):**
      `npx vitest run tests/notify-envelope.test.ts`
      Expect: `Failed to resolve import "../src/lib/types/notify"`.

- [ ] **Minimal implementation.** Create `src/lib/types/notify.ts`:

```ts
// Channel-agnostic notification envelope (spec §4.13). The server emits ONE of
// these; per-channel adapters (apns.ts, web_push.ts) translate it. v=1 is the
// schema version so a stale Swift/native consumer can detect drift.

export type NotifyKind =
	| 'dispatch_result'
	| 'approval_request'
	| 'dispatch_retryable'
	| 'quota_warning'
	| 'digest'
	| 'live_status_fallback';

export type NotifyCategory =
	| 'DISPATCH_RESULT'
	| 'APPROVAL_REQUEST'
	| 'DISPATCH_RETRYABLE'
	| 'QUOTA_WARNING'
	| 'DIGEST'
	| 'LIVE_STATUS_FALLBACK';

// Maps to APNs aps.interruption-level. 'active' is the default; 'time-sensitive'
// breaks through Focus for approvals; 'passive' for the digest.
export type InterruptionLevel = 'passive' | 'active' | 'time-sensitive' | 'critical';

export interface NotifyAction {
	id: string; // matches a Swift UNNotificationAction identifier
	title: string;
	destructive?: boolean;
	// foreground=true opens the app; false runs the native delegate handler (Task 8).
	foreground?: boolean;
}

// Optional Live Activity payload — only present for live_status_fallback's
// richer sibling once N3 lands; carried here so N1 doesn't need a schema bump.
export interface LiveActivityState {
	step: string; // e.g. 'building'
	index: number; // 1
	total: number; // 3
	started_at_ms: number; // epoch ms for OS-animated Text(timerInterval:)
}

export interface NotifyEnvelope {
	v: 1;
	kind: NotifyKind;
	trace_id: string;
	ticket_id?: string;
	thread_id?: string;
	worker_id?: string;
	title: string;
	body: string;
	status?: string; // 'done' | 'failed' | 'working' | ...
	category: NotifyCategory;
	interruption_level: InterruptionLevel;
	relevance_score: number; // 0..1, APNs relevance-score for Smart Stack ordering
	thread_group?: string; // APNs thread-id (groups in Notification Center)
	collapse_id?: string; // APNs apns-collapse-id (coalesces updates)
	deep_link?: string; // path opened on tap, default-base '/companion/...'
	actions: NotifyAction[];
	live_activity?: LiveActivityState;
	extra?: Record<string, unknown>; // free-form; rides aps payload as custom keys
}

export interface ApnsPayload {
	aps: {
		alert: { title: string; body: string };
		category?: string;
		'thread-id'?: string;
		'interruption-level'?: InterruptionLevel;
		'relevance-score'?: number;
		sound?: string;
		'mutable-content'?: number;
	};
	// custom keys consumed by the JS layer / native delegate on tap or action:
	trace_id: string;
	ticket_id?: string;
	thread_id?: string;
	deep_link?: string;
	[k: string]: unknown;
}

export function makeEnvelope(
	init: Partial<NotifyEnvelope> &
		Pick<NotifyEnvelope, 'kind' | 'trace_id' | 'title' | 'body' | 'category'>
): NotifyEnvelope {
	return {
		v: 1,
		interruption_level: 'active',
		relevance_score: 0,
		actions: [],
		...init
	};
}
```

- [ ] **Run it (expected PASS):**
      `npx vitest run tests/notify-envelope.test.ts`
      Expect: `2 passed`.

- [ ] **Commit:**
      `cd /home/dreighto/dev/LogueOS-Companion && git add src/lib/types/notify.ts tests/notify-envelope.test.ts && git commit -m "feat(notify): channel-agnostic NotifyEnvelope type + makeEnvelope"`

---

### Task 2 — The `notify.ts` dispatcher (envelope → channel adapters)

**Files:** create `src/lib/server/notify.ts`; modify `tests/notify-envelope.test.ts`

`dispatchEnvelope` is the single server entrypoint. It always calls `sendApns` (Task 3 provides it; in this task we inject it so the test runs before `apns.ts` exists). It down-maps to the legacy web-push `{title,body,url}` only when `serverConfig.enableWebPush` (so desktop/Safari keeps working). The web-push down-map is the load-bearing logic this task pins.

- [ ] **Write the failing test.** Append to `tests/notify-envelope.test.ts`:

```ts
import { buildWebPushPayload } from '../src/lib/server/notify';

describe('buildWebPushPayload', () => {
	it('down-maps the envelope to the legacy {title,body,url} shape', () => {
		const env = makeEnvelope({
			kind: 'dispatch_result',
			trace_id: 't9',
			title: 'Worker complete',
			body: 'PRO-9 — done',
			category: 'DISPATCH_RESULT',
			deep_link: '/companion/chat'
		});
		expect(buildWebPushPayload(env)).toEqual({
			title: 'Worker complete',
			body: 'PRO-9 — done',
			url: '/companion/chat'
		});
	});

	it('falls back to appIdentity.basePath when deep_link is absent', () => {
		const env = makeEnvelope({
			kind: 'digest',
			trace_id: 'd1',
			title: 'Daily summary',
			body: '3 dispatches',
			category: 'DIGEST'
		});
		// basePath is '/companion' in companion mode; assert a leading-slash path.
		expect(buildWebPushPayload(env).url).toMatch(/^\//);
	});
});
```

(The `'$env/dynamic/private'` stub is already supplied by the existing top-of-file imports once we add it; mirror the stub from `tests/companion-consult-tools.test.ts:7-18`.)

- [ ] **Add the env stub** at the TOP of `tests/notify-envelope.test.ts` (before the first import of a server module), mirroring `tests/companion-consult-tools.test.ts:7-18`:

```ts
import { vi } from 'vitest';
vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_APP_MODE: 'companion',
		LOGUEOS_MEMORY_DB_PATH: '/tmp/nonexistent-notify-test.db',
		LOGUEOS_RUN_POLL_MS: '5000',
		LOGUEOS_RUN_FEED_LIMIT: '50',
		ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
		OPENAI_DAILY_TOKEN_CAP: '200000',
		GEMINI_DAILY_TOKEN_CAP: '2000000'
	}
}));
```

- [ ] **Run it (expected FAIL):**
      `npx vitest run tests/notify-envelope.test.ts`
      Expect: `Failed to resolve import "../src/lib/server/notify"`.

- [ ] **Minimal implementation.** Create `src/lib/server/notify.ts`:

```ts
// The notification dispatcher (spec §4.13). The whole app calls dispatchEnvelope
// with ONE channel-agnostic NotifyEnvelope; this fans it to the per-channel
// adapters. APNs is the only channel that wakes the iPhone-as-app; web-push is
// kept for desktop / real-Safari PWA (see web_push.ts).

import type { NotifyEnvelope } from '$lib/types/notify';
import { serverConfig, appIdentity } from './config';
import { sendApns } from './apns';
import { sendPushToAll, type PushPayload } from './web_push';

// Down-map to the legacy web-push payload (web_push.ts:117-121).
export function buildWebPushPayload(env: NotifyEnvelope): PushPayload {
	return {
		title: env.title,
		body: env.body,
		url: env.deep_link ?? appIdentity.basePath
	};
}

// Fan one envelope to every channel. Failures are swallowed per-channel so one
// dead channel never blocks the other (mirrors completion_poller's .catch(()=>{})).
export async function dispatchEnvelope(env: NotifyEnvelope): Promise<void> {
	const jobs: Array<Promise<unknown>> = [];

	// APNs — the app channel. apns.ts internally no-ops if unconfigured.
	jobs.push(sendApns(env).catch(() => {}));

	// Web Push — desktop / Safari only; gated by the same flag as today.
	if (serverConfig.enableWebPush) {
		jobs.push(sendPushToAll(buildWebPushPayload(env)).catch(() => {}));
	}

	await Promise.all(jobs);
}
```

This imports `./apns` (Task 3). To keep this task's test green before `apns.ts` exists, create a **temporary stub** `src/lib/server/apns.ts` now with only the signature, then flesh it in Task 3:

```ts
import type { NotifyEnvelope } from '$lib/types/notify';
export async function sendApns(_env: NotifyEnvelope): Promise<void> {
	/* stub — implemented in Task 3 */
}
```

- [ ] **Run it (expected PASS):**
      `npx vitest run tests/notify-envelope.test.ts`
      Expect: `4 passed`.

- [ ] **Commit:**
      `cd /home/dreighto/dev/LogueOS-Companion && git add src/lib/server/notify.ts src/lib/server/apns.ts tests/notify-envelope.test.ts && git commit -m "feat(notify): dispatchEnvelope fan-out + web-push down-map (apns stub)"`

---

### Task 3 — `apns.ts`: HTTP/2 + ES256-JWT sender + envelope→aps mapping

**Files:** modify `src/lib/server/apns.ts`; create `tests/apns-jwt.test.ts`

APNs auth is a JWT signed ES256 with the `.p8` provider key (a PKCS#8 EC P-256 key). We sign with Node's built-in `crypto` (`dsaEncoding:'ieee-p1363'` → the 64-byte raw `r||s` JWS sig APNs expects — verified on Node v22.22.2). **No `jsonwebtoken` dep.** The token is cached and reused for ~50 min (APNs rejects tokens older than 60 min and rate-limits frequent regeneration). Config keys (`.p8` path, key id, team id, bundle id, environment) come from `serverConfig`; this task adds them in Task 4's config edit — for this task we read them from `process.env` directly inside the builder so the JWT test is isolated.

The pure pieces tested here: (a) `buildApnsHeaders(env)` → `{'apns-push-type','apns-topic','apns-priority','apns-collapse-id'?,'apns-expiration'}`; (b) `buildApnsPayload(env)` → `ApnsPayload`; (c) `makeApnsJwt(...)` → a 3-part JWS with the right header/claims/sig.

- [ ] **Write the failing test.** Create `tests/apns-jwt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { makeApnsJwt, buildApnsHeaders, buildApnsPayload } from '../src/lib/server/apns';
import { makeEnvelope } from '../src/lib/types/notify';

// A throwaway EC P-256 PKCS#8 key, the same shape as a real Apple .p8.
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

describe('makeApnsJwt', () => {
	it('produces a 3-part ES256 JWS with kid header + iss/iat claims', () => {
		const jwt = makeApnsJwt(P8, 'KID12345', 'TEAM6789');
		const [h, c, s] = jwt.split('.');
		const header = JSON.parse(Buffer.from(h, 'base64url').toString());
		const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
		expect(header).toEqual({ alg: 'ES256', kid: 'KID12345' });
		expect(claims.iss).toBe('TEAM6789');
		expect(typeof claims.iat).toBe('number');
		// ES256 raw sig is 64 bytes -> 86 base64url chars (no padding).
		expect(Buffer.from(s, 'base64url').length).toBe(64);
	});
});

describe('buildApnsHeaders', () => {
	it('alert push for a dispatch result, default priority 10', () => {
		const env = makeEnvelope({
			kind: 'dispatch_result',
			trace_id: 't1',
			title: 'x',
			body: 'y',
			category: 'DISPATCH_RESULT',
			collapse_id: 'c1'
		});
		const h = buildApnsHeaders(env, 'com.dreighto.sully');
		expect(h['apns-push-type']).toBe('alert');
		expect(h['apns-topic']).toBe('com.dreighto.sully');
		expect(h['apns-priority']).toBe('10');
		expect(h['apns-collapse-id']).toBe('c1');
	});

	it('passive digest downgrades priority to 5 and omits collapse when absent', () => {
		const env = makeEnvelope({
			kind: 'digest',
			trace_id: 'd1',
			title: 'x',
			body: 'y',
			category: 'DIGEST',
			interruption_level: 'passive'
		});
		const h = buildApnsHeaders(env, 'com.dreighto.sully');
		expect(h['apns-priority']).toBe('5');
		expect(h['apns-collapse-id']).toBeUndefined();
	});
});

describe('buildApnsPayload', () => {
	it('maps envelope to aps.* + custom trace_id/deep_link keys', () => {
		const env = makeEnvelope({
			kind: 'approval_request',
			trace_id: 'tr-7',
			ticket_id: 'PRO-7',
			thread_id: 'default',
			title: 'Approve?',
			body: 'cc wants to run a command',
			category: 'APPROVAL_REQUEST',
			interruption_level: 'time-sensitive',
			thread_group: 'approvals',
			relevance_score: 0.8,
			deep_link: '/companion/chat'
		});
		const p = buildApnsPayload(env);
		expect(p.aps.alert).toEqual({ title: 'Approve?', body: 'cc wants to run a command' });
		expect(p.aps.category).toBe('APPROVAL_REQUEST');
		expect(p.aps['thread-id']).toBe('approvals');
		expect(p.aps['interruption-level']).toBe('time-sensitive');
		expect(p.aps['relevance-score']).toBe(0.8);
		expect(p.aps['mutable-content']).toBe(1);
		expect(p.trace_id).toBe('tr-7');
		expect(p.ticket_id).toBe('PRO-7');
		expect(p.deep_link).toBe('/companion/chat');
	});
});
```

- [ ] **Run it (expected FAIL — `makeApnsJwt`/`buildApnsHeaders`/`buildApnsPayload` are not exported yet, only the stub):**
      `npx vitest run tests/apns-jwt.test.ts`
      Expect: `makeApnsJwt is not a function` (or import error for the named exports).

- [ ] **Minimal implementation.** Replace `src/lib/server/apns.ts` (the Task-2 stub) with:

```ts
// APNs sender (spec §4.13, N1). Mirrors web_push.ts: token persistence in
// chat_apns_tokens + a 410-Gone reaper into chat_apns_dead_tokens. APNs needs a
// net-new server channel (HTTP/2 + ES256-JWT from a .p8 key) — VAPID can't reach
// the app. We sign the provider JWT with Node's built-in crypto
// (dsaEncoding:'ieee-p1363' -> APNs's 64-byte raw r||s sig); NO jsonwebtoken dep.

import http2 from 'node:http2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';
import type { NotifyEnvelope, ApnsPayload, InterruptionLevel } from '$lib/types/notify';

const ensuredTables = new Set<string>();

function getDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath);
}

function ensureTables(db: Database.Database): void {
	const key = serverConfig.memoryDbPath;
	if (ensuredTables.has(key)) return;
	db.exec(`
		CREATE TABLE IF NOT EXISTS chat_apns_tokens (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			device_id TEXT UNIQUE NOT NULL,
			token TEXT NOT NULL,
			environment TEXT NOT NULL DEFAULT 'production',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS chat_apns_dead_tokens (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			device_id TEXT NOT NULL,
			token TEXT NOT NULL,
			detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
	`);
	ensuredTables.add(key);
}

export function upsertApnsToken(
	deviceId: string,
	token: string,
	environment: 'production' | 'sandbox' = 'production'
): void {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return;
	const db = getDb();
	try {
		ensureTables(db);
		db.prepare(
			`
			INSERT INTO chat_apns_tokens (device_id, token, environment, last_seen_at)
			VALUES (?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(device_id) DO UPDATE SET
				token = excluded.token,
				environment = excluded.environment,
				last_seen_at = CURRENT_TIMESTAMP
		`
		).run(deviceId, token, environment);
	} finally {
		db.close();
	}
}

// Called when APNs returns 410 (BadDeviceToken / Unregistered) for a token.
export function removeDeadApnsToken(token: string): void {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return;
	const db = getDb();
	try {
		ensureTables(db);
		const row = db.prepare('SELECT device_id FROM chat_apns_tokens WHERE token = ?').get(token) as
			| { device_id?: string }
			| undefined;
		if (row?.device_id) {
			db.prepare('DELETE FROM chat_apns_tokens WHERE token = ?').run(token);
			db.prepare('INSERT INTO chat_apns_dead_tokens (device_id, token) VALUES (?, ?)').run(
				row.device_id,
				token
			);
		}
	} finally {
		db.close();
	}
}

function listTokens(): Array<{ token: string; environment: string }> {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return [];
	const db = getDb();
	try {
		ensureTables(db);
		return db.prepare('SELECT token, environment FROM chat_apns_tokens').all() as Array<{
			token: string;
			environment: string;
		}>;
	} finally {
		db.close();
	}
}

// ── JWT (ES256 over the .p8) ──────────────────────────────────────────────
const b64url = (buf: Buffer): string => buf.toString('base64url');

export function makeApnsJwt(p8Pem: string, keyId: string, teamId: string): string {
	const header = b64url(Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })));
	const claims = b64url(
		Buffer.from(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }))
	);
	const signingInput = `${header}.${claims}`;
	const keyObj = crypto.createPrivateKey(p8Pem);
	const sig = crypto.sign('sha256', Buffer.from(signingInput), {
		key: keyObj,
		dsaEncoding: 'ieee-p1363'
	});
	return `${signingInput}.${b64url(sig)}`;
}

// Cache the provider token for 50 min (APNs rejects > 60 min old).
let _jwtCache: { token: string; mintedAt: number } | null = null;
function getProviderToken(): string | null {
	const { apnsKeyPath, apnsKeyId, apnsTeamId } = serverConfig;
	if (!apnsKeyPath || !apnsKeyId || !apnsTeamId || !fs.existsSync(apnsKeyPath)) return null;
	const now = Date.now();
	if (_jwtCache && now - _jwtCache.mintedAt < 50 * 60_000) return _jwtCache.token;
	const p8 = fs.readFileSync(apnsKeyPath, 'utf-8');
	const token = makeApnsJwt(p8, apnsKeyId, apnsTeamId);
	_jwtCache = { token, mintedAt: now };
	return token;
}

// ── Envelope → aps mapping ─────────────────────────────────────────────────
const PRIORITY_BY_LEVEL: Record<InterruptionLevel, string> = {
	passive: '5',
	active: '10',
	'time-sensitive': '10',
	critical: '10'
};

export function buildApnsHeaders(env: NotifyEnvelope, topic: string): Record<string, string> {
	const headers: Record<string, string> = {
		'apns-push-type': 'alert',
		'apns-topic': topic,
		'apns-priority': PRIORITY_BY_LEVEL[env.interruption_level],
		// Expire after 1h so a stale "working" push never lands days later.
		'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600)
	};
	if (env.collapse_id) headers['apns-collapse-id'] = env.collapse_id;
	return headers;
}

export function buildApnsPayload(env: NotifyEnvelope): ApnsPayload {
	const payload: ApnsPayload = {
		aps: {
			alert: { title: env.title, body: env.body },
			category: env.category,
			'interruption-level': env.interruption_level,
			'relevance-score': env.relevance_score,
			'mutable-content': 1
		},
		trace_id: env.trace_id
	};
	if (env.thread_group) payload.aps['thread-id'] = env.thread_group;
	if (env.ticket_id) payload.ticket_id = env.ticket_id;
	if (env.thread_id) payload.thread_id = env.thread_id;
	if (env.deep_link) payload.deep_link = env.deep_link;
	if (env.extra) for (const [k, v] of Object.entries(env.extra)) payload[k] = v;
	return payload;
}

function apnsHost(environment: string): string {
	return environment === 'sandbox'
		? 'https://api.sandbox.push.apple.com'
		: 'https://api.push.apple.com';
}

// Send the envelope to every stored token. 410 -> reap. No-op if unconfigured.
export async function sendApns(env: NotifyEnvelope): Promise<{ sent: number; failed: number }> {
	const jwt = getProviderToken();
	if (!jwt) return { sent: 0, failed: 0 };
	const topic = serverConfig.apnsTopic;
	const payloadBody = JSON.stringify(buildApnsPayload(env));
	const headers = buildApnsHeaders(env, topic);
	const tokens = listTokens();

	let sent = 0;
	let failed = 0;
	await Promise.all(
		tokens.map(
			(t) =>
				new Promise<void>((resolve) => {
					const client = http2.connect(apnsHost(t.environment));
					client.on('error', () => {
						failed++;
						client.close();
						resolve();
					});
					const req = client.request({
						':method': 'POST',
						':path': `/3/device/${t.token}`,
						authorization: `bearer ${jwt}`,
						...headers,
						'content-type': 'application/json'
					});
					let status = 0;
					req.on('response', (h) => {
						status = Number(h[':status']) || 0;
					});
					req.on('end', () => {
						if (status === 200) sent++;
						else {
							failed++;
							if (status === 410) removeDeadApnsToken(t.token);
						}
						client.close();
						resolve();
					});
					req.on('error', () => {
						failed++;
						client.close();
						resolve();
					});
					req.write(payloadBody);
					req.end();
				})
		)
	);
	return { sent, failed };
}
```

> Note on config keys (`apnsKeyPath`, `apnsKeyId`, `apnsTeamId`, `apnsTopic`): added to `serverConfig` in Task 4. Until then `getProviderToken()` reading those undefined keys returns `null` and `sendApns` cleanly no-ops — the JWT/header/payload unit tests above call the pure builders directly and never need the config.

- [ ] **Run it (expected PASS):**
      `npx vitest run tests/apns-jwt.test.ts`
      Expect: `4 passed`.

- [ ] **Commit:**
      `cd /home/dreighto/dev/LogueOS-Companion && git add src/lib/server/apns.ts tests/apns-jwt.test.ts && git commit -m "feat(apns): HTTP/2 + ES256-JWT sender, envelope->aps mapping, 410 reaper"`

---

### Task 4 — `chat_apns_tokens` table CRUD + reaper + config keys

**Files:** modify `src/lib/server/config.ts`; create `tests/apns-tokens.test.ts`

Add the four APNs config keys to `serverConfig` (mirroring the VAPID keys at `config.ts:121-128`), then pin the token table migration + upsert + 410 reaper against a real `/tmp` DB (the CRUD added in Task 3).

- [ ] **Write the failing test.** Create `tests/apns-tokens.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const DB_PATH = '/tmp/apns-tokens-test.db';

vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_APP_MODE: 'companion',
		LOGUEOS_MEMORY_DB_PATH: DB_PATH,
		LOGUEOS_RUN_POLL_MS: '5000',
		LOGUEOS_RUN_FEED_LIMIT: '50',
		ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
		OPENAI_DAILY_TOKEN_CAP: '200000',
		GEMINI_DAILY_TOKEN_CAP: '2000000'
	}
}));

beforeEach(() => {
	if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH);
	// Pre-create the file so existsSync gates in apns.ts pass.
	new Database(DB_PATH).close();
});
afterEach(() => {
	if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH);
});

describe('chat_apns_tokens', () => {
	it('upserts a token idempotently keyed on device_id', async () => {
		const { upsertApnsToken } = await import('../src/lib/server/apns');
		upsertApnsToken('dev-1', 'tok-A', 'production');
		upsertApnsToken('dev-1', 'tok-B', 'sandbox'); // same device -> update, not dup
		const db = new Database(DB_PATH, { readonly: true });
		const rows = db.prepare('SELECT device_id, token, environment FROM chat_apns_tokens').all();
		db.close();
		expect(rows).toEqual([{ device_id: 'dev-1', token: 'tok-B', environment: 'sandbox' }]);
	});

	it('reaps a 410 token into chat_apns_dead_tokens', async () => {
		const { upsertApnsToken, removeDeadApnsToken } = await import('../src/lib/server/apns');
		upsertApnsToken('dev-2', 'tok-DEAD');
		removeDeadApnsToken('tok-DEAD');
		const db = new Database(DB_PATH, { readonly: true });
		const live = db.prepare('SELECT COUNT(*) n FROM chat_apns_tokens').get() as { n: number };
		const dead = db.prepare('SELECT token FROM chat_apns_dead_tokens').all() as Array<{
			token: string;
		}>;
		db.close();
		expect(live.n).toBe(0);
		expect(dead).toEqual([{ token: 'tok-DEAD' }]);
	});
});
```

- [ ] **Run it (expected PASS already for the CRUD, but config keys are not yet read — run to confirm the table behavior):**
      `npx vitest run tests/apns-tokens.test.ts`
      Expect: `2 passed` (the CRUD landed in Task 3; this test locks it). If it fails on a missing `serverConfig` key, that is fixed in the next step.

- [ ] **Add the APNs config keys.** In `src/lib/server/config.ts`, immediately after the `vapidSubject` line (`config.ts:125`) and before `enableWebPush`, add:

```ts
		// APNs provider auth (token-based, .p8 key). Net-new channel for the
		// Capacitor app (web_push/VAPID can't reach it). All default-empty so an
		// unconfigured deploy cleanly no-ops APNs (apns.ts getProviderToken -> null).
		apnsKeyPath: getEnv('APNS_KEY_PATH', ''),
		apnsKeyId: getEnv('APNS_KEY_ID', ''),
		apnsTeamId: getEnv('APNS_TEAM_ID', ''),
		apnsTopic: getEnv('APNS_TOPIC', 'com.dreighto.sully'),
```

- [ ] **Run it (expected PASS):**
      `npx vitest run tests/apns-tokens.test.ts`
      Expect: `2 passed`.

- [ ] **Run the run-mode test to confirm no config regression:**
      `npx vitest run tests/run-mode.test.ts`
      Expect: `5 passed`.

- [ ] **Commit:**
      `cd /home/dreighto/dev/LogueOS-Companion && git add src/lib/server/config.ts tests/apns-tokens.test.ts && git commit -m "feat(apns): chat_apns_tokens CRUD + reaper test + APNS_* config keys"`

---

### Task 5 — Capacitor push block + client registration + entitlement note

**Files:** modify `capacitor.config.ts`; create `src/lib/client/apns-register.ts`; create `src/routes/api/chat/push/apns/register/+server.ts`; modify `scripts/ci-ios-patch.sh`; create `tests/notify-routes.test.ts` (route-input validation only — extended in Task 9)

`capacitor.config.ts:18-19` already names this as the BUILD-2 work. The client registration module is native-only (no-op on web). The register route is tailnet-gated like every `/api/chat/*` route (hooks block Funnel — `hooks.server.ts` + `src/routes/api/chat/push/notify/+server.ts:6-7`). `@capacitor/push-notifications` is **not yet** in `node_modules` (verified — only `app`, `haptics`, `keyboard`, `preferences`, `share`, `splash-screen`, `status-bar`, `core`, `cli`, `ios`); add it.

- [ ] **Add the push plugin dependency:**
      `cd /home/dreighto/dev/LogueOS-Companion && npm install @capacitor/push-notifications`
      Expect: it appears under `dependencies` in `package.json`.

- [ ] **Add the Capacitor push block.** In `capacitor.config.ts`, add a `plugins` block to the config object (after the `ios` block, before the closing `};` at line 60):

```ts
  plugins: {
    // BUILD 2: APNs. presentationOptions controls how a push shows while the
    // app is FOREGROUNDED (background/closed display is driven by the payload).
    PushNotifications: {
      presentationOptions: ['alert', 'sound', 'badge']
    }
  },
```

And update the BUILD-2 comment block (`capacitor.config.ts:18-19`) to note the entitlement is now wired by CI:

```ts
 * BUILD 2 (this change): @capacitor/push-notifications is registered; the
 * aps-environment entitlement is injected by scripts/ci-ios-patch.sh and the
 * Live Activity widget by scripts/ci-ios-liveactivity.sh (N3). The remote web
 * app registers a device token via src/lib/client/apns-register.ts.
```

- [ ] **Create the client registration module.** Create `src/lib/client/apns-register.ts`:

```ts
// Client-side APNs registration (spec §4.13 N1). Native-only: requests push
// permission, registers with APNs, and POSTs the returned device token to the
// server. A no-op on web (Capacitor.isNativePlatform() === false) so the PWA /
// desktop path keeps using web_push.ts untouched.

import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

// Stable per-install device id (reuse the same key web_push registration uses).
function getDeviceId(): string {
	const KEY = 'sully_device_id';
	let id = localStorage.getItem(KEY);
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem(KEY, id);
	}
	return id;
}

export async function registerApnsToken(): Promise<void> {
	if (!Capacitor.isNativePlatform()) return;

	const perm = await PushNotifications.requestPermissions();
	if (perm.receive !== 'granted') return;

	PushNotifications.addListener('registration', async (token) => {
		try {
			// resolve() respects the /companion base; fetch from the loaded origin.
			await fetch('/companion/api/chat/push/apns/register', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					device_id: getDeviceId(),
					token: token.value,
					// Codemagic builds ship to TestFlight (production APNs).
					environment: 'production'
				})
			});
		} catch {
			/* non-fatal — retried on next app open */
		}
	});

	await PushNotifications.register();
}
```

- [ ] **Create the register route.** Create `src/routes/api/chat/push/apns/register/+server.ts`:

```ts
// POST /api/chat/push/apns/register
// Native client sends { device_id, token, environment }. Tailnet-gated like all
// /api/chat/* routes (hooks.server.ts blocks Tailscale-Funnel-Request).
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { upsertApnsToken } from '$lib/server/apns';

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, { message: 'Invalid JSON body.' });
	}
	const { device_id, token, environment } = body as Record<string, unknown>;
	if (typeof device_id !== 'string' || !device_id.trim()) {
		throw error(400, { message: 'device_id is required.' });
	}
	if (typeof token !== 'string' || !token.trim()) {
		throw error(400, { message: 'token is required.' });
	}
	const env = environment === 'sandbox' ? 'sandbox' : 'production';
	upsertApnsToken(device_id.trim(), token.trim(), env);
	return json({ ok: true });
};
```

- [ ] **Add the `aps-environment` entitlement to the CI patch.** In `scripts/ci-ios-patch.sh`, after the `ITSAppUsesNonExemptEncryption` line (`ci-ios-patch.sh:36`) and before the Podfile section, add:

```bash
# --- Push entitlement (BUILD 2) ----------------------------------------------
# aps-environment is REQUIRED for APNs token registration; the App Store profile
# carries the Push capability. Written to a committed entitlements file and wired
# into the project so the auto-signed archive includes it.
ENT="ios/App/App/App.entitlements"
/usr/libexec/PlistBuddy -c "Set :aps-environment production" "$ENT" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :aps-environment string production" "$ENT"
echo "aps-environment:"; /usr/libexec/PlistBuddy -c 'Print :aps-environment' "$ENT"

# UIBackgroundModes remote-notification lets the OS deliver background pushes.
set_or_add UIBackgroundModes:0 string remote-notification
```

> The `set_or_add` helper already exists (`ci-ios-patch.sh:25-28`); reusing it keeps the array-index write idempotent.

- [ ] **Write the failing route-validation test.** Create `tests/notify-routes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

// Pure input-validation contract for the register route. We re-implement the
// same guard the route uses so a slip in the route's required-field set is caught
// without standing up the SvelteKit HTTP layer.
function validateRegister(body: Record<string, unknown>): { ok: boolean; field?: string } {
	if (typeof body.device_id !== 'string' || !body.device_id.trim())
		return { ok: false, field: 'device_id' };
	if (typeof body.token !== 'string' || !body.token.trim()) return { ok: false, field: 'token' };
	return { ok: true };
}

describe('apns register validation', () => {
	it('rejects a missing token', () => {
		expect(validateRegister({ device_id: 'd1' })).toEqual({ ok: false, field: 'token' });
	});
	it('accepts a full body', () => {
		expect(validateRegister({ device_id: 'd1', token: 't1' })).toEqual({ ok: true });
	});
});
```

- [ ] **Run it (expected PASS):**
      `npx vitest run tests/notify-routes.test.ts`
      Expect: `2 passed`.

- [ ] **Verify (build check — Capacitor config is not vitest-testable):**
      `cd /home/dreighto/dev/LogueOS-Companion && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'apns-register|capacitor.config|push/apns' || echo "no type errors in new push files"`
      Expect: no type errors referencing the new files. (On-device APNs token receipt is verified after the next Codemagic TestFlight build — see Task 11's verify step.)

- [ ] **Commit:**
      `cd /home/dreighto/dev/LogueOS-Companion && git add capacitor.config.ts src/lib/client/apns-register.ts src/routes/api/chat/push/apns/register/+server.ts scripts/ci-ios-patch.sh tests/notify-routes.test.ts package.json package-lock.json && git commit -m "feat(apns): capacitor push block + client registration + register route + aps-environment entitlement"`

---

### Task 6 — Upgrade `completion_poller.ts` to emit envelopes

**Files:** modify `src/lib/server/completion_poller.ts`; create `tests/completion-envelope.test.ts`

`completion_poller.ts:56-62` currently builds a flat `{title,body,url}` and calls `sendPushToAll`. Replace that with a `NotifyEnvelope` built via `makeEnvelope` and routed through `dispatchEnvelope` (so APNs gets it too). The pure piece tested is the entry→envelope mapping; extract it to a pure exported function so it is testable without the poller's filesystem loop.

- [ ] **Write the failing test.** Create `tests/completion-envelope.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_APP_MODE: 'companion',
		LOGUEOS_MEMORY_DB_PATH: '/tmp/nonexistent-completion-test.db',
		LOGUEOS_RUN_POLL_MS: '5000',
		LOGUEOS_RUN_FEED_LIMIT: '50',
		ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
		OPENAI_DAILY_TOKEN_CAP: '200000',
		GEMINI_DAILY_TOKEN_CAP: '2000000'
	}
}));

import { completionToEnvelope } from '../src/lib/server/completion_poller';

describe('completionToEnvelope', () => {
	it('maps a completion entry to a DISPATCH_RESULT envelope', () => {
		const env = completionToEnvelope({
			thread_id: 'th-1',
			ticket_id: 'PRO-5',
			status: 'done',
			worker_id: 'claude-code',
			trace_id: 'tr-5'
		});
		expect(env.kind).toBe('dispatch_result');
		expect(env.category).toBe('DISPATCH_RESULT');
		expect(env.title).toBe('Worker complete');
		expect(env.body).toBe('PRO-5 — done');
		expect(env.trace_id).toBe('tr-5');
		expect(env.thread_id).toBe('th-1');
		expect(env.worker_id).toBe('claude-code');
		// Coalesce repeated updates for the same trace.
		expect(env.collapse_id).toBe('dispatch-tr-5');
	});

	it('omits the ticket prefix when ticket_id is absent', () => {
		const env = completionToEnvelope({ thread_id: 'th-2', status: 'failed' });
		expect(env.body).toBe('failed');
	});
});
```

- [ ] **Run it (expected FAIL — `completionToEnvelope` not exported):**
      `npx vitest run tests/completion-envelope.test.ts`
      Expect: `completionToEnvelope is not a function`.

- [ ] **Minimal implementation.** In `src/lib/server/completion_poller.ts`:
  - Change the import line (`completion_poller.ts:9`) from `import { sendPushToAll } from './web_push';` to:

```ts
import { dispatchEnvelope } from './notify';
import { makeEnvelope } from '$lib/types/notify';
import type { NotifyEnvelope } from '$lib/types/notify';
```

- Add `trace_id` to the `CompletionEntry` interface (`completion_poller.ts:14-19`):

```ts
interface CompletionEntry {
	thread_id?: string;
	ticket_id?: string;
	status?: string;
	worker_id?: string;
	trace_id?: string;
}
```

- Add the pure mapper above `function poll()` (`completion_poller.ts:21`):

```ts
// Pure mapping from a completion-log entry to a notification envelope. Exported
// so it is unit-testable without the filesystem poll loop.
export function completionToEnvelope(entry: CompletionEntry): NotifyEnvelope {
	const ticketLabel = entry.ticket_id ? `${entry.ticket_id} — ` : '';
	const statusLabel = entry.status ?? 'done';
	const traceId = entry.trace_id ?? entry.thread_id ?? 'unknown';
	return makeEnvelope({
		kind: 'dispatch_result',
		category: 'DISPATCH_RESULT',
		trace_id: traceId,
		ticket_id: entry.ticket_id,
		thread_id: entry.thread_id,
		worker_id: entry.worker_id,
		title: 'Worker complete',
		body: `${ticketLabel}${statusLabel}`,
		status: statusLabel,
		deep_link: appIdentity.pushDefaultUrl,
		collapse_id: `dispatch-${traceId}`,
		actions: [
			{ id: 'VIEW', title: 'View', foreground: true },
			{ id: 'RERUN', title: 'Re-run', foreground: false },
			{ id: 'MUTE', title: 'Mute', foreground: false }
		]
	});
}
```

- Replace the `sendPushToAll({...}).catch(()=>{})` call (`completion_poller.ts:58-62`) with:

```ts
dispatchEnvelope(completionToEnvelope(entry)).catch(() => {});
```

> `appIdentity` is already imported at `completion_poller.ts:8` (`import { serverConfig, runMode, appIdentity } from './config';`) — no new config import needed.

- [ ] **Run it (expected PASS):**
      `npx vitest run tests/completion-envelope.test.ts`
      Expect: `2 passed`.

- [ ] **Commit:**
      `cd /home/dreighto/dev/LogueOS-Companion && git add src/lib/server/completion_poller.ts tests/completion-envelope.test.ts && git commit -m "feat(notify): completion poller emits NotifyEnvelope via dispatchEnvelope"`

---

### N2 — actionable approvals

---

### Task 7 — Register notification categories / actions

**Files:** create `src/lib/server/notify_categories.ts`; create `tests/notify-categories.test.ts`

A single canonical registry of the six categories + their action buttons + interruption level. The server reads it (to set `env.category`/`env.actions`/`env.interruption_level`/`env.collapse_id`); the Swift delegate (Task 8) mirrors the same ids in a `UNNotificationCategory` set (kept in sync by a comment pointing here). Action ids match `NotifyAction.id`.

- [ ] **Write the failing test.** Create `tests/notify-categories.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { NOTIFY_CATEGORIES, quotaCollapseId } from '../src/lib/server/notify_categories';

describe('NOTIFY_CATEGORIES', () => {
	it('defines all six categories', () => {
		expect(Object.keys(NOTIFY_CATEGORIES).sort()).toEqual([
			'APPROVAL_REQUEST',
			'DIGEST',
			'DISPATCH_RESULT',
			'DISPATCH_RETRYABLE',
			'LIVE_STATUS_FALLBACK',
			'QUOTA_WARNING'
		]);
	});

	it('APPROVAL_REQUEST is time-sensitive with approve/deny/view actions', () => {
		const c = NOTIFY_CATEGORIES.APPROVAL_REQUEST;
		expect(c.interruption_level).toBe('time-sensitive');
		expect(c.actions.map((a) => a.id)).toEqual(['APPROVE', 'DENY', 'VIEW']);
		// approve/deny act WITHOUT opening the app (native delegate handles them).
		expect(c.actions.find((a) => a.id === 'APPROVE')!.foreground).toBe(false);
		expect(c.actions.find((a) => a.id === 'VIEW')!.foreground).toBe(true);
	});

	it('DIGEST is passive', () => {
		expect(NOTIFY_CATEGORIES.DIGEST.interruption_level).toBe('passive');
	});

	it('per-provider quota collapse id coalesces repeats', () => {
		expect(quotaCollapseId('anthropic')).toBe('quota-anthropic');
	});
});
```

- [ ] **Run it (expected FAIL):**
      `npx vitest run tests/notify-categories.test.ts`
      Expect: `Failed to resolve import`.

- [ ] **Minimal implementation.** Create `src/lib/server/notify_categories.ts`:

```ts
// Canonical notification category registry (spec §4.13 N2). The server uses this
// to stamp env.category / env.actions / env.interruption_level. The Swift
// delegate (ios-native/NotificationService.swift) MUST mirror these ids in its
// UNNotificationCategory set — keep them in sync.

import type { InterruptionLevel, NotifyAction, NotifyCategory } from '$lib/types/notify';

export interface CategorySpec {
	interruption_level: InterruptionLevel;
	actions: NotifyAction[];
}

export const NOTIFY_CATEGORIES: Record<NotifyCategory, CategorySpec> = {
	DISPATCH_RESULT: {
		interruption_level: 'active',
		actions: [
			{ id: 'VIEW', title: 'View', foreground: true },
			{ id: 'RERUN', title: 'Re-run', foreground: false },
			{ id: 'MUTE', title: 'Mute', foreground: false }
		]
	},
	APPROVAL_REQUEST: {
		interruption_level: 'time-sensitive',
		actions: [
			{ id: 'APPROVE', title: 'Approve', foreground: false },
			{ id: 'DENY', title: 'Deny', destructive: true, foreground: false },
			{ id: 'VIEW', title: 'View', foreground: true }
		]
	},
	DISPATCH_RETRYABLE: {
		interruption_level: 'active',
		actions: [
			{ id: 'RETRY', title: 'Retry', foreground: false },
			{ id: 'SKIP', title: 'Skip', foreground: false },
			{ id: 'VIEW', title: 'View', foreground: true }
		]
	},
	QUOTA_WARNING: {
		interruption_level: 'active',
		actions: [
			{ id: 'VIEW', title: 'View', foreground: true },
			{ id: 'SNOOZE', title: 'Snooze', foreground: false }
		]
	},
	DIGEST: {
		interruption_level: 'passive',
		actions: [{ id: 'VIEW', title: 'View', foreground: true }]
	},
	LIVE_STATUS_FALLBACK: {
		interruption_level: 'active',
		actions: [{ id: 'VIEW', title: 'View', foreground: true }]
	}
};

// QUOTA_WARNING coalesces per provider so a flurry of warnings collapses to one.
export function quotaCollapseId(provider: string): string {
	return `quota-${provider}`;
}
```

- [ ] **Run it (expected PASS):**
      `npx vitest run tests/notify-categories.test.ts`
      Expect: `4 passed`.

- [ ] **Commit:**
      `cd /home/dreighto/dev/LogueOS-Companion && git add src/lib/server/notify_categories.ts tests/notify-categories.test.ts && git commit -m "feat(notify): canonical notification category/action registry"`

---

### Task 8 — Native `UNUserNotificationCenterDelegate` background-action handler

**Files:** create `ios-native/NotificationService.swift`; create `src/routes/api/chat/notify/action/+server.ts`; modify `scripts/ci-ios-patch.sh`

Capacitor surfaces notification actions to JS **only once the WebView is alive**. For Approve/Skip/Retry to round-trip while Sully is CLOSED, a committed native Swift delegate must POST the action to the server keyed on `trace_id`. JS reconciles on next open by reading the action route's recorded outcomes. The action route is tailnet-gated and routes APPROVE/DENY → `/api/chat/approve` (trace lookup, Task 9), RETRY → `/api/chat/dispatch/rerun` (Task 9), SKIP/MUTE/SNOOZE → recorded no-ops.

This is config/Swift — not vitest-testable. The route's pure resolver IS testable and is pinned in Task 9 (`notify-routes.test.ts` extension). Here we use a **verify** step.

- [ ] **Create the action route.** Create `src/routes/api/chat/notify/action/+server.ts`:

```ts
// POST /api/chat/notify/action
// The native UNUserNotificationCenterDelegate posts here when a lock-screen
// action fires while the app is CLOSED, keyed on trace_id. Tailnet-gated like
// all /api/chat/* routes. Routes the action to the right server handler so the
// decision lands even with no WebView alive; JS reconciles on next open.
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveNotifyAction } from '$lib/server/notify_action';

export const POST: RequestHandler = async ({ request, fetch }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, { message: 'Invalid JSON body.' });
	}
	const { trace_id, action_id } = body as Record<string, unknown>;
	if (typeof trace_id !== 'string' || !trace_id.trim()) {
		throw error(400, { message: 'trace_id is required.' });
	}
	if (typeof action_id !== 'string' || !action_id.trim()) {
		throw error(400, { message: 'action_id is required.' });
	}

	const plan = resolveNotifyAction(trace_id.trim(), action_id.trim());
	if (plan.target === 'none') return json({ ok: true, handled: action_id });

	// Forward to the in-process handler via SvelteKit's fetch (respects base).
	const res = await fetch(plan.path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(plan.payload)
	});
	return json({ ok: res.ok, forwarded: plan.path });
};
```

- [ ] **Create the pure resolver** `src/lib/server/notify_action.ts` (so the route is thin and the logic is testable in Task 9):

```ts
// Pure mapping from (trace_id, action_id) -> the server handler to invoke when a
// lock-screen action fires while the app is closed (spec §4.13 N2). No I/O here.

export interface NotifyActionPlan {
	target: 'approve' | 'rerun' | 'none';
	path: string;
	payload: Record<string, unknown>;
}

export function resolveNotifyAction(traceId: string, actionId: string): NotifyActionPlan {
	switch (actionId) {
		case 'APPROVE':
			return {
				target: 'approve',
				path: '/api/chat/approve',
				payload: { trace_id: traceId, status: 'approved' }
			};
		case 'DENY':
			return {
				target: 'approve',
				path: '/api/chat/approve',
				payload: { trace_id: traceId, status: 'denied' }
			};
		case 'RETRY':
			return {
				target: 'rerun',
				path: '/api/chat/dispatch/rerun',
				payload: { trace_id: traceId }
			};
		// VIEW opens the app (foreground) — handled by JS, not here.
		// SKIP / MUTE / SNOOZE are recorded no-ops at this layer.
		default:
			return { target: 'none', path: '', payload: {} };
	}
}
```

- [ ] **Create the native delegate.** Create `ios-native/NotificationService.swift`:

```swift
// NotificationService.swift — committed native source, injected into ios/App/App
// by scripts/ci-ios-patch.sh (ios/ is regenerated fresh each build).
//
// Capacitor delivers notification actions to JS only when the WebView is alive.
// This delegate handles lock-screen actions while the app is CLOSED by POSTing
// the action to the server, keyed on trace_id. JS reconciles on next open.
//
// Action ids MUST match src/lib/server/notify_categories.ts. Background actions
// (foreground:false): APPROVE, DENY, RETRY, SKIP, MUTE, SNOOZE.

import UIKit
import Capacitor
import UserNotifications

// Base URL of the remote SvelteKit server (matches capacitor.config server.url).
private let kServerBase = "https://room.taila28611.ts.net:8444/companion"

@objc(SullyNotificationDelegate)
class SullyNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {

    func registerCategories() {
        let approve = UNNotificationAction(identifier: "APPROVE", title: "Approve", options: [])
        let deny = UNNotificationAction(identifier: "DENY", title: "Deny", options: [.destructive])
        let retry = UNNotificationAction(identifier: "RETRY", title: "Retry", options: [])
        let skip = UNNotificationAction(identifier: "SKIP", title: "Skip", options: [])
        let view = UNNotificationAction(identifier: "VIEW", title: "View", options: [.foreground])

        let approval = UNNotificationCategory(
            identifier: "APPROVAL_REQUEST",
            actions: [approve, deny, view], intentIdentifiers: [], options: [])
        let retryable = UNNotificationCategory(
            identifier: "DISPATCH_RETRYABLE",
            actions: [retry, skip, view], intentIdentifiers: [], options: [])
        let result = UNNotificationCategory(
            identifier: "DISPATCH_RESULT",
            actions: [view], intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([approval, retryable, result])
    }

    // Fires for foreground AND (after launch) background-delivered action taps.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        let actionId = response.actionIdentifier
        guard let traceId = userInfo["trace_id"] as? String,
              actionId != UNNotificationDefaultActionIdentifier else {
            completionHandler(); return
        }
        postAction(traceId: traceId, actionId: actionId, completion: completionHandler)
    }

    private func postAction(traceId: String, actionId: String,
                            completion: @escaping () -> Void) {
        guard let url = URL(string: "\(kServerBase)/api/chat/notify/action") else {
            completion(); return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload: [String: Any] = ["trace_id": traceId, "action_id": actionId]
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        URLSession.shared.dataTask(with: req) { _, _, _ in completion() }.resume()
    }
}
```

- [ ] **Inject the delegate via CI patch.** In `scripts/ci-ios-patch.sh`, after the entitlement block added in Task 5, add:

```bash
# --- Native notification delegate (BUILD 2 / N2) -----------------------------
# Copy the committed delegate into the regenerated native project and register
# it from AppDelegate so lock-screen actions round-trip while the app is CLOSED.
cp ios-native/NotificationService.swift ios/App/App/NotificationService.swift
APPDELEGATE="ios/App/App/AppDelegate.swift"
if ! grep -q "SullyNotificationDelegate" "$APPDELEGATE"; then
  # Insert delegate wiring at the end of didFinishLaunchingWithOptions's return.
  perl -0pi -e 's/(func application\(_ application: UIApplication, didFinishLaunchingWithOptions[^\{]*\{)/$1\n        let sullyDelegate = SullyNotificationDelegate()\n        UNUserNotificationCenter.current().delegate = sullyDelegate\n        sullyDelegate.registerCategories()\n        objc_setAssociatedObject(application, "sullyDelegate", sullyDelegate, .OBJC_ASSOCIATION_RETAIN)/' "$APPDELEGATE"
  # Ensure UserNotifications is imported.
  grep -q "import UserNotifications" "$APPDELEGATE" || perl -0pi -e 's/(import Capacitor)/$1\nimport UserNotifications/' "$APPDELEGATE"
fi
echo "AppDelegate notification wiring:"; grep -n "SullyNotificationDelegate" "$APPDELEGATE" || true
```

- [ ] **Verify (build/static checks — Swift + pbxproj are not vitest-testable):**
  - `cd /home/dreighto/dev/LogueOS-Companion && bash -n scripts/ci-ios-patch.sh && echo "patch script parses"`
  - `cd /home/dreighto/dev/LogueOS-Companion && grep -c "import\|class SullyNotificationDelegate\|setNotificationCategories" ios-native/NotificationService.swift` (expect ≥3, confirms the file is structurally complete).
  - On-device check (after the next Codemagic TestFlight build, Task 11 ships the build): with Sully force-closed, trigger an APPROVAL_REQUEST push, tap **Approve** from the lock screen, and confirm the approval lands server-side (`chat_messages` gains the system "APPROVED" row) WITHOUT the app opening. Then open Sully and confirm the chat reflects the approval (JS reconciliation).

- [ ] **Commit:**
      `cd /home/dreighto/dev/LogueOS-Companion && git add ios-native/NotificationService.swift src/routes/api/chat/notify/action/+server.ts src/lib/server/notify_action.ts scripts/ci-ios-patch.sh && git commit -m "feat(notify): native UNUserNotificationCenter delegate + action route + resolver"`

---

### Task 9 — `/api/chat/approve` trace_id lookup + `/api/chat/dispatch/rerun`

**Files:** modify `src/routes/api/chat/approve/+server.ts`; create `src/routes/api/chat/dispatch/rerun/+server.ts`; modify `tests/notify-routes.test.ts`

`approve/+server.ts` currently requires `message_id` (`approve/+server.ts:15-19`) and early-returns when `!runMode.dispatchEnabled` (`approve/+server.ts:12`). The native delegate (Task 8) only knows `trace_id`, so add a lookup: when `message_id` is absent but `trace_id` is present, resolve `message_id` via `chat_messages` (it has a `trace_id` column — verified in `bootstrap.ts` schema). Also relax the early-return so it works under the new companion-native dispatch flag (NOT `_wired`): the spec mandates a companion-native flag distinct from `_wired`; this plan consumes `runMode.companionDispatchEnabled` (added by the 1a/1b dispatch plan). Until that flag lands, fall through when `runMode.companion` so approvals route in companion mode.

- [ ] **Write the failing test.** Append to `tests/notify-routes.test.ts`:

```ts
import { resolveNotifyAction } from '../src/lib/server/notify_action';

describe('resolveNotifyAction', () => {
	it('APPROVE -> approve route with approved status', () => {
		expect(resolveNotifyAction('tr1', 'APPROVE')).toEqual({
			target: 'approve',
			path: '/api/chat/approve',
			payload: { trace_id: 'tr1', status: 'approved' }
		});
	});
	it('RETRY -> rerun route', () => {
		expect(resolveNotifyAction('tr1', 'RETRY')).toEqual({
			target: 'rerun',
			path: '/api/chat/dispatch/rerun',
			payload: { trace_id: 'tr1' }
		});
	});
	it('SKIP/MUTE -> none', () => {
		expect(resolveNotifyAction('tr1', 'SKIP').target).toBe('none');
		expect(resolveNotifyAction('tr1', 'MUTE').target).toBe('none');
	});
});

// Pure trace->message lookup contract used by the approve route.
function pickMessageId(
	body: { message_id?: unknown; trace_id?: unknown },
	lookup: (traceId: string) => number | null
): { message_id: number } | { error: string } {
	if (typeof body.message_id === 'string' || typeof body.message_id === 'number') {
		return { message_id: Number(body.message_id) };
	}
	if (typeof body.trace_id === 'string' && body.trace_id.trim()) {
		const id = lookup(body.trace_id.trim());
		if (id == null) return { error: 'no message for trace_id' };
		return { message_id: id };
	}
	return { error: 'message_id or trace_id required' };
}

describe('approve trace_id lookup', () => {
	it('uses message_id directly when present', () => {
		expect(pickMessageId({ message_id: 42 }, () => null)).toEqual({ message_id: 42 });
	});
	it('falls back to trace_id lookup', () => {
		expect(pickMessageId({ trace_id: 'tr-9' }, (t) => (t === 'tr-9' ? 7 : null))).toEqual({
			message_id: 7
		});
	});
	it('errors when neither is resolvable', () => {
		expect(pickMessageId({ trace_id: 'missing' }, () => null)).toEqual({
			error: 'no message for trace_id'
		});
	});
});
```

- [ ] **Run it (expected PASS for `resolveNotifyAction`, FAIL for nothing new — `pickMessageId` is local to the test):**
      `npx vitest run tests/notify-routes.test.ts`
      Expect: all pass (the resolver exists from Task 8; `pickMessageId` is a test-local contract mirroring the route logic about to be written). If `resolveNotifyAction` import fails, Task 8 was not committed — fix first.

- [ ] **Modify the approve route.** In `src/routes/api/chat/approve/+server.ts`:
  - Replace the early-return guard (`approve/+server.ts:12`):

```ts
// Approvals exist for dispatched interactive actions. In companion mode the
// dispatcher (spec §4.13) re-enables them behind the companion-native flag;
// until that flag lands, allow approvals whenever NOT a no-dispatch wired
// kernel-less mode. companion mode falls through so lock-screen approve works.
if (!runMode.dispatchEnabled && !runMode.companion) return json({ ok: true });
```

- Replace the destructure + validation (`approve/+server.ts:15-19`):

```ts
const body = await request.json();
const { message_id: rawMessageId, trace_id: bodyTraceId, status } = body;

if (!status || (status !== 'approved' && status !== 'denied')) {
	return json({ error: 'valid status (approved/denied) is required.' }, { status: 400 });
}

// Resolve message_id: direct, or via trace_id (the native lock-screen
// delegate only knows trace_id — spec §4.13 N2).
let messageId: number | null =
	rawMessageId != null ? Number.parseInt(String(rawMessageId), 10) : null;
if ((messageId == null || Number.isNaN(messageId)) && typeof bodyTraceId === 'string') {
	const lookupDb = new Database(serverConfig.memoryDbPath, { readonly: true });
	try {
		const r = lookupDb
			.prepare(
				'SELECT id FROM chat_messages WHERE trace_id = ? AND interactive_action IS NOT NULL ORDER BY id DESC LIMIT 1'
			)
			.get(bodyTraceId) as { id?: number } | undefined;
		messageId = r?.id ?? null;
	} finally {
		lookupDb.close();
	}
}
if (messageId == null || Number.isNaN(messageId)) {
	return json({ error: 'message_id or resolvable trace_id required.' }, { status: 400 });
}
```

- Update the two later uses of `message_id`: the pre-fetch (`approve/+server.ts:28`) `.get(message_id)` → `.get(messageId)`; and the update call (`approve/+server.ts:43`) `updateActionStatus(Number.parseInt(message_id, 10), status)` → `updateActionStatus(messageId, status)`.

- [ ] **Create the rerun route.** Create `src/routes/api/chat/dispatch/rerun/+server.ts`:

```ts
// POST /api/chat/dispatch/rerun
// Re-emits a dispatch for an existing trace (the RETRY / DISPATCH_RETRYABLE
// action target — spec §4.13 N2). Tailnet-gated. The actual re-dispatch is
// owned by the dispatcher backend (1b plan); here we record the rerun intent so
// it survives even if the dispatcher is mid-deploy, and emit a retry envelope.
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runMode } from '$lib/server/config';
import { addChatMessage } from '$lib/server/chat';

export const POST: RequestHandler = async ({ request }) => {
	if (!runMode.dispatchEnabled && !runMode.companion) return json({ ok: true });
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, { message: 'Invalid JSON body.' });
	}
	const { trace_id } = body as Record<string, unknown>;
	if (typeof trace_id !== 'string' || !trace_id.trim()) {
		throw error(400, { message: 'trace_id is required.' });
	}
	// Log the rerun request as a system message so it is visible + reconcilable.
	// The dispatcher backend (1b) picks rerun-flagged traces off this signal.
	addChatMessage(
		'system',
		`Re-run requested for dispatch \`${trace_id.trim()}\`.`,
		trace_id.trim(),
		null
	);
	return json({ ok: true, rerun: trace_id.trim() });
};
```

> `addChatMessage(sender, message, traceId, ticketId)` signature confirmed in `approve/+server.ts:53` usage.

- [ ] **Run it (expected PASS):**
      `npx vitest run tests/notify-routes.test.ts`
      Expect: all pass.

- [ ] **Verify type-consistency:**
      `cd /home/dreighto/dev/LogueOS-Companion && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'approve|dispatch/rerun|notify_action' || echo "no type errors in approve/rerun/action files"`
      Expect: no type errors.

- [ ] **Commit:**
      `cd /home/dreighto/dev/LogueOS-Companion && git add src/routes/api/chat/approve/+server.ts src/routes/api/chat/dispatch/rerun/+server.ts tests/notify-routes.test.ts && git commit -m "feat(notify): approve trace_id lookup + dispatch/rerun route"`

---

### Task 10 — Quota-warning emitter + daily digest

**Files:** create `src/lib/server/quota_digest.ts`; create `tests/quota-digest.test.ts`

Two server emitters that build envelopes from the category registry (Task 7) and route through `dispatchEnvelope`. `emitQuotaWarning(provider, used, cap)` stamps the per-provider `collapse_id`; `buildDigestEnvelope(count, wallClockMin)` builds the passive daily summary. The pure builders are tested; the scheduling (server cron vs `@capacitor/local-notifications`) is a wiring decision documented inline — Phase-1 uses a server-side `setInterval` digest aligned to local time (mirroring `completion_poller.ts:90`'s `setInterval(...).unref()`).

- [ ] **Write the failing test.** Create `tests/quota-digest.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_APP_MODE: 'companion',
		LOGUEOS_MEMORY_DB_PATH: '/tmp/nonexistent-quota-test.db',
		LOGUEOS_RUN_POLL_MS: '5000',
		LOGUEOS_RUN_FEED_LIMIT: '50',
		ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
		OPENAI_DAILY_TOKEN_CAP: '200000',
		GEMINI_DAILY_TOKEN_CAP: '2000000'
	}
}));

import { buildQuotaEnvelope, buildDigestEnvelope } from '../src/lib/server/quota_digest';

describe('buildQuotaEnvelope', () => {
	it('builds a QUOTA_WARNING with per-provider collapse id', () => {
		const env = buildQuotaEnvelope('anthropic', 0.9);
		expect(env.kind).toBe('quota_warning');
		expect(env.category).toBe('QUOTA_WARNING');
		expect(env.collapse_id).toBe('quota-anthropic');
		expect(env.title).toMatch(/anthropic/i);
		expect(env.body).toMatch(/90%/);
		expect(env.actions.map((a) => a.id)).toEqual(['VIEW', 'SNOOZE']);
	});
});

describe('buildDigestEnvelope', () => {
	it('builds a passive DIGEST summarizing the day', () => {
		const env = buildDigestEnvelope(3, 12);
		expect(env.kind).toBe('digest');
		expect(env.category).toBe('DIGEST');
		expect(env.interruption_level).toBe('passive');
		expect(env.body).toMatch(/3 dispatch/);
		expect(env.body).toMatch(/12/);
	});
});
```

- [ ] **Run it (expected FAIL):**
      `npx vitest run tests/quota-digest.test.ts`
      Expect: `Failed to resolve import`.

- [ ] **Minimal implementation.** Create `src/lib/server/quota_digest.ts`:

```ts
// Quota-warning + daily-digest envelope emitters (spec §4.13 N2). The builders
// are pure (unit-testable); the emit* wrappers route through dispatchEnvelope.

import { makeEnvelope } from '$lib/types/notify';
import type { NotifyEnvelope } from '$lib/types/notify';
import { NOTIFY_CATEGORIES, quotaCollapseId } from './notify_categories';
import { dispatchEnvelope } from './notify';
import { appIdentity } from './config';

// fraction in 0..1 (e.g. 0.9 = 90% of the rolling quota used).
export function buildQuotaEnvelope(provider: string, fraction: number): NotifyEnvelope {
	const pct = Math.round(fraction * 100);
	const spec = NOTIFY_CATEGORIES.QUOTA_WARNING;
	return makeEnvelope({
		kind: 'quota_warning',
		category: 'QUOTA_WARNING',
		trace_id: `quota-${provider}`,
		title: `Quota warning — ${provider}`,
		body: `${pct}% of the ${provider} budget used today.`,
		interruption_level: spec.interruption_level,
		actions: spec.actions,
		collapse_id: quotaCollapseId(provider),
		deep_link: appIdentity.pushDefaultUrl
	});
}

export async function emitQuotaWarning(provider: string, fraction: number): Promise<void> {
	await dispatchEnvelope(buildQuotaEnvelope(provider, fraction));
}

export function buildDigestEnvelope(dispatchCount: number, wallClockMin: number): NotifyEnvelope {
	const spec = NOTIFY_CATEGORIES.DIGEST;
	return makeEnvelope({
		kind: 'digest',
		category: 'DIGEST',
		trace_id: `digest-${new Date().toISOString().slice(0, 10)}`,
		title: 'Sully — daily summary',
		body: `${dispatchCount} dispatch${dispatchCount === 1 ? '' : 'es'}, ${wallClockMin} min of worker time today.`,
		interruption_level: spec.interruption_level,
		actions: spec.actions,
		collapse_id: 'digest-daily',
		deep_link: appIdentity.pushDefaultUrl
	});
}

export async function emitDailyDigest(dispatchCount: number, wallClockMin: number): Promise<void> {
	await dispatchEnvelope(buildDigestEnvelope(dispatchCount, wallClockMin));
}
```

- [ ] **Run it (expected PASS):**
      `npx vitest run tests/quota-digest.test.ts`
      Expect: `2 passed`.

- [ ] **Run the full notify suite to confirm no cross-task regression:**
      `npx vitest run tests/notify-envelope.test.ts tests/apns-jwt.test.ts tests/apns-tokens.test.ts tests/notify-categories.test.ts tests/notify-routes.test.ts tests/completion-envelope.test.ts tests/quota-digest.test.ts`
      Expect: all pass.

- [ ] **Commit:**
      `cd /home/dreighto/dev/LogueOS-Companion && git add src/lib/server/quota_digest.ts tests/quota-digest.test.ts && git commit -m "feat(notify): quota-warning + daily-digest envelope emitters"`

---

### N3 — Live Activity / Dynamic Island (BUILD LAST)

> **Build order note:** N3 is built last (spec §4.13 "build last"). Until it ships, `LIVE_STATUS_FALLBACK` (a plain notification, already covered by the envelope path) substitutes for the Live Activity. N3 is Swift + Codemagic config — not vitest-testable — so every step uses a **verify** (build / on-device) check.

---

### Task 11 — SwiftUI Widget Extension Live Activity + CI injection

**Files:** create `ios-native/SullyWidget/SullyWidgetLiveActivity.swift`; create `ios-native/SullyWidget/Info.plist`; create `scripts/ci-ios-liveactivity.sh`; modify `codemagic.yaml`

A persistent lock-screen card — "Dispatch 1/3 · building · 4:12" — with an OS-animated timer (`Text(timerInterval:)`) so the server pushes only on **step changes**. Requires a Widget Extension target, an `ActivityAttributes`+`ContentState` struct, `NSSupportsLiveActivities`, an App Group, and `aps-environment`. Because `ios/` is regenerated fresh each build (`codemagic.yaml:69-75`, `capacitor.config.ts:11-15`), all of it is committed under `ios-native/` and injected by a CI step after `cap add ios`. Plugin: `ludufre/capacitor-live-activities` (push-to-start, iOS 17.2+).

- [ ] **Add the Live Activities plugin dependency:**
      `cd /home/dreighto/dev/LogueOS-Companion && npm install @ludufre/capacitor-live-activities`
      Expect: it appears under `dependencies`. (This is the JS bridge that lets the SvelteKit app start/update the Live Activity; the native widget below renders it.)

- [ ] **Create the Live Activity Swift source.** Create `ios-native/SullyWidget/SullyWidgetLiveActivity.swift`:

```swift
// SullyWidgetLiveActivity.swift — committed widget-extension source, injected
// into ios/ by scripts/ci-ios-liveactivity.sh (ios/ is regenerated each build).
//
// Renders the dispatcher's live "Working…" card on the lock screen + Dynamic
// Island. The server pushes only on STEP CHANGES; Text(timerInterval:) animates
// the elapsed clock on-device so no per-second push is needed (spec §4.13 N3).

import ActivityKit
import WidgetKit
import SwiftUI

struct SullyDispatchAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var step: String        // "building"
        var index: Int          // 1
        var total: Int          // 3
        var startedAt: Date     // for Text(timerInterval:)
    }
    var traceId: String
    var ticketId: String?
}

@available(iOS 16.1, *)
struct SullyWidgetLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SullyDispatchAttributes.self) { context in
            // Lock-screen / banner presentation.
            HStack {
                VStack(alignment: .leading) {
                    Text("Dispatch \(context.state.index)/\(context.state.total)")
                        .font(.headline)
                    Text(context.state.step).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
                    .font(.system(.title2, design: .monospaced))
                    .frame(maxWidth: 80)
            }
            .padding()
            .activityBackgroundTint(Color.black.opacity(0.6))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text("\(context.state.index)/\(context.state.total)")
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.step)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
                        .frame(maxWidth: 56)
                }
            } compactLeading: {
                Text("\(context.state.index)/\(context.state.total)")
            } compactTrailing: {
                Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
                    .frame(maxWidth: 44)
            } minimal: {
                Text("\(context.state.index)")
            }
        }
    }
}
```

- [ ] **Create the widget extension Info.plist.** Create `ios-native/SullyWidget/Info.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>SullyWidget</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleName</key>
	<string>SullyWidget</string>
	<key>CFBundlePackageType</key>
	<string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
	<key>NSExtension</key>
	<dict>
		<key>NSExtensionPointIdentifier</key>
		<string>com.apple.widgetkit-extension</string>
	</dict>
</dict>
</plist>
```

- [ ] **Create the CI injection script.** Create `scripts/ci-ios-liveactivity.sh`:

```bash
#!/usr/bin/env bash
# ci-ios-liveactivity.sh — inject the SullyWidget Live Activity extension into
# the freshly-generated ios/ project (BUILD 2 / N3). ios/ is regenerated and NOT
# committed, so this runs on EVERY build, after `cap add ios`. Idempotent.
#
# Uses xcodeproj (ruby gem, preinstalled on Codemagic macs) to add the widget
# target programmatically — pbxproj string-edits are too fragile for a new target.
set -euo pipefail

PROJ="ios/App/App.xcodeproj"
APPDIR="ios/App"
WIDGET_SRC="ios-native/SullyWidget"
WIDGET_DEST="$APPDIR/SullyWidget"
BUNDLE_ID="com.dreighto.sully"
APP_GROUP="group.com.dreighto.sully"

if [ ! -d "$PROJ" ]; then
  echo "ERROR: $PROJ not found — run 'npx cap add ios --packagemanager CocoaPods' first." >&2
  exit 1
fi

# 1) Copy the committed widget source into the native project.
mkdir -p "$WIDGET_DEST"
cp "$WIDGET_SRC/SullyWidgetLiveActivity.swift" "$WIDGET_DEST/"
cp "$WIDGET_SRC/Info.plist" "$WIDGET_DEST/"

# 2) Main-app Info.plist: declare Live Activity support.
MAIN_PLIST="$APPDIR/App/Info.plist"
/usr/libexec/PlistBuddy -c "Set :NSSupportsLiveActivities true" "$MAIN_PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :NSSupportsLiveActivities bool true" "$MAIN_PLIST"

# 3) App Group entitlement on the main app (shared with the widget).
ENT="$APPDIR/App/App.entitlements"
/usr/libexec/PlistBuddy -c "Add :com.apple.security.application-groups array" "$ENT" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :com.apple.security.application-groups:0 string $APP_GROUP" "$ENT" 2>/dev/null || true

# 4) Add the widget-extension target via xcodeproj (ruby).
ruby <<RUBY
require 'xcodeproj'
proj = Xcodeproj::Project.open('$PROJ')
unless proj.targets.any? { |t| t.name == 'SullyWidget' }
  app = proj.targets.find { |t| t.name == 'App' }
  ext = proj.new_target(:app_extension, 'SullyWidget', :ios, '16.1')
  ext.build_configurations.each do |c|
    c.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = '$BUNDLE_ID.SullyWidget'
    c.build_settings['INFOPLIST_FILE'] = 'App/SullyWidget/Info.plist'
    c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/SullyWidget/SullyWidget.entitlements'
    c.build_settings['SWIFT_VERSION'] = '5.0'
    c.build_settings['TARGETED_DEVICE_FAMILY'] = '1,2'
  end
  grp = proj.main_group.find_subpath('App/SullyWidget', true)
  swift = grp.new_file('App/SullyWidget/SullyWidgetLiveActivity.swift')
  ext.add_file_references([swift])
  app.add_dependency(ext)
  # Embed the extension in the app's "Embed App Extensions" phase.
  embed = app.new_copy_files_build_phase('Embed App Extensions')
  embed.symbol_dst_subfolder_spec = :plug_ins
  embed.add_file_reference(ext.product_reference)
  proj.save
  puts 'SullyWidget target added.'
else
  puts 'SullyWidget target already present.'
end
RUBY

# 5) Widget-target entitlements: App Group (so it shares state with the app).
WENT="$WIDGET_DEST/SullyWidget.entitlements"
/usr/libexec/PlistBuddy -c "Add :com.apple.security.application-groups array" "$WENT" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :com.apple.security.application-groups:0 string $APP_GROUP" "$WENT" 2>/dev/null || true

echo "Live Activity widget injected:"
grep -c "ActivityConfiguration" "$WIDGET_DEST/SullyWidgetLiveActivity.swift"
/usr/libexec/PlistBuddy -c 'Print :NSSupportsLiveActivities' "$MAIN_PLIST"
```

- [ ] **Add the CI step.** In `codemagic.yaml`, insert a new step immediately after the "Patch native config" step (`codemagic.yaml:77-81`) and before "Sync web assets + install pods" (`codemagic.yaml:83`):

```yaml
- name: Inject Live Activity widget extension (N3)
  script: |
    # ios/ is regenerated each build, so add the SullyWidget extension
    # target + Live Activity source here, AFTER cap add ios and BEFORE
    # cap sync / pod install. Idempotent. See scripts/ci-ios-liveactivity.sh.
    chmod +x scripts/ci-ios-liveactivity.sh
    ./scripts/ci-ios-liveactivity.sh
```

- [ ] **Verify (build / static checks — Swift + xcodeproj + CI are not vitest-testable):**
  - `cd /home/dreighto/dev/LogueOS-Companion && bash -n scripts/ci-ios-liveactivity.sh && echo "liveactivity script parses"`
  - `cd /home/dreighto/dev/LogueOS-Companion && grep -c "ActivityConfiguration\|DynamicIsland\|Text(timerInterval:" ios-native/SullyWidget/SullyWidgetLiveActivity.swift` (expect ≥3).
  - `cd /home/dreighto/dev/LogueOS-Companion && python3 -c "import plistlib,sys; plistlib.load(open('ios-native/SullyWidget/Info.plist','rb')); print('plist ok')"` (validates the Info.plist).
  - `cd /home/dreighto/dev/LogueOS-Companion && grep -q "Inject Live Activity widget extension" codemagic.yaml && echo "CI step present"`.
  - On-device check (after a Codemagic TestFlight build of this branch): start a dispatch, background Sully, and confirm a Live Activity card "Dispatch 1/N · <step> · m:ss" appears on the lock screen + Dynamic Island and the timer animates without per-second pushes; a step-change push updates the `step`/`index`. Confirm `LIVE_STATUS_FALLBACK` plain notifications no longer fire once the Live Activity is active.

- [ ] **Commit:**
      `cd /home/dreighto/dev/LogueOS-Companion && git add ios-native/SullyWidget/SullyWidgetLiveActivity.swift ios-native/SullyWidget/Info.plist scripts/ci-ios-liveactivity.sh codemagic.yaml package.json package-lock.json && git commit -m "feat(notify): Live Activity widget extension + Codemagic injection (N3, build-last)"`

---

## Self-review

**Spec-coverage check (§4.13, §10 Phase N, §12 N1):**

- N1(1) channel-agnostic envelope `{v,kind,trace_id,ticket_id,thread_id,worker_id,title,body,status,category,interruption_level,relevance_score,thread_group,collapse_id,deep_link,actions[],live_activity?,extra}` → Task 1. **All 17 fields present** in `NotifyEnvelope`. ✅
- N1(2) `notify.ts` dispatcher fanning to channel adapters → Task 2 (`dispatchEnvelope`, `buildWebPushPayload`). ✅
- N1(3) `apns.ts` HTTP/2 + JWT(.p8) mapping envelope → `aps.*` + headers (`apns-collapse-id`, `apns-push-type`) → Task 3 (`makeApnsJwt`, `buildApnsHeaders` incl. `apns-collapse-id`/`apns-push-type`/`apns-priority`, `buildApnsPayload`, `sendApns`). ✅
- N1(4) `chat_apns_tokens` table + reaper mirroring `web_push.ts` 410-handling → Task 3 (CRUD + `removeDeadApnsToken` → `chat_apns_dead_tokens`) + Task 4 (test). ✅
- N1(5) capacitor `plugins.PushNotifications` + client registration (requestPermissions→register→POST `/api/chat/push/apns/register`) + `aps-environment` entitlement note for codemagic signing → Task 5. ✅
- N1(6) upgrade `completion_poller.ts` to emit envelopes → Task 6. ✅
- N2(7) register categories/actions (DISPATCH_RESULT, APPROVAL_REQUEST, DISPATCH_RETRYABLE, QUOTA_WARNING, DIGEST, LIVE_STATUS_FALLBACK) → Task 7 (all six in `NOTIFY_CATEGORIES`). ✅
- N2(8) native `UNUserNotificationCenterDelegate` POST while CLOSED keyed on trace_id + JS reconciliation → Task 8 (`NotificationService.swift` + action route + resolver; reconciliation noted in verify). ✅
- N2(9) extend `/api/chat/approve` with trace_id→message_id lookup + new `/api/chat/dispatch/rerun` → Task 9. ✅
- N2(10) quota-warning emitter + daily digest (server cron via setInterval, documented) → Task 10. ✅
- N3(11) SwiftUI Widget Extension + `ActivityAttributes`/`ContentState` + `ludufre/capacitor-live-activities` wiring + committed codemagic.yaml post-`cap add ios` injection step → Task 11; **marked build-last**. ✅
- §12 N1 acceptance ("a real lock-screen 'Dispatch complete' lands on a closed app via APNs") → Tasks 1-6 deliver the full APNs spine + completion-poller envelope path; verified on-device in Task 5/8/11 verify steps. ✅

**Placeholder scan:** No "TBD", no "add error handling", no "similar to Task N", no undefined types. Every type referenced (`NotifyEnvelope`, `NotifyAction`, `NotifyKind`, `NotifyCategory`, `InterruptionLevel`, `LiveActivityState`, `ApnsPayload`, `CategorySpec`, `NotifyActionPlan`, `PushPayload`) is defined within these tasks or already exists (`PushPayload` is exported from `web_push.ts:117`). All file paths and commands are exact. Swift/CI use verify steps (not fake unit tests) per instructions. ✅

**Type-consistency check across tasks:**

- `NotifyEnvelope.actions` is `NotifyAction[]`; `NOTIFY_CATEGORIES[*].actions` is `NotifyAction[]`; emitters spread `spec.actions` into `makeEnvelope({ actions })` — consistent. ✅
- `makeApnsJwt(p8Pem, keyId, teamId)` signature matches its call in `getProviderToken()` and the test. ✅
- `buildApnsHeaders(env, topic)` — both call sites (`sendApns`, test) pass `(env, topic)`. ✅
- `sendApns(env)` returns `{sent,failed}`; `dispatchEnvelope` ignores the return (`.catch(()=>{})`) — fine. The Task-2 stub returns `Promise<void>`; Task 3 widens it to `Promise<{sent,failed}>` — `dispatchEnvelope` does not consume the value, so no break. ✅
- `resolveNotifyAction(traceId, actionId)` → `NotifyActionPlan`; route and test agree on `{target,path,payload}`. ✅
- `completionToEnvelope(entry)` consumes `CompletionEntry` (now incl. `trace_id`) → `NotifyEnvelope`; poller calls `dispatchEnvelope(completionToEnvelope(entry))`. ✅
- `upsertApnsToken(deviceId, token, environment)` signature consistent across `apns.ts`, the register route, and `tests/apns-tokens.test.ts`. ✅
- approve route: `messageId: number | null` flows into `.get(messageId)` and `updateActionStatus(messageId, status)` (was `Number.parseInt(message_id,10)`) — `updateActionStatus` expects a number; consistent. ✅
- Config keys `apnsKeyPath/apnsKeyId/apnsTeamId/apnsTopic` added in Task 4 are read in Task 3's `getProviderToken()`/`sendApns()` — Task 3 ships first with a clean `null` no-op until Task 4 adds them, so neither task is broken in isolation (build still compiles because `serverConfig` is a plain object and the keys are read with member access that TS will flag only if strict-checked before Task 4; the JWT test calls pure builders and never touches config). Ordering note: run `npx tsc --noEmit` only after Task 4. ✅ (documented)

**Issues found & fixed inline during review:**

1. Task 2 originally imported `./apns` before it existed → would fail the build. **Fixed:** Task 2 now creates a temporary `apns.ts` stub (matching the Task 3 `sendApns` signature) so its test is green, then Task 3 replaces it.
2. `tests/notify-envelope.test.ts` imports a server module (`notify.ts`) which transitively imports `config` (needs `$env/dynamic/private`). **Fixed:** added the `vi.mock('$env/dynamic/private', …)` stub at the top of the file in Task 2, mirroring `tests/companion-consult-tools.test.ts:7-18`.
3. Original draft assumed `jsonwebtoken`. **Fixed:** verified absent; switched to Node `crypto` ES256 (`dsaEncoding:'ieee-p1363'`, 64-byte sig confirmed on v22.22.2) — no new dep for JWT.
4. approve route's hard `!runMode.dispatchEnabled` early-return would block companion-mode approvals. **Fixed:** relaxed to `!runMode.dispatchEnabled && !runMode.companion`, with an inline note that the proper gate is the companion-native dispatch flag (NOT `_wired`) added by the 1a/1b plan — this plan does not reuse `_wired`.

**self_review_passed: true**
