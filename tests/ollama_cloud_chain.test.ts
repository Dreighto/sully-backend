import { describe, expect, it, vi, afterEach } from 'vitest';
import {
	listOllamaCloudAutoModels,
	normalizeOllamaCloudModelId
} from '$lib/server/chat/ollama_cloud_chain';

describe('listOllamaCloudAutoModels', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('defaults to DeepSeek v4 cloud models on ROOM', () => {
		expect(listOllamaCloudAutoModels('chat')).toEqual([
			'deepseek-v4-flash:cloud',
			'deepseek-v4-pro:cloud',
			'qwen3-coder:480b-cloud',
			'gpt-oss:20b-cloud'
		]);
		expect(listOllamaCloudAutoModels('planning')[0]).toBe('deepseek-v4-pro:cloud');
	});

	it('maps legacy :671b-cloud ids via normalizeOllamaCloudModelId', () => {
		expect(normalizeOllamaCloudModelId('deepseek-v4-flash:671b-cloud')).toBe(
			'deepseek-v4-flash:cloud'
		);
	});

	it('honors SULLY_AUTO_OLLAMA_CHAIN override for backup models', () => {
		vi.stubEnv('SULLY_AUTO_OLLAMA_CHAIN', 'gpt-oss:20b-cloud,qwen3-coder:480b-cloud');
		expect(listOllamaCloudAutoModels('planning')).toEqual([
			'deepseek-v4-pro:cloud',
			'deepseek-v4-flash:cloud',
			'gpt-oss:20b-cloud',
			'qwen3-coder:480b-cloud'
		]);
	});
});
