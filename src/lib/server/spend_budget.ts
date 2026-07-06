import Database from 'better-sqlite3';
import { serverConfig } from './config';

// ── Server-side budget ───────────────────────────────────────────────────────

const BUDGET_TABLE = `
	CREATE TABLE IF NOT EXISTS chat_spend_budget (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		amount REAL NOT NULL DEFAULT 0,
		updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);
`;

export function getBudget(): number {
	try {
		const db = new Database(serverConfig.memoryDbPath, { readonly: true });
		try {
			const row = db.prepare('SELECT amount FROM chat_spend_budget WHERE id = 1').get() as
				| { amount: number }
				| undefined;
			return row?.amount ?? 0;
		} catch {
			// Table may not exist yet — return 0.
			return 0;
		} finally {
			db.close();
		}
	} catch {
		return 0;
	}
}

export function setBudget(amount: number): void {
	try {
		const db = new Database(serverConfig.memoryDbPath);
		try {
			db.exec(BUDGET_TABLE);
			db.prepare(
				`INSERT INTO chat_spend_budget (id, amount) VALUES (1, ?)
				 ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, updated_at = CURRENT_TIMESTAMP`
			).run(amount);
		} finally {
			db.close();
		}
	} catch (e) {
		console.error('setBudget error:', e);
	}
}
