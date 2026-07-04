import { describe, expect, it } from 'vitest';
import { classifyShadow } from '../src/lib/server/brains/shadow_router';

describe('shadow router — deterministic floor (the R1 lesson)', () => {
	it('mass deletion ALWAYS escalates, however phrased', () => {
		for (const t of [
			'delete every photo in my library older than 2020',
			'can you wipe all files in that folder',
			'purge the entire database please',
			'remove all my old photos'
		]) {
			const v = classifyShadow(t);
			expect(v.decision, t).toBe('ESCALATE');
			expect(v.source, t).toBe('floor');
		}
	});

	it('money movement / prod deploys / mass outbound / credential exposure → floor ESCALATE', () => {
		for (const t of [
			'send $500 to my landlord',
			'deploy the new build to production',
			'email everyone on my contacts the update',
			'paste the api key and send it to him'
		]) {
			expect(classifyShadow(t).source, t).toBe('floor');
		}
	});

	it('destructive shell/git commands → floor', () => {
		expect(classifyShadow('run rm -rf on the build dir').decision).toBe('ESCALATE');
		expect(classifyShadow('just force-push to main').decision).toBe('ESCALATE');
	});
});

describe('shadow router — fast paths + heuristics', () => {
	it('greetings/chitchat → LOCAL fastpath', () => {
		for (const t of ['Hi.', 'hey!', 'good morning', 'thanks', 'ok']) {
			const v = classifyShadow(t);
			expect(v.decision, t).toBe('LOCAL');
			expect(v.source, t).toBe('fastpath');
		}
	});

	it('short routine asks → LOCAL heuristic', () => {
		for (const t of [
			'what time is it in Tokyo?',
			'play some jazz',
			'remind me to call mom tomorrow at 9am',
			'is the gateway service running?'
		]) {
			expect(classifyShadow(t).decision, t).toBe('LOCAL');
		}
	});

	it('multi-step agentic shapes → ESCALATE heuristic', () => {
		expect(classifyShadow('refactor my backend across 12 files, run tests, then deploy').decision).toBe(
			'ESCALATE'
		);
		expect(classifyShadow('audit the whole project and implement fixes').decision).toBe('ESCALATE');
	});

	it('very large context → ESCALATE', () => {
		expect(classifyShadow('summarize this 300-page PDF for me').decision).toBe('ESCALATE');
	});

	it('ambiguous middle → unsure (never guessed)', () => {
		const v = classifyShadow('I have been thinking about the architecture tradeoffs we discussed');
		expect(v.decision).toBe('unsure');
	});

	it('floor beats LOCAL-looking phrasing (short + polite mass delete still escalates)', () => {
		expect(classifyShadow('please delete all my photos').decision).toBe('ESCALATE');
	});
});
