import Database from 'better-sqlite3';
import fs from 'node:fs';
import { serverConfig } from '$lib/server/config';

export type JobRow = Record<string, unknown> & {
	trace_id: string;
	worker: string;
	ticket_id?: string | null;
	started_at?: string | null;
};

function openDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath, { readonly: true });
}

export function getJob(traceId: string): JobRow | null {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return null;
	const db = openDb();
	try {
		return (
			(db.prepare('SELECT * FROM pending_jobs WHERE trace_id = ?').get(traceId) as JobRow) ?? null
		);
	} finally {
		db.close();
	}
}
