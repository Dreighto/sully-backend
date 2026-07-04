import { describe, expect, it, vi } from 'vitest';

// sdk_direct_reply drags in DB/dispatch modules at import time — stub the
// value imports so this stays a pure frame-shape unit test.
vi.mock('$lib/server/chat_turn', () => ({ persistAssistantTurn: vi.fn() }));
vi.mock('$lib/server/thread_state', () => ({ upsertThreadTier: vi.fn() }));
vi.mock('$lib/server/thread_meta', () => ({ touchLastActivity: vi.fn() }));
vi.mock('$lib/server/chat/autonomous_dispatch', () => ({ applyTurnDecision: vi.fn() }));
vi.mock('$lib/server/chat/system_read_tools', () => ({ systemReadTools: {} }));
vi.mock('$lib/server/routing/factGate', () => ({
	factGate: () => ({ category: 'conversational', sensitive: false, reason: 'test' })
}));
vi.mock('$lib/server/model_catalog', () => ({ resolveChatModel: () => 'model-test' }));
vi.mock('$lib/server/chat/sdk_stream_common', () => ({
	finishWithReplyId: vi.fn(),
	rollbackOrphanTurn: vi.fn()
}));

import {
	classifySullyError,
	emitSullyError,
	sullyErrorFrame,
	type SullyErrorCode,
	type SullyErrorFrame
} from '../src/lib/server/chat/sdk_direct_reply';

const CODES: SullyErrorCode[] = [
	'credential_unavailable',
	'rate_limit',
	'timeout',
	'provider_error',
	'context_overflow',
	'unknown'
];

function expectFrameShape(frame: SullyErrorFrame) {
	expect(Object.keys(frame).sort()).toEqual(['code', 'message', 'recovery']);
	expect(CODES).toContain(frame.code);
	expect(typeof frame.message).toBe('string');
	expect(frame.message.length).toBeGreaterThan(0);
	expect(typeof frame.recovery).toBe('string');
	expect(frame.recovery.length).toBeGreaterThan(0);
	// recovery is a ONE-LINE actionable hint
	expect(frame.recovery).not.toContain('\n');
	expect(frame.recovery).toMatch(/switch model|retry|start a new thread/i);
}

describe('sullyErrorFrame', () => {
	it('produces a {code, message, recovery} frame for every code', () => {
		for (const code of CODES) {
			const frame = sullyErrorFrame(code, 'boom');
			expectFrameShape(frame);
			expect(frame.code).toBe(code);
			expect(frame.message).toBe('boom');
		}
	});

	it('pairs each code with its actionable recovery hint', () => {
		expect(sullyErrorFrame('credential_unavailable', 'x').recovery).toMatch(/switch model/i);
		expect(sullyErrorFrame('rate_limit', 'x').recovery).toMatch(/retry|switch model/i);
		expect(sullyErrorFrame('timeout', 'x').recovery).toMatch(/retry/i);
		expect(sullyErrorFrame('provider_error', 'x').recovery).toMatch(/retry/i);
		expect(sullyErrorFrame('context_overflow', 'x').recovery).toMatch(/start a new thread/i);
		expect(sullyErrorFrame('unknown', 'x').recovery).toMatch(/retry/i);
	});
});

describe('classifySullyError', () => {
	const cases: Array<{ msg: string; statusCode?: number; want: SullyErrorCode }> = [
		{ msg: 'Anthropic credential unavailable for claude-opus-4', want: 'credential_unavailable' },
		{ msg: 'Google credential unavailable', want: 'credential_unavailable' },
		{
			msg: 'Auth failed for claude-haiku (authentication_error). Token expired or lacks access.',
			want: 'credential_unavailable'
		},
		{ msg: 'nope', statusCode: 401, want: 'credential_unavailable' },
		{ msg: 'nope', statusCode: 403, want: 'credential_unavailable' },
		{
			msg: 'Rate limited on claude-sonnet. Wait ~30s or switch model (Haiku, Gemini, Local).',
			want: 'rate_limit'
		},
		{ msg: 'nope', statusCode: 429, want: 'rate_limit' },
		{ msg: 'Too many requests', want: 'rate_limit' },
		{ msg: 'Request timed out after 60000ms', want: 'timeout' },
		{ msg: 'The operation was aborted', want: 'timeout' },
		{ msg: 'connect ETIMEDOUT 10.0.0.1:443', want: 'timeout' },
		{
			msg: 'Invalid request to claude-sonnet: prompt is too long: 214421 tokens > 200000 maximum',
			want: 'context_overflow'
		},
		{ msg: 'input exceeds the model context window', want: 'context_overflow' },
		{
			msg: 'Provider overloaded (claude-sonnet). Try again in a moment or switch model.',
			want: 'provider_error'
		},
		{ msg: 'nope', statusCode: 503, want: 'provider_error' },
		{ msg: 'nope', statusCode: 529, want: 'provider_error' },
		{ msg: 'fetch failed', want: 'provider_error' },
		{ msg: 'connect ECONNREFUSED 127.0.0.1:11434', want: 'provider_error' },
		{ msg: 'something inexplicable happened', want: 'unknown' },
		{ msg: '', want: 'unknown' }
	];

	it.each(cases)('maps "$msg" (status=$statusCode) -> $want', ({ msg, statusCode, want }) => {
		const frame = classifySullyError(msg, statusCode);
		expect(frame.code).toBe(want);
		expectFrameShape(frame);
	});

	it('falls back to a non-empty message when the raw message is empty', () => {
		const frame = classifySullyError('');
		expect(frame.message).toBe('unknown_stream_error');
	});
});

describe('emitSullyError', () => {
	it('writes a data-sully-error chunk with the frame as data', () => {
		const write = vi.fn();
		const frame = classifySullyError('fetch failed');
		emitSullyError({ write }, frame);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith({ type: 'data-sully-error', data: frame });
		expectFrameShape(write.mock.calls[0][0].data as SullyErrorFrame);
	});

	it('swallows writer failures (stream already closed)', () => {
		const write = vi.fn(() => {
			throw new Error('closed');
		});
		expect(() => emitSullyError({ write }, sullyErrorFrame('unknown', 'x'))).not.toThrow();
	});
});
