// AssemblyAI async speech-to-text proxy.
// POST: receives audio blob (multipart/form-data, field 'file')
//   → uploads to AssemblyAI → polls until done → returns {text, duration_seconds}
// Cap: ASSEMBLYAI_DAILY_MINUTE_CAP env var (default 30) enforced via chat_stt_usage table.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getTodaySttUsage, addSttUsage } from '$lib/server/voice_usage';

const ASSEMBLYAI_BASE = 'https://api.assemblyai.com/v2';
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120_000;

export const POST: RequestHandler = async ({ request }) => {
	const apiKey = env.ASSEMBLY_AI_API_KEY;
	if (!apiKey) {
		throw error(503, { message: 'STT not configured' });
	}

	const dailyCapMinutes = Number(env.ASSEMBLYAI_DAILY_MINUTE_CAP ?? 30);

	// Cap check before doing any work
	const usedToday = getTodaySttUsage();
	if (usedToday >= dailyCapMinutes) {
		return json(
			{ error: 'cap_exhausted', usage_today_minutes: usedToday },
			{ status: 429 }
		);
	}

	const form = await request.formData();
	const file = form.get('file');
	if (!file || !(file instanceof Blob)) {
		throw error(400, { message: 'Missing audio file' });
	}

	const audioBuffer = await file.arrayBuffer();

	// Step 1: upload audio bytes to AssemblyAI
	const uploadRes = await fetch(`${ASSEMBLYAI_BASE}/upload`, {
		method: 'POST',
		headers: {
			authorization: apiKey,
			'content-type': 'application/octet-stream'
		},
		body: audioBuffer
	});
	if (!uploadRes.ok) {
		const body = await uploadRes.text();
		console.error('AssemblyAI upload error:', uploadRes.status, body);
		throw error(502, { message: 'AssemblyAI upload failed' });
	}
	const { upload_url } = (await uploadRes.json()) as { upload_url: string };

	// Step 2: submit transcription job
	const submitRes = await fetch(`${ASSEMBLYAI_BASE}/transcript`, {
		method: 'POST',
		headers: {
			authorization: apiKey,
			'content-type': 'application/json'
		},
		body: JSON.stringify({ audio_url: upload_url, speech_models: ['universal-2'] })
	});
	if (!submitRes.ok) {
		const body = await submitRes.text();
		console.error('AssemblyAI submit error:', submitRes.status, body);
		throw error(502, { message: 'AssemblyAI submit failed' });
	}
	const { id: transcriptId } = (await submitRes.json()) as { id: string };

	// Step 3: poll until complete or timeout
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	let transcript: { status: string; text?: string; audio_duration?: number; error?: string } = {
		status: 'queued'
	};

	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		const pollRes = await fetch(`${ASSEMBLYAI_BASE}/transcript/${transcriptId}`, {
			headers: { authorization: apiKey }
		});
		if (!pollRes.ok) {
			console.error('AssemblyAI poll error:', pollRes.status);
			break;
		}
		transcript = await pollRes.json();
		if (transcript.status === 'completed' || transcript.status === 'error') break;
	}

	if (transcript.status === 'error') {
		console.error('AssemblyAI transcription error:', transcript.error);
		throw error(502, { message: 'Transcription failed' });
	}

	if (transcript.status !== 'completed') {
		throw error(504, { message: 'Transcription timeout' });
	}

	// Record usage — audio_duration is in seconds; convert to minutes
	const durationSeconds = transcript.audio_duration ?? 0;
	const durationMinutes = durationSeconds / 60;
	if (durationMinutes > 0) {
		addSttUsage(durationMinutes);
	}

	return json({
		text: transcript.text ?? '',
		duration_seconds: durationSeconds
	});
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
