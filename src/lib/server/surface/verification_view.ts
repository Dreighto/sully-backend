import type { SeedSurface } from '$lib/work-surface/hybrid/hybrid-types';

/**
 * READ-ONLY exposure of the Go/No-Go evidence channels (verifyPoll.ts →
 * completionClose.ts → pending_jobs.verification_*). One entry per channel;
 * verdict mirrors ChannelResult.state verbatim. No new verification logic —
 * this only surfaces what the poll already stored on the task row.
 */
export interface VerificationChannelView {
	name: string;
	verdict: 'GO' | 'NO_GO' | 'UNKNOWN' | 'SKIPPED';
	detail?: string;
}

export interface VerificationView {
	/** Overall posture from verification_state: 'confirmed' | 'hedge' | 'warn'. */
	overall: string;
	channels: VerificationChannelView[];
	/** verification_ref — commit sha / journal link, when present. */
	ref?: string | null;
}

/** SeedSurface extended with the optional read-only verification block. */
export type SurfaceWithVerification = SeedSurface & { verification?: VerificationView };

const CHANNEL_VERDICTS = new Set(['GO', 'NO_GO', 'UNKNOWN', 'SKIPPED']);

/**
 * Build the operator-facing verification block from a pending_jobs row (or any
 * object carrying verification_state / verification_evidence / verification_ref).
 * Returns undefined when the poll never ran (verification_state is null) —
 * absence means "not verified yet", never a fabricated verdict. Malformed or
 * missing evidence JSON degrades to an empty channel list, keeping the overall
 * posture visible. Pure + read-only.
 */
export function buildVerificationView(
	row:
		| {
				verification_state?: string | null;
				verification_ref?: string | null;
				verification_evidence?: string | null;
		  }
		| null
		| undefined
): VerificationView | undefined {
	if (!row?.verification_state) return undefined;

	let channels: VerificationChannelView[] = [];
	if (row.verification_evidence) {
		try {
			const parsed = JSON.parse(row.verification_evidence);
			if (Array.isArray(parsed)) {
				channels = parsed
					.filter((c: any) => c && typeof c.channel === 'string')
					.map((c: any) => {
						const verdict = CHANNEL_VERDICTS.has(c.state) ? c.state : 'UNKNOWN';
						const view: VerificationChannelView = { name: c.channel, verdict };
						if (typeof c.detail === 'string' && c.detail) view.detail = c.detail;
						return view;
					});
			}
		} catch {
			/* malformed evidence JSON — expose posture alone, never throw */
		}
	}

	return {
		overall: row.verification_state,
		channels,
		ref: row.verification_ref ?? null
	};
}
