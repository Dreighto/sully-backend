import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { speakableText } from '../src/lib/server/tts_normalize.ts';

const DEFAULT_AZURE_VOICE = 'en-US-Ava:DragonHDLatestNeural';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const ENV_PATH = resolve(REPO_ROOT, '.env');

type SampleCheck = {
	sample: string;
	expect: RegExp[];
};

type SampleResult = {
	sample: string;
	ssml: string;
	transcript: string;
	pass: boolean;
	missing: string[];
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

function buildSsml(text: string, voice: string): string {
	return [
		'<speak version="1.0" xml:lang="en-US">',
		`<voice name="${escapeSsml(voice)}">`,
		text,
		'</voice>',
		'</speak>'
	].join('');
}

async function synthesize(ssml: string, voice: string, region: string, key: string) {
	const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
		method: 'POST',
		headers: {
			'Ocp-Apim-Subscription-Key': key,
			'Content-Type': 'application/ssml+xml',
			'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
			Accept: 'audio/wav',
			'User-Agent': 'sully-backend-pronunciation-harness'
		},
		body: buildSsml(ssml, voice),
		signal: AbortSignal.timeout(30000)
	});
	if (!response.ok) {
		const details = await response.text().catch(() => '');
		throw new Error(`Azure TTS HTTP ${response.status}: ${details}`);
	}
	return Buffer.from(await response.arrayBuffer());
}

async function transcribe(wav: Buffer, region: string, key: string) {
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
	return (
		json.DisplayText?.trim() ??
		json.NBest?.[0]?.Display?.trim() ??
		json.NBest?.[0]?.Lexical?.trim() ??
		''
	);
}

function sampleChecks(): SampleCheck[] {
	return [
		{
			sample: 'The RTX 5060 Ti is hovering in the $400‑$460 range right now.',
			expect: [/rtx/i, /(5060|fifty[- ]sixty)/i, /400/i, /460/i, /range/i]
		},
		{
			sample: 'Newegg lists the MSI 8GB version at $459.99.',
			expect: [/newegg/i, /msi/i, /(8 ?gb|eight gigabytes)/i, /459/i, /99/i]
		},
		{
			sample: "It's 5:02 PM on Sunday, May 31, 2026.",
			expect: [/(5:02|five oh two)/i, /pm/i, /sunday/i, /may/i, /(31|31st)/i, /2026/i]
		},
		{
			sample: 'The Pixel 9 Pro has 16GB of RAM and a 3.2 GHz clock.',
			expect: [
				/pixel/i,
				/9/i,
				/pro/i,
				/(16 ?gb|16 gigabytes|sixteen gigabytes)/i,
				/ram/i,
				/(3\\.2|three point two)/i,
				/(ghz|gigahertz)/i
			]
		},
		{
			sample: 'The 31st order came to $1,145 total.',
			expect: [/(31|31st)/i, /order/i, /(1145|1140, five)/i, /(dollars|usd|u\\.s\\.)/i, /total/i]
		}
	];
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

	const results: SampleResult[] = [];
	for (const item of sampleChecks()) {
		const ssml = speakableText(item.sample);
		const wav = await synthesize(ssml, voice, region, key);
		const transcript = await transcribe(wav, region, key);
		const missing = item.expect.filter((pattern) => !pattern.test(transcript)).map(String);
		results.push({
			sample: item.sample,
			ssml,
			transcript,
			pass: missing.length === 0,
			missing
		});
	}

	console.log(JSON.stringify(results, null, 2));
	if (results.some((result) => !result.pass)) process.exitCode = 1;
}

await main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
