export interface StreamRow {
	seq: number;
	action: string;
	target: string | null;
}

/** Merge fresh rows into existing by seq, dedupe, return the new high-water cursor. */
export function reconcileRows(
	existing: StreamRow[],
	fresh: StreamRow[],
	cursor: number
): { rows: StreamRow[]; cursor: number } {
	const bySeq = new Map<number, StreamRow>();
	for (const r of existing) bySeq.set(r.seq, r);
	let hi = cursor;
	for (const r of fresh) {
		bySeq.set(r.seq, r);
		if (r.seq > hi) hi = r.seq;
	}
	const rows = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
	return { rows, cursor: hi };
}
