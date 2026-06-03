import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { captureGateBlock } from '$lib/server/routing/captureGate';

const FILE = '/tmp/sully-gate-capture-test.jsonl';
afterEach(() => {
	if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
});

describe('captureGateBlock', () => {
	it('appends one JSON line per captured block', () => {
		captureGateBlock(
			{ userText: 'fix the build', gateBlock: '{"escalate":true}', tier: 'chat' },
			FILE
		);
		captureGateBlock({ userText: 'just chatting', gateBlock: null, tier: 'chat' }, FILE);
		const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n');
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).userText).toBe('fix the build');
		expect(JSON.parse(lines[1]).gateBlock).toBeNull();
	});
});
