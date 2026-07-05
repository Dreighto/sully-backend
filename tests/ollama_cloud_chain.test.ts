import { describe, expect, it, vi, afterEach } from 'vitest';
import { listOllamaCloudAutoModels } from '$lib/server/chat/ollama_cloud_chain';

describe('listOllamaCloudAutoModels', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('defaults to cloud models available on ROOM', () => {
		expect(listOllamaCloudAutoModels('chat')).toEqual([
			'qwen3-coder:480b-cloud',
			'gpt-oss:20b-cloud'
		]);
	});

	it('honors SULLY_AUTO_OLLAMA_CHAIN override', () => {
		vi.stubEnv('SULLY_AUTO_OLLAMA_CHAIN', 'gpt-oss:20b-cloud,qwen3-coder:480b-cloud');
		expect(listOllamaCloudAutoModels('planning')).toEqual([
			'gpt-oss:20b-cloud',
			'qwen3-coder:480b-cloud'
		]);
	});
});
