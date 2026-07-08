import { describe, it, expect } from 'vitest';
// Guard the cloud-model detection regex both voice call sites use — the
// colon-form (deepseek-v4-flash:cloud) must route to ollama.com, not local.
const isCloud = (m: string) => /[:-]cloud$/.test(m);
describe('voice cloud-model detection', () => {
	it('matches -cloud form', () => expect(isCloud('gpt-oss:120b-cloud')).toBe(true));
	it('matches :cloud form', () => expect(isCloud('deepseek-v4-flash:cloud')).toBe(true));
	it('rejects local models', () => {
		expect(isCloud('companion-v1-voice:latest')).toBe(false);
		expect(isCloud('llama3.2')).toBe(false);
	});
});
