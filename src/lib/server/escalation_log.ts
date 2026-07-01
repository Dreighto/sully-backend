// Escalation telemetry — logs every local→cloud hand-off to companion.db.
// This table is the seed of the apprentice→teacher training corpus: each row
// is a labeled example of what companion-v1 couldn't handle, paired with the
// cloud specialist's answer. A future fine-tune script reads this table.
//
// Schema is intentionally minimal. The cloud_output_preview column is nullable
// and filled in by updateEscalationCloudOutput() after the CLI bridge finishes.

import Database from 'better-sqlite3';
import { serverConfig } from './config';

function getDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath);
}

function ensureTable(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS escalation_log (
			id                   INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id              TEXT    NOT NULL,
			thread_id            TEXT    NOT NULL,
			local_model          TEXT    NOT NULL,
			local_output_preview TEXT,
			escalation_reason    TEXT    NOT NULL,
			cloud_model          TEXT    NOT NULL,
			cloud_output_preview TEXT,
			ts                   TEXT    NOT NULL DEFAULT (datetime('now'))
		)
	`);
}

export interface EscalationLogParams {
	taskId: string;
	threadId: string;
	localModel: string;
	localOutputPreview: string;
	escalationReason: string;
	cloudModel: string;
}

export function logEscalation(params: EscalationLogParams): void {
	const db = getDb();
	try {
		ensureTable(db);
		db.prepare(
			`
			INSERT INTO escalation_log
				(task_id, thread_id, local_model, local_output_preview, escalation_reason, cloud_model)
			VALUES (?, ?, ?, ?, ?, ?)
		`
		).run(
			params.taskId,
			params.threadId,
			params.localModel,
			params.localOutputPreview.slice(0, 500),
			params.escalationReason,
			params.cloudModel
		);
	} finally {
		db.close();
	}
}

export function updateEscalationCloudOutput(taskId: string, cloudOutputPreview: string): void {
	const db = getDb();
	try {
		// Table is guaranteed to exist because logEscalation ran first this turn.
		db.prepare(
			`
			UPDATE escalation_log SET cloud_output_preview = ? WHERE task_id = ?
		`
		).run(cloudOutputPreview.slice(0, 500), taskId);
	} finally {
		db.close();
	}
}
