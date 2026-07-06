import type Database from 'better-sqlite3';

// Mirror the usage writers' key convention: they store `date` as
// `new Date().toISOString().slice(0,10)` (UTC-derived). We use the SAME
// convention here so our aggregation keys line up exactly with stored rows and
// never drift by a day at a timezone boundary.
export function todayDate(): string {
	return new Date().toISOString().slice(0, 10);
}

// Add `deltaDays` (may be negative) to a YYYY-MM-DD string, staying in UTC.
export function shiftDate(iso: string, deltaDays: number): string {
	const d = new Date(iso + 'T00:00:00Z');
	d.setUTCDate(d.getUTCDate() + deltaDays);
	return d.toISOString().slice(0, 10);
}

export function round2(x: number): number {
	return Math.round((x + Number.EPSILON) * 100) / 100;
}

export function normalizeDays(days: number): number {
	return Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
}

// Query helper that tolerates a not-yet-created table (usage tables self-create
// on first write, so a fresh install may not have them yet).
export function safeAll<T>(db: Database.Database, sql: string, param: string): T[] {
	try {
		return db.prepare(sql).all(param) as T[];
	} catch {
		return [];
	}
}
