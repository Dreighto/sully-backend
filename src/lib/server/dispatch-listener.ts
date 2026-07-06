// Server-only bridge from the Console API layer to the dispatch_listener
// HTTP surface. Mirrors the listener's HMAC contract exactly (sha256, hex
// digest in X-W4-HMAC header) so the listener can authenticate Console
// requests the same way it authenticates n8n / MCP-gateway requests.
//
// See `services/dispatch_listener/src/hmac.js` for the verifier side; this
// file is the signer side. If the algorithms drift the listener will 401
// every Console call.

import crypto from 'node:crypto';
import { serverConfig } from './config';

export interface ListenerKillResponse {
	ok: boolean;
	killed_pid: number | null;
	released_slot: string | null;
	note?: string;
}

export class DispatchListenerError extends Error {
	status: number;
	body: unknown;
	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.name = 'DispatchListenerError';
		this.status = status;
		this.body = body;
	}
}

function signBody(rawBody: string, secret: string): string {
	return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// Best-effort body read — we want the listener's error JSON when possible
// but fall back to status-only context if the body is empty/non-JSON.
async function readBody(resp: Response): Promise<unknown> {
	try {
		return await resp.json();
	} catch {
		return null;
	}
}

export async function killWorker(traceId: string): Promise<ListenerKillResponse> {
	const secret = serverConfig.dispatchListenerHmacSecret;
	if (!secret) {
		throw new DispatchListenerError('dispatch_listener_hmac_secret_not_configured', 500, {
			hint: 'Set LOGUEOS_LISTENER_HMAC_SECRET or W4_LISTENER_HMAC_SECRET in Console env to match the listener.'
		});
	}

	const url = `${serverConfig.dispatchListenerUrl.replace(/\/+$/, '')}/kill`;
	const body = JSON.stringify({ trace_id: traceId });
	const signature = signBody(body, secret);

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-W4-HMAC': signature
			},
			body
		});
	} catch (e) {
		// Network failure — listener may be down. Surface as 502 to the
		// caller; the API handler decides how to present this to the UI.
		throw new DispatchListenerError('dispatch_listener_unreachable', 502, {
			url,
			cause: e instanceof Error ? e.message : String(e)
		});
	}

	const parsedBody = await readBody(resp);
	if (!resp.ok) {
		throw new DispatchListenerError(
			'dispatch_listener_rejected',
			resp.status,
			parsedBody ?? { status: resp.status }
		);
	}

	// Trust the listener's shape — it's an internal contract we control on
	// both sides. If the listener changes the shape, the listener's tests
	// catch it before it ships.
	return parsedBody as ListenerKillResponse;
}
