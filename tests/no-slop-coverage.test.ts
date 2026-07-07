import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// Guard: the no-slop core must be present in BOTH the text and voice prompt
// constructions so no model surface drifts. Source-level check keeps it fast
// and free of the full prompt-build harness.
const src = readFileSync('src/lib/server/chat_prompt.ts', 'utf-8');
describe('no-ai-slop coverage across model surfaces', () => {
	it('defines a single shared NO_SLOP_CORE', () => {
		expect(src).toContain('const NO_SLOP_CORE =');
	});
	it('text WRITING_STYLE composes from the core', () => {
		expect(src).toMatch(/const WRITING_STYLE = `[\s\S]*\$\{NO_SLOP_CORE\}/);
	});
	it('voice WRITING_STYLE_VOICE composes from the core', () => {
		expect(src).toMatch(/const WRITING_STYLE_VOICE = `[\s\S]*\$\{NO_SLOP_CORE\}/);
	});
	it('voice prompt injects the voice style', () => {
		expect(src).toContain('${WRITING_STYLE_VOICE}`');
	});
});
