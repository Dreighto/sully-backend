import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';

import {
	normalizeInputText,
	normalizeLatestUserMessage,
	type NormalizationMode
} from '../src/lib/server/input_normalizer';

function normalize(text: string, mode: NormalizationMode): string {
	return normalizeInputText(text, mode);
}

describe('input_normalizer', () => {
	it('applies light-touch cleanup for typed chat', () => {
		expect(normalize('hey can you check logue os on the jet son', 'chat')).toBe(
			'Hey can you check LogueOS on the Jetson.'
		);
	});

	it('applies heavier cleanup for voice dictation without rewriting intent', () => {
		expect(
			normalize(
				'um uh hey sully i need you to i need you to check the logue os dispatch thing on the jet son',
				'voice'
			)
		).toBe('Hey Sully I need you to check the LogueOS dispatch thing on the Jetson.');
	});

	it('handles walkie-talkie mode as clipped speech without over-rewriting it', () => {
		expect(normalize('uh need the walkie talkie dispatch file in logue os', 'walkie')).toBe(
			'Need the walkie-talkie dispatch file in LogueOS.'
		);
	});

	it('uses the domain dictionary for real STT artifacts we actually captured', () => {
		expect(
			normalize(
				'Hey, Sully, I need you to look up the latest prices for the Jetson Orin NanoSuper.',
				'voice'
			)
		).toBe('Hey, Sully, I need you to look up the latest prices for the Jetson Orin Nano Super.');
	});

	it('does not invent a Sully correction for unrelated words', () => {
		expect(normalize('No, their names are not silly.', 'voice')).toBe(
			'No, their names are not silly.'
		);
	});

	it('collapses repeated words but preserves deliberate numeric repetition', () => {
		expect(normalize('check the the dispatch logs', 'voice')).toBe('Check the dispatch logs.');
		expect(normalize('repeat five five five one two three four', 'voice')).toBe(
			'Repeat five five five one two three four.'
		);
	});

	it('normalizes the latest user SDK message without disturbing non-text parts', () => {
		const messages = [
			{
				id: 'a1',
				role: 'assistant',
				parts: [{ type: 'text', text: 'previous reply' }]
			},
			{
				id: 'u1',
				role: 'user',
				parts: [
					{ type: 'text', text: 'um check logue os on the jet son' },
					{ type: 'file', mediaType: 'image/png', filename: 'board.png', url: '/board.png' }
				]
			}
		] as UIMessage[];

		const normalized = normalizeLatestUserMessage(messages, 'voice');
		const latestUser = normalized[1];
		expect(latestUser.parts[0]).toEqual({
			type: 'text',
			text: 'Check LogueOS on the Jetson.'
		});
		expect(latestUser.parts[1]).toEqual(messages[1].parts[1]);
	});
});
