import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { speakableText } from '../src/lib/server/tts_normalize.ts';

const DEFAULT_AZURE_VOICE = 'en-US-Ava:DragonHDLatestNeural';
const PRONUNCIATION_EXPERIMENT_EFFECT = 'eq_car';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const ENV_PATH = resolve(REPO_ROOT, '.env');

type SampleResult = {
	input: string;
	expected: string;
	baselineTranscript: string;
	experimentTranscript: string;
	baselineScore: number;
	experimentScore: number;
	baselineSynthMs: number;
	experimentSynthMs: number;
	baselineSttMs: number;
	experimentSttMs: number;
	baselineBytes: number;
	experimentBytes: number;
	winner: 'baseline' | 'experiment' | 'tie';
};

function loadDotEnv(path: string) {
	if (!existsSync(path)) return;
	for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		if (!key || process.env[key] !== undefined) continue;
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
}

function escapeSsml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function canonicalize(text: string): string {
	return text
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, ' ')
		.trim()
		.replaceAll(/\s+/g, ' ');
}

function levenshtein(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const dp = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
	for (let i = 0; i < rows; i++) dp[i][0] = i;
	for (let j = 0; j < cols; j++) dp[0][j] = j;
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
		}
	}
	return dp[a.length][b.length];
}

function buildSsml(text: string, voice: string, experiment: boolean): string {
	const voiceAttrs = experiment
		? `name="${escapeSsml(voice)}" effect="${PRONUNCIATION_EXPERIMENT_EFFECT}"`
		: `name="${escapeSsml(voice)}"`;
	return [
		'<speak version="1.0" xml:lang="en-US">',
		`<voice ${voiceAttrs}>`,
		escapeSsml(text),
		'</voice>',
		'</speak>'
	].join('');
}

function buildTtsUrl(region: string, experiment: boolean): string {
	const endpoint = new URL(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`);
	if (experiment) endpoint.searchParams.set('effect', PRONUNCIATION_EXPERIMENT_EFFECT);
	return endpoint.toString();
}

async function synthesize(
	text: string,
	experiment: boolean,
	voice: string,
	region: string,
	key: string
) {
	const started = Date.now();
	const response = await fetch(buildTtsUrl(region, experiment), {
		method: 'POST',
		headers: {
			'Ocp-Apim-Subscription-Key': key,
			'Content-Type': 'application/ssml+xml',
			'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
			Accept: 'audio/wav',
			'User-Agent': 'sully-backend-ab-test'
		},
		body: buildSsml(text, voice, experiment),
		signal: AbortSignal.timeout(30000)
	});
	if (!response.ok) {
		const details = await response.text().catch(() => '');
		throw new Error(`Azure TTS HTTP ${response.status}: ${details}`);
	}
	const wav = Buffer.from(await response.arrayBuffer());
	return { wav, elapsedMs: Date.now() - started };
}

async function transcribe(wav: Buffer, region: string, key: string) {
	const started = Date.now();
	const url = new URL(
		`https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`
	);
	url.searchParams.set('language', 'en-US');
	url.searchParams.set('format', 'detailed');

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Ocp-Apim-Subscription-Key': key,
			'Content-Type': 'audio/wav',
			Accept: 'application/json'
		},
		body: wav,
		signal: AbortSignal.timeout(30000)
	});
	if (!response.ok) {
		const details = await response.text().catch(() => '');
		throw new Error(`Azure STT HTTP ${response.status}: ${details}`);
	}
	const json = (await response.json()) as {
		DisplayText?: string;
		NBest?: Array<{ Display?: string; Lexical?: string }>;
	};
	const transcript =
		json.DisplayText?.trim() ??
		json.NBest?.[0]?.Display?.trim() ??
		json.NBest?.[0]?.Lexical?.trim() ??
		'';
	return { transcript, elapsedMs: Date.now() - started };
}

function winnerFor(expected: string, baselineTranscript: string, experimentTranscript: string) {
	const target = canonicalize(expected);
	const baselineScore = levenshtein(target, canonicalize(baselineTranscript));
	const experimentScore = levenshtein(target, canonicalize(experimentTranscript));
	const winner =
		baselineScore === experimentScore
			? 'tie'
			: experimentScore < baselineScore
				? 'experiment'
				: 'baseline';
	return { baselineScore, experimentScore, winner } as const;
}

function markdownCell(text: string): string {
	return text.replaceAll('|', '\\|');
}

async function main() {
	loadDotEnv(ENV_PATH);
	const key = process.env.AZURE_SPEECH_KEY;
	const region = process.env.AZURE_SPEECH_REGION;
	const voice = process.env.AZURE_TTS_AB_TEST_VOICE?.trim() || DEFAULT_AZURE_VOICE;
	if (!key || !region) {
		throw new Error(
			`Missing Azure creds. Expected AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in ${ENV_PATH}`
		);
	}

	const samples = [
		'the RTX 5060 Ti',
		'16GB of RAM',
		'$400‑$460 range',
		'Pixel 9 Pro',
		'3.2 GHz clock'
	];

	const results: SampleResult[] = [];
	for (const input of samples) {
		const expected = speakableText(input);
		const baselineSynth = await synthesize(expected, false, voice, region, key);
		const experimentSynth = await synthesize(expected, true, voice, region, key);
		const baselineStt = await transcribe(baselineSynth.wav, region, key);
		const experimentStt = await transcribe(experimentSynth.wav, region, key);
		const verdict = winnerFor(expected, baselineStt.transcript, experimentStt.transcript);
		results.push({
			input,
			expected,
			baselineTranscript: baselineStt.transcript,
			experimentTranscript: experimentStt.transcript,
			baselineScore: verdict.baselineScore,
			experimentScore: verdict.experimentScore,
			baselineSynthMs: baselineSynth.elapsedMs,
			experimentSynthMs: experimentSynth.elapsedMs,
			baselineSttMs: baselineStt.elapsedMs,
			experimentSttMs: experimentStt.elapsedMs,
			baselineBytes: baselineSynth.wav.length,
			experimentBytes: experimentSynth.wav.length,
			winner: verdict.winner
		});
	}

	const experimentWins = results.filter((r) => r.winner === 'experiment').length;
	const baselineWins = results.filter((r) => r.winner === 'baseline').length;
	const ties = results.filter((r) => r.winner === 'tie').length;
	console.log(`Voice: ${voice}`);
	console.log(`Samples: ${results.length}`);
	console.log(`Wins: experiment=${experimentWins}, baseline=${baselineWins}, tie=${ties}`);
	console.log('');
	console.log(
		'| Sample | Expected | Baseline STT | Experiment STT | Better | Base synth ms | Exp synth ms |'
	);
	console.log('| --- | --- | --- | --- | --- | ---: | ---: |');
	for (const result of results) {
		console.log(
			`| ${markdownCell(result.input)} | ${markdownCell(result.expected)} | ${markdownCell(result.baselineTranscript || '(empty)')} | ${markdownCell(result.experimentTranscript || '(empty)')} | ${result.winner} | ${result.baselineSynthMs} | ${result.experimentSynthMs} |`
		);
	}
	console.log('');
	console.log(JSON.stringify(results, null, 2));
}

await main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
