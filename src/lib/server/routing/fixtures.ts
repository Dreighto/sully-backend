import fs from 'node:fs';
import path from 'node:path';
import type { Tier } from '../phase_classifier';
import type { RouteAction } from './decide';

export interface RoutingCase {
	text: string;
	fromTool: boolean;
	tier?: Tier;
	gateBlock?: string | null;
	expected: RouteAction;
	note?: string;
	/** Locked cases must individually pass (hard regression gate). */
	locked?: boolean;
}

/** Loads tests/fixtures/routing-cases.jsonl (one JSON object per non-blank line). */
export function loadRoutingCases(
	file = path.resolve(process.cwd(), 'tests/fixtures/routing-cases.jsonl')
): RoutingCase[] {
	const raw = fs.readFileSync(file, 'utf8');
	return raw
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith('//'))
		.map((l) => JSON.parse(l) as RoutingCase);
}
