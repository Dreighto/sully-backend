// Server-side Web Push library (PR 6).
// Wraps the `web-push` npm package with VAPID auth, subscription persistence,
// and a dead-sub reaper (iOS provides no client-side pushsubscriptionchange
// signal — the server must detect 403/410 and flag dead subs for re-prompt).
//
// VAPID subject is hard-coded to mailto:dreighto@gmail.com per Decision Log
// entry 10 — Apple returns 403 on bare-domain subjects.

import webpush from 'web-push';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { serverConfig, appIdentity } from './config';

let vapidConfigured = false;
const ensuredTables = new Set<string>();

function getDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath);
}

function ensureTables(db: Database.Database): void {
	const key = serverConfig.memoryDbPath;
	if (ensuredTables.has(key)) return;
	db.exec(`
		CREATE TABLE IF NOT EXISTS chat_web_push_subscriptions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			device_id TEXT UNIQUE NOT NULL,
			subscription_json TEXT NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS chat_dead_subscriptions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			device_id TEXT NOT NULL,
			endpoint TEXT NOT NULL,
			detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			re_prompted_at TIMESTAMP NULL
		);
	`);
	ensuredTables.add(key);
}

function configureVapid(): boolean {
	if (vapidConfigured) return true;
	const { vapidPublicKey, vapidPrivateKey, vapidSubject } = serverConfig;
	if (!vapidPublicKey || !vapidPrivateKey) {
		console.warn(
			'[web_push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set. ' +
				'Run tools/generate_vapid_keys.js to generate them.'
		);
		return false;
	}
	webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
	vapidConfigured = true;
	return true;
}

export function upsertSubscription(deviceId: string, subscriptionJson: string): void {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return;
	const db = getDb();
	try {
		ensureTables(db);
		db.prepare(
			`
			INSERT INTO chat_web_push_subscriptions (device_id, subscription_json, last_seen_at)
			VALUES (?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(device_id) DO UPDATE SET
				subscription_json = excluded.subscription_json,
				last_seen_at = CURRENT_TIMESTAMP
		`
		).run(deviceId, subscriptionJson);
	} finally {
		db.close();
	}
}

export function removeSubscription(deviceId: string): void {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return;
	const db = getDb();
	try {
		ensureTables(db);
		db.prepare('DELETE FROM chat_web_push_subscriptions WHERE device_id = ?').run(deviceId);
	} finally {
		db.close();
	}
}

// Called when sendPush returns 403 or 410 for a given endpoint.
// Deletes the subscription and records the dead-sub so the Settings page
// can surface a re-subscribe banner to the operator.
export function removeDeadSubscription(endpoint: string): void {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return;
	const db = getDb();
	try {
		ensureTables(db);
		const rows = db
			.prepare('SELECT device_id, subscription_json FROM chat_web_push_subscriptions')
			.all() as Array<{ device_id: string; subscription_json: string }>;
		for (const row of rows) {
			try {
				const sub = JSON.parse(row.subscription_json) as { endpoint?: string };
				if (sub.endpoint === endpoint) {
					db.prepare('DELETE FROM chat_web_push_subscriptions WHERE device_id = ?').run(
						row.device_id
					);
					db.prepare('INSERT INTO chat_dead_subscriptions (device_id, endpoint) VALUES (?, ?)').run(
						row.device_id,
						endpoint
					);
				}
			} catch {
				// skip rows with malformed subscription JSON
			}
		}
	} finally {
		db.close();
	}
}

export interface PushPayload {
	title: string;
	body: string;
	url?: string;
	/** Badge count for APNs (forwarded by sendApnsToAll; ignored by web push). */
	badge?: number;
	/**
	 * Notification grouping key. For APNs this becomes aps.thread-id (forwarded
	 * by sendApnsToAll). For web push this becomes the `tag` field, which
	 * collapses multiple notifications from the same thread into one entry in
	 * the notification tray.
	 */
	threadGroupId?: string;
}

// Send a push to a single subscription.
// Payload is sent in a format that supports both:
//   - iOS 18.4+ Declarative Web Push (Apple displays without invoking SW)
//   - Service worker push fallback (older Safari / Chrome / Firefox)
// On 403/410, the endpoint is reaped and flagged for re-prompt.
export async function sendPush(
	subscription: webpush.PushSubscription,
	payload: PushPayload
): Promise<void> {
	if (!configureVapid()) return;

	// Root-level title/body/icon satisfies both declarative iOS display and the
	// SW event.data.json() read path. data.url is for the notificationclick handler.
	// tag: collapses multiple notifications from the same thread into one entry
	// in the notification tray (web push equivalent of APNs thread-id).
	const bodyObj: Record<string, unknown> = {
		title: payload.title,
		body: payload.body,
		icon: appIdentity.pushIconUrl,
		data: { url: payload.url ?? appIdentity.basePath }
	};
	if (payload.threadGroupId) bodyObj.tag = payload.threadGroupId;
	const body = JSON.stringify(bodyObj);

	try {
		await webpush.sendNotification(subscription, body);
	} catch (err: unknown) {
		const status = (err as { statusCode?: number }).statusCode;
		if (status === 403 || status === 410) {
			removeDeadSubscription(subscription.endpoint);
		}
		throw err;
	}
}

// Send to all stored subscriptions. Returns counts for logging.
export async function sendPushToAll(
	payload: PushPayload
): Promise<{ sent: number; failed: number }> {
	if (!serverConfig.enableWebPush) return { sent: 0, failed: 0 };
	if (!fs.existsSync(serverConfig.memoryDbPath)) return { sent: 0, failed: 0 };

	const db = getDb();
	let rows: Array<{ device_id: string; subscription_json: string }>;
	try {
		ensureTables(db);
		rows = db
			.prepare('SELECT device_id, subscription_json FROM chat_web_push_subscriptions')
			.all() as Array<{ device_id: string; subscription_json: string }>;
	} finally {
		db.close();
	}

	let sent = 0;
	let failed = 0;
	await Promise.all(
		rows.map(async (row) => {
			try {
				const sub = JSON.parse(row.subscription_json) as webpush.PushSubscription;
				await sendPush(sub, payload);
				sent++;
			} catch {
				failed++;
			}
		})
	);
	return { sent, failed };
}

// Queries for dead subscriptions that haven't been re-prompted yet.
// The Settings page polls this to surface the re-subscribe banner.
export function getPendingDeadSubs(): Array<{
	device_id: string;
	endpoint: string;
	detected_at: string;
}> {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return [];
	const db = getDb();
	try {
		ensureTables(db);
		return db
			.prepare(
				'SELECT device_id, endpoint, detected_at FROM chat_dead_subscriptions WHERE re_prompted_at IS NULL ORDER BY detected_at DESC'
			)
			.all() as Array<{ device_id: string; endpoint: string; detected_at: string }>;
	} finally {
		db.close();
	}
}

export function markDeadSubRePrompted(deviceId: string): void {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return;
	const db = getDb();
	try {
		ensureTables(db);
		db.prepare(
			'UPDATE chat_dead_subscriptions SET re_prompted_at = CURRENT_TIMESTAMP WHERE device_id = ?'
		).run(deviceId);
	} finally {
		db.close();
	}
}

export function getSubscriptionCount(): number {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return 0;
	const db = getDb();
	try {
		ensureTables(db);
		const row = db.prepare('SELECT COUNT(*) as count FROM chat_web_push_subscriptions').get() as {
			count: number;
		};
		return row.count;
	} finally {
		db.close();
	}
}
