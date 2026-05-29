// Privacy redactor for Tier 0 observation bodies.
// Reads LogueOS-Orchestrator/.env, finds all KEY=VALUE pairs, and
// replaces any occurrence of a value in the body with [REDACTED:KEY_NAME].
//
// Fail-closed: if the env file is unreadable for any reason, returns null
// and the caller MUST block emission rather than risking a key leak into
// the shared memory pool.

import fs from 'node:fs';
import { serverConfig } from './config';

export interface RedactionResult {
	redacted: string;
	redaction_count: number;
}

function parseEnvFile(raw: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIdx = trimmed.indexOf('=');
		if (eqIdx < 1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		let val = trimmed.slice(eqIdx + 1).trim();
		// Strip surrounding single or double quotes (common .env convention).
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		// Skip trivially short values (true/false/none/0/1/yes/no) — these would
		// produce false positives if they appear in normal English text.
		if (key && val.length >= 8) {
			map.set(key, val);
		}
	}
	return map;
}

/**
 * Redact all .env values from `body`.
 * Returns null if the env file cannot be read — fail-closed.
 */
export function redactEnvValues(body: string): RedactionResult | null {
	let raw: string;
	try {
		raw = fs.readFileSync(serverConfig.orchestratorEnvPath, 'utf-8');
	} catch {
		console.error(
			`env_redactor: cannot read ${serverConfig.orchestratorEnvPath} — emission BLOCKED`
		);
		return null;
	}

	const envValues = parseEnvFile(raw);
	let result = body;
	let redaction_count = 0;

	for (const [key, val] of envValues) {
		if (result.includes(val)) {
			result = result.split(val).join(`[REDACTED:${key}]`);
			redaction_count++;
		}
	}

	return { redacted: result, redaction_count };
}
