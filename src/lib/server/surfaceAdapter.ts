import Database from 'better-sqlite3';
import { serverConfig } from './config';
import fs from 'node:fs';
import { buildVerificationView } from './surface/verification_view';
import { mapJobStatusToAggrStatus, buildWorkers } from './surface/surface_status';
import { buildPhases } from './surface/surface_phases';
import { buildFiles } from './surface/surface_files';
import { computeElapsedDisplay, buildActivity } from './surface/surface_activity';
import { buildNeeds } from './surface/surface_needs';

// Wave 2 split (2026-07-06): this file used to hold every concern below
// directly (633 lines). It now orchestrates liveSurfaceFromTrace from the
// pieces in ./surface/*, and re-exports the two symbols other modules import
// from 'surfaceAdapter' by path (buildVerificationView, liveSurfaceFromTrace)
// so no external import statement needed to change.
export {
	buildVerificationView,
	type VerificationChannelView,
	type VerificationView,
	type SurfaceWithVerification
} from './surface/verification_view';
import type { SurfaceWithVerification } from './surface/verification_view';

export async function liveSurfaceFromTrace(
	traceId: string
): Promise<SurfaceWithVerification | null> {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return null;

	const db = new Database(serverConfig.memoryDbPath);
	try {
		// Get the pending_jobs row
		const jobRow = db.prepare('SELECT * FROM pending_jobs WHERE trace_id = ?').get(traceId) as any;
		if (!jobRow) return null;

		// Get chat_activity rows for this trace
		const activityRows = db
			.prepare(
				`
            SELECT * FROM chat_activity
            WHERE trace_id = ?
            ORDER BY id ASC
        `
			)
			.all(traceId) as any[];

		// Map status to AggrStatus
		const aggrStatus = mapJobStatusToAggrStatus(jobRow.status);

		// Get worker info
		const workers = await buildWorkers(jobRow.worker, aggrStatus, activityRows);

		// Build phases
		const phases = buildPhases(activityRows, aggrStatus);

		// Build files from manifest
		const files = await buildFiles(activityRows);

		// Build evidence from wrote_file activity
		const evidence = activityRows
			.filter((row) => row.action === 'wrote_file' || row.action === 'write_file')
			.map((row) => ({ path: row.target }))
			.filter((ev) => ev.path);

		// Check for promotion warnings
		let promotionWarning: string | undefined;
		const failedPromotionCount = activityRows.filter(
			(row) => row.action === 'wrote_file' && row.target?.includes('promotion')
		).length;
		if (failedPromotionCount > 0) {
			promotionWarning = `${failedPromotionCount} deliverable${failedPromotionCount === 1 ? '' : 's'} couldn't be saved`;
		}

		// Compute elapsed display (glyph derived from status, not endedAt)
		const elapsedDisplay = computeElapsedDisplay(jobRow.started_at, jobRow.ended_at, aggrStatus);

		// Build needs from the gated proposal stashed in pending_jobs.result_ref
		const needs = buildNeeds(jobRow, aggrStatus);

		// Build humanized chronological activity log
		const activity = buildActivity(activityRows, workers[0]?.shortcode ?? 'CC');

		// READ-ONLY verification exposure from the columns verifyPoll/completionClose
		// already wrote — undefined until the Go/No-Go poll has actually run.
		const verification = buildVerificationView(jobRow);

		return {
			surfaceId: traceId,
			title: jobRow.brief || 'Working',
			createdAt: jobRow.started_at,
			aggr: aggrStatus,
			elapsedDisplay,
			needs,
			blockedBy: undefined,
			workers,
			phases,
			files,
			activity,
			evidence: evidence.length > 0 ? evidence : undefined,
			promotionWarning,
			verification
		};
	} finally {
		db.close();
	}
}
