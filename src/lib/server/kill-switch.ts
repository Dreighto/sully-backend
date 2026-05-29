// Server-only helpers for the kill-switch surface. Both /api/kill-switch and
// the SSR loaders (settings page, root layout for the header indicator) call
// readKillSwitchState — keeping one source of truth for how we interpret the
// `data/system_halt` file. Mirrors the contract in
// tools/check_kill_switch.py: file presence = ACTIVE, absence = CLEAR.

import fs from 'node:fs/promises';
import path from 'node:path';
import { serverConfig } from './config';
import type { KillSwitchAction, KillSwitchState } from '$lib/types/kill-switch';

const SOURCE = 'console-ui';

export async function readKillSwitchState(): Promise<KillSwitchState> {
	try {
		const raw = await fs.readFile(serverConfig.killSwitchPath, 'utf-8');
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') {
				const p = parsed as Record<string, unknown>;
				return {
					active: true,
					activated_at: typeof p.activated_at === 'string' ? p.activated_at : null,
					activated_by: typeof p.activated_by === 'string' ? p.activated_by : null,
					note: typeof p.note === 'string' ? p.note : null
				};
			}
		} catch {
			// File exists but isn't our JSON — still active, just no metadata.
		}
		return { active: true, activated_at: null, activated_by: null, note: null };
	} catch (e: unknown) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === 'ENOENT') {
			return { active: false, activated_at: null, activated_by: null, note: null };
		}
		throw err;
	}
}

// Best-effort read for SSR contexts where throwing would render a 500. The
// settings page should still render with a "refresh failed" hint if the disk
// is briefly unreachable; the header indicator should fall back to CLEAR
// rather than crash navigation.
export async function readKillSwitchStateSafe(): Promise<KillSwitchState> {
	try {
		return await readKillSwitchState();
	} catch (err) {
		console.error('readKillSwitchStateSafe: falling back to CLEAR after error:', err);
		return { active: false, activated_at: null, activated_by: null, note: null };
	}
}

async function appendAuditLog(entry: {
	ts: string;
	action: KillSwitchAction;
	source: string;
	note: string | null;
}): Promise<void> {
	const logPath = serverConfig.killSwitchLogPath;
	await fs.mkdir(path.dirname(logPath), { recursive: true });
	await fs.appendFile(logPath, JSON.stringify(entry) + '\n', 'utf-8');
}

export async function activateKillSwitch(note: string | null): Promise<KillSwitchState> {
	const ts = new Date().toISOString();
	const payload = {
		activated_at: ts,
		activated_by: SOURCE,
		note: note ?? null
	};
	const filePath = serverConfig.killSwitchPath;
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	// Overwrite is intentional: re-affirming an existing halt refreshes the
	// timestamp + note. active stays true throughout.
	await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
	await appendAuditLog({ ts, action: 'activate', source: SOURCE, note: note ?? null });
	return { active: true, ...payload };
}

export async function clearKillSwitch(note: string | null): Promise<KillSwitchState> {
	const ts = new Date().toISOString();
	const filePath = serverConfig.killSwitchPath;
	try {
		await fs.unlink(filePath);
	} catch (e: unknown) {
		const err = e as NodeJS.ErrnoException;
		// ENOENT = already clear; log the no-op so operator intent is captured.
		if (err.code !== 'ENOENT') throw err;
	}
	await appendAuditLog({ ts, action: 'clear', source: SOURCE, note: note ?? null });
	return { active: false, activated_at: null, activated_by: null, note: null };
}
