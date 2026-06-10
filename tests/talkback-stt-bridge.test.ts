import { describe, it, expect } from 'vitest';
import { parseSttMessage, isTalkbackStopWord, buildVoiceWsUrl } from '../src/lib/chat/stt-bridge';

// Regression coverage for LOS-174 (T1a): the in-composer Talkback STT now
// routes through the local Jetson STT WS bridge instead of the browser Web
// Speech API + AssemblyAI cloud fallback. These exercise the pure transport
// helpers the controller depends on; the browser-coupled controller itself is
// verified in the Playwright WebKit suite + on-device.

describe('parseSttMessage — STT WS message normalization', () => {
	it('parses the four known message types', () => {
		expect(parseSttMessage(JSON.stringify({ type: 'ready' }))).toEqual({ type: 'ready' });
		expect(parseSttMessage(JSON.stringify({ type: 'partial', text: 'hel' }))).toEqual({
			type: 'partial',
			text: 'hel'
		});
		expect(parseSttMessage(JSON.stringify({ type: 'final', text: 'hello there' }))).toEqual({
			type: 'final',
			text: 'hello there'
		});
		expect(parseSttMessage(JSON.stringify({ type: 'error', error: 'gpu oom' }))).toEqual({
			type: 'error',
			error: 'gpu oom'
		});
	});

	it('supplies a default error message when the server omits one', () => {
		expect(parseSttMessage(JSON.stringify({ type: 'error' }))).toEqual({
			type: 'error',
			error: 'Speech recognition error.'
		});
	});

	it('never throws and collapses bad input to ignore', () => {
		// A garbage / unexpected socket frame must NOT surface as a transcript —
		// otherwise talkback could silently act on noise.
		expect(parseSttMessage('not json')).toEqual({ type: 'ignore' });
		expect(parseSttMessage(JSON.stringify({ type: 'mystery' }))).toEqual({ type: 'ignore' });
		expect(parseSttMessage(JSON.stringify('a bare string'))).toEqual({ type: 'ignore' });
		expect(parseSttMessage(JSON.stringify(42))).toEqual({ type: 'ignore' });
		expect(parseSttMessage(new ArrayBuffer(8))).toEqual({ type: 'ignore' });
		expect(parseSttMessage(undefined)).toEqual({ type: 'ignore' });
	});

	it('drops a non-string text field rather than mistyping it', () => {
		expect(parseSttMessage(JSON.stringify({ type: 'final', text: 123 }))).toEqual({
			type: 'final',
			text: undefined
		});
	});
});

describe('isTalkbackStopWord — spoken stop phrases', () => {
	it('detects the stop phrases case-insensitively and mid-sentence', () => {
		expect(isTalkbackStopWord('stop talkback')).toBe(true);
		expect(isTalkbackStopWord('Cancel Talkback')).toBe(true);
		expect(isTalkbackStopWord('okay please STOP TALKBACK now')).toBe(true);
	});

	it('does not fire on ordinary speech', () => {
		expect(isTalkbackStopWord('what is the status of the dispatch')).toBe(false);
		expect(isTalkbackStopWord('stop the build')).toBe(false);
		expect(isTalkbackStopWord('')).toBe(false);
	});
});

describe('buildVoiceWsUrl — root Funnel path, scheme by page protocol', () => {
	it('uses wss for an https page and ws otherwise', () => {
		expect(buildVoiceWsUrl('https:', 'companion.example.ts.net', '/companion-voice')).toBe(
			'wss://companion.example.ts.net/companion-voice'
		);
		expect(buildVoiceWsUrl('http:', 'localhost:5188', '/companion-voice')).toBe(
			'ws://localhost:5188/companion-voice'
		);
	});
});
