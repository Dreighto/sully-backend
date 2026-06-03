// Native APNs (Apple Push Notification service) sender. Delivers task-completion
// pushes to the Capacitor / TestFlight Sully app — which runs its service worker
// inert, so Web Push can't reach it.
//
// Zero new deps: the provider JWT (ES256) is signed with node's built-in crypto
// against the APNs Auth Key (.p8), and delivery uses node's built-in http2.
//
// SELF-GATING: every entry point is a no-op unless serverConfig.apnsKeyPath +
// apnsKeyId are set AND the .p8 exists. So this is safe to call from the task
// completion hook before the operator has dropped credentials — it just does
// nothing until configured.
//
// Token storage: device APNs tokens arrive via POST /api/chat/push/apns-register
// and live in chat_apns_tokens. A 410 from APNs (Unregistered) reaps the token,
// mirroring the Web Push dead-subscription reaper.

import fs from 'node:fs';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { serverConfig } from './config';

export interface ApnsPayload {
	title: string;
	body: string;
	/** Deep-link path opened on tap (e.g. /companion/chat). */
	url?: string;
}

function getDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath);
}

function ensureTable(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS chat_apns_tokens (
			device_id  TEXT PRIMARY KEY,
			token      TEXT NOT NULL,
			updated_at TEXT DEFAULT CURRENT_TIMESTAMP
		);
	`);
}

/** True only when the operator has provided the .p8 + key id and the file exists. */
export function apnsConfigured(): boolean {
	return (
		!!serverConfig.apnsKeyPath &&
		!!serverConfig.apnsKeyId &&
		!!serverConfig.apnsTeamId &&
		fs.existsSync(serverConfig.apnsKeyPath)
	);
}

export function upsertApnsToken(deviceId: string, token: string): void {
	if (!deviceId || !token) return;
	const db = getDb();
	try {
		ensureTable(db);
		db.prepare(
			`INSERT INTO chat_apns_tokens (device_id, token, updated_at)
			 VALUES (?, ?, CURRENT_TIMESTAMP)
			 ON CONFLICT(device_id) DO UPDATE SET token = excluded.token, updated_at = CURRENT_TIMESTAMP`
		).run(deviceId, token);
	} finally {
		db.close();
	}
}

function removeApnsToken(token: string): void {
	const db = getDb();
	try {
		ensureTable(db);
		db.prepare('DELETE FROM chat_apns_tokens WHERE token = ?').run(token);
	} finally {
		db.close();
	}
}

function allTokens(): string[] {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return [];
	const db = getDb();
	try {
		ensureTable(db);
		return (db.prepare('SELECT token FROM chat_apns_tokens').all() as { token: string }[]).map(
			(r) => r.token
		);
	} finally {
		db.close();
	}
}

function base64url(buf: Buffer): string {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// APNs provider JWT (ES256). APNs rejects tokens older than 1h, so cache + reuse
// for ~50 min. Signing a fresh token per request would trip APNs's new-token
// rate limit.
let _jwtCache: { token: string; mintedAt: number } | null = null;
const JWT_TTL_MS = 50 * 60 * 1000;

function buildProviderJwt(): string {
	if (_jwtCache && Date.now() - _jwtCache.mintedAt < JWT_TTL_MS) return _jwtCache.token;
	const key = fs.readFileSync(serverConfig.apnsKeyPath, 'utf8');
	const header = base64url(
		Buffer.from(JSON.stringify({ alg: 'ES256', kid: serverConfig.apnsKeyId }))
	);
	const claims = base64url(
		Buffer.from(
			JSON.stringify({ iss: serverConfig.apnsTeamId, iat: Math.floor(Date.now() / 1000) })
		)
	);
	const signingInput = `${header}.${claims}`;
	// ES256 = ECDSA P-256 + SHA-256, JOSE (raw r||s) signature encoding.
	const der = crypto.createSign('SHA256').update(signingInput).sign({
		key,
		dsaEncoding: 'ieee-p1363'
	});
	const token = `${signingInput}.${base64url(der)}`;
	_jwtCache = { token, mintedAt: Date.now() };
	return token;
}

interface ApnsSendResult {
	status: number;
	/** APNs reason string on failure (e.g. 'BadDeviceToken', 'Unregistered'). */
	reason?: string;
}

/** Send to a single device token. Reaps the token on 410 (Unregistered). */
export async function sendApns(token: string, payload: ApnsPayload): Promise<ApnsSendResult> {
	const host = serverConfig.apnsProduction
		? 'https://api.push.apple.com'
		: 'https://api.sandbox.push.apple.com';
	const jwt = buildProviderJwt();
	const body = JSON.stringify({
		aps: { alert: { title: payload.title, body: payload.body }, sound: 'default' },
		url: payload.url ?? null
	});

	return new Promise<ApnsSendResult>((resolve) => {
		const client = http2.connect(host);
		client.on('error', () => resolve({ status: 0, reason: 'connect_error' }));
		const req = client.request({
			':method': 'POST',
			':path': `/3/device/${token}`,
			authorization: `bearer ${jwt}`,
			'apns-topic': serverConfig.apnsBundleId,
			'apns-push-type': 'alert',
			'content-type': 'application/json'
		});
		let status = 0;
		let data = '';
		req.on('response', (headers) => {
			status = Number(headers[':status']) || 0;
		});
		req.setEncoding('utf8');
		req.on('data', (chunk) => (data += chunk));
		req.on('end', () => {
			client.close();
			let reason: string | undefined;
			if (status !== 200) {
				try {
					reason = JSON.parse(data)?.reason;
				} catch {
					/* non-JSON error body */
				}
				// 410 Unregistered (or 400 BadDeviceToken) → the token is dead.
				if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') {
					removeApnsToken(token);
				}
			}
			resolve({ status, reason });
		});
		req.on('error', () => {
			client.close();
			resolve({ status: 0, reason: 'request_error' });
		});
		req.end(body);
	});
}

/**
 * Fan out a push to every registered device. No-op (returns zeros) until APNs
 * is configured. Safe to call from the task completion hook unconditionally.
 */
export async function sendApnsToAll(
	payload: ApnsPayload
): Promise<{ sent: number; failed: number }> {
	if (!apnsConfigured()) return { sent: 0, failed: 0 };
	const tokens = allTokens();
	if (tokens.length === 0) return { sent: 0, failed: 0 };
	let sent = 0;
	let failed = 0;
	for (const token of tokens) {
		const r = await sendApns(token, payload).catch(() => ({ status: 0 }) as ApnsSendResult);
		if (r.status === 200) sent++;
		else failed++;
	}
	return { sent, failed };
}
