import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadRoutingCases } from '$lib/server/routing/fixtures';
import { scoreCases, renderReport } from '$lib/server/routing/scorecard';
import { ROUTING_ACCURACY_THRESHOLD } from '$lib/server/routing/threshold';

describe('routing scorecard — HARD CI GATE', () => {
	const score = scoreCases(loadRoutingCases());

	// Always print the headline so even CI logs show the numbers.
	// eslint-disable-next-line no-console
	console.log(
		`[routing-scorecard] accuracy ${(score.accuracy * 100).toFixed(1)}% (${score.correct}/${score.total}); misses ${score.misses.length}`
	);

	// Human report written only when explicitly requested (npm run routing:score),
	// so the plain CI `npm test` run stays side-effect-free.
	if (process.env.ROUTING_SCORE_REPORT === '1') {
		const dir = path.resolve(process.cwd(), 'data/peer_reviews');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'routing-scorecard-latest.md'), renderReport(score));
	}

	it('no locked regression case fails', () => {
		expect(score.lockedFailures, JSON.stringify(score.lockedFailures, null, 2)).toHaveLength(0);
	});

	it(`overall accuracy ≥ committed threshold (${ROUTING_ACCURACY_THRESHOLD})`, () => {
		expect(score.accuracy).toBeGreaterThanOrEqual(ROUTING_ACCURACY_THRESHOLD);
	});
});
