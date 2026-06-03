// Append-only capture of the teacher's SULLY_GATE self-assessment blocks, so the
// model-vote layer can be scored OFFLINE later without a live model. Best-effort,
// never throws into the turn pipeline. Disabled unless ROUTING_CAPTURE_GATES=1.
import fs from 'node:fs';
import path from 'node:path';

export interface GateCapture {
	userText: string;
	gateBlock: string | null;
	tier?: string;
}

export function captureGateBlock(
	c: GateCapture,
	file = path.resolve(process.cwd(), 'data/routing-gate-blocks.jsonl')
): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, JSON.stringify({ ...c, at: new Date().toISOString() }) + '\n');
	} catch (e) {
		console.warn('[captureGate] skipped:', e);
	}
}
