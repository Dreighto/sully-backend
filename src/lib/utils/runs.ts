import type { Run } from '../types/run';

/**
 * Dedupes duplicate trace_id rows from the append-only log.
 * Algorithm: group by trace_id, keep the latest (last-written line wins since JSONL is chronological);
 * for null trace_id, use composite key (ticket_id, branch, pr_number).
 * 
 * @param runs Array of parsed Run objects in chronological order
 * @returns Deduped array of Run objects
 */
export function dedupeRuns(runs: Run[]): Run[] {
	const deduped = new Map<string, Run>();

	for (const run of runs) {
		const key = run.trace_id
			? `trace:${run.trace_id}`
			: `composite:${run.ticket_id}|${run.branch}|${run.pr_number}`;
		
		// Map.set() updates value but preserves original insertion order.
		// Map.delete() then Map.set() moves the key to the tail (end)
		// of iteration order, which ensures re-inserted entries remain
		// chronological in the resulting array.
		if (deduped.has(key)) {
			deduped.delete(key);
		}
		deduped.set(key, run);
	}

	return Array.from(deduped.values());
}
