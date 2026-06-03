// Pure scorecard over a labeled RoutingCase set. Runs each case through the
// production decide() and tallies accuracy, per-class precision/recall, a 3x3
// confusion matrix, the exact misses, and any LOCKED-case failures (the hard
// regression set). No I/O — renderReport returns a markdown string the caller
// may write to disk.
import { decide, type RouteAction } from './decide';
import type { RoutingCase } from './fixtures';

const CLASSES: RouteAction[] = ['Talk', 'Ask', 'Dispatch'];

export interface Miss {
	text: string;
	expected: RouteAction;
	got: RouteAction;
	reason: string;
	locked: boolean;
}

export interface Scorecard {
	total: number;
	correct: number;
	accuracy: number; // 0..1
	confusion: Record<RouteAction, Record<RouteAction, number>>;
	precision: Record<RouteAction, number>;
	recall: Record<RouteAction, number>;
	misses: Miss[];
	lockedFailures: Miss[];
}

function emptyConfusion(): Record<RouteAction, Record<RouteAction, number>> {
	const m = {} as Record<RouteAction, Record<RouteAction, number>>;
	for (const a of CLASSES) {
		m[a] = {} as Record<RouteAction, number>;
		for (const b of CLASSES) m[a][b] = 0;
	}
	return m;
}

export function scoreCases(cases: RoutingCase[]): Scorecard {
	const confusion = emptyConfusion();
	const misses: Miss[] = [];
	let correct = 0;

	for (const c of cases) {
		const d = decide({
			userText: c.text,
			fromTool: c.fromTool,
			recentTier: c.tier,
			gateBlock: c.gateBlock
		});
		confusion[c.expected][d.action] += 1;
		if (d.action === c.expected) correct += 1;
		else
			misses.push({
				text: c.text,
				expected: c.expected,
				got: d.action,
				reason: d.reason,
				locked: !!c.locked
			});
	}

	const precision = {} as Record<RouteAction, number>;
	const recall = {} as Record<RouteAction, number>;
	for (const cls of CLASSES) {
		const tp = confusion[cls][cls];
		const predicted = CLASSES.reduce((s, a) => s + confusion[a][cls], 0); // column sum
		const actual = CLASSES.reduce((s, b) => s + confusion[cls][b], 0); // row sum
		precision[cls] = predicted ? tp / predicted : 1;
		recall[cls] = actual ? tp / actual : 1;
	}

	return {
		total: cases.length,
		correct,
		accuracy: cases.length ? correct / cases.length : 1,
		confusion,
		precision,
		recall,
		misses,
		lockedFailures: misses.filter((m) => m.locked)
	};
}

export function renderReport(s: Scorecard): string {
	const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
	const lines: string[] = [];
	lines.push('# Sully Routing Scorecard');
	lines.push('');
	lines.push(`**Accuracy:** ${pct(s.accuracy)} (${s.correct}/${s.total})`);
	lines.push('');
	lines.push('| Class | Precision | Recall |');
	lines.push('| --- | --- | --- |');
	for (const cls of CLASSES)
		lines.push(`| ${cls} | ${pct(s.precision[cls])} | ${pct(s.recall[cls])} |`);
	lines.push('');
	lines.push('## Confusion matrix (rows = expected, cols = got)');
	lines.push('');
	lines.push(`| expected ↓ \\ got → | ${CLASSES.join(' | ')} |`);
	lines.push(`| --- | ${CLASSES.map(() => '---').join(' | ')} |`);
	for (const e of CLASSES)
		lines.push(`| ${e} | ${CLASSES.map((g) => s.confusion[e][g]).join(' | ')} |`);
	lines.push('');
	lines.push(`## Misses (${s.misses.length})`);
	lines.push('');
	for (const m of s.misses) {
		lines.push(
			`- ${m.locked ? '🔒 ' : ''}\`${m.text}\` — expected **${m.expected}**, got **${m.got}** (${m.reason})`
		);
	}
	return lines.join('\n');
}
