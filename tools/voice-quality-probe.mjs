// Voice-quality probe for Sully's Jetson Kokoro TTS.
//
// Captures, for a curated phrase set chosen to expose robotic / mispronunciation
// pain points: synth latency, audio duration, speaking rate, and peak level
// (clipping) — plus saves the WAVs so the operator can HEAR each case and I can
// analyze objectively. Also A/B-synthesizes a few phrases across candidate
// voices so we can pick a more natural default than the current am_fenrir.
//
// Reusable: re-run any time to detect regressions or compare voices.
// Usage: node tools/voice-quality-probe.mjs [outDir]

import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TTS = process.env.COMPANION_TTS_URL || 'http://10.10.10.2:18780';
const OUT = process.argv[2] || '/tmp/claude-1000/-home-dreighto-dev/scratchpad/voice-probe';
mkdirSync(OUT, { recursive: true });

// Phrases chosen to stress the things that usually sound robotic:
// prosody on a natural greeting, numbers/times/dates, acronyms, money/percent,
// homographs (read/read), proper nouns, and a long flowing clause chain.
const PHRASES = [
	{ id: 'greeting', text: "Hey, good to see you. How's your day going so far?" },
	{ id: 'numbers', text: "Your meeting is at 3:45 PM on July 5th, and it'll run about 90 minutes." },
	{ id: 'acronyms', text: 'The API returned a 200 from the JSON endpoint on port 18779.' },
	{ id: 'money', text: 'It came out to $42.50, which is about 15 percent off.' },
	{ id: 'homographs', text: 'I read the README yesterday, so today I read it aloud to the queue.' },
	{ id: 'nouns', text: 'Sully runs on the Jetson Orin Nano over on the local network.' },
	{
		id: 'flowing',
		text: "So the plan is: feed the cats, make sure the dogs are set, and then I'll be on standby waiting to hear what the game plan is."
	}
];

// Candidate Kokoro voices to A/B. am_fenrir is today's default; the rest are
// standard Kokoro ids — unavailable ones just error and get skipped.
const VOICES = [
	'am_fenrir',
	'bm_lewis',
	'bf_isabella',
	'af_heart',
	'af_bella',
	'am_michael',
	'am_adam',
	'bf_emma'
];

function nowMs() {
	// Date.now() is unavailable in workflow scripts but fine in a plain node run.
	return Date.now();
}

// WAV analysis (Kokoro returns 24kHz 16-bit mono PCM).
function analyzeWav(buf) {
	if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
	const sampleRate = buf.readUInt32LE(24);
	const bitsPerSample = buf.readUInt16LE(34);
	const dataBytes = buf.length - 44;
	const samples = dataBytes / (bitsPerSample / 8);
	const durationS = samples / sampleRate;
	let peak = 0;
	let sumSq = 0;
	for (let i = 44; i + 1 < buf.length; i += 2) {
		const s = buf.readInt16LE(i);
		const a = Math.abs(s);
		if (a > peak) peak = a;
		sumSq += s * s;
	}
	const rms = Math.sqrt(sumSq / samples);
	return {
		sampleRate,
		durationS: +durationS.toFixed(2),
		peakPct: +((peak / 32768) * 100).toFixed(1),
		rmsDb: +(20 * Math.log10(rms / 32768)).toFixed(1)
	};
}

// Intelligibility round-trip: send the synthesized WAV back through Jetson STT
// (whisper.cpp). If STT mishears the TTS, that's a strong automated signal the
// output is unclear / robotic / mispronounced — the exact thing that's hard to
// catch without ears. Use multipart `file=` (the `audio=` field hallucinates).
// NOTE: Node's fetch+FormData(Blob) does not serialize a multipart the Jetson
// STT bridge accepts (it hallucinates "Thanks for watching!" on the malformed
// body). curl's -F builds it correctly, so shell out against the saved WAV.
// whisper.cpp on the loaded Jetson intermittently hallucinates a YouTube-outro
// ("Thanks for watching / subscribe") or returns empty when it chokes — those
// are STT failures, NOT TTS problems, so detect + retry rather than mis-flag the
// voice. Returns { heard, sttFailed } so the report can separate the two.
const STT_HALLUCINATIONS = /thanks for watching|please subscribe|thumb up|subscribe/i;
function sttOnce(wavPath) {
	const out = execFileSync(
		'curl',
		['-s', '-m', '30', '-X', 'POST', `${TTS}/stt`, '-F', `file=@${wavPath};type=audio/wav`],
		{ encoding: 'utf8' }
	);
	try {
		return (JSON.parse(out).text || '').trim();
	} catch {
		return '';
	}
}
function transcribe(wavPath) {
	for (let attempt = 0; attempt < 3; attempt++) {
		const heard = sttOnce(wavPath);
		if (heard && !STT_HALLUCINATIONS.test(heard)) return { heard, sttFailed: false };
	}
	return { heard: sttOnce(wavPath), sttFailed: true };
}

const norm = (s) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9 ]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

// Word-level divergence: which input words did STT NOT reproduce? A short list
// of misses = likely mispronunciations to fix (dictionary/normalizer).
function divergence(input, heard) {
	const h = new Set(norm(heard).split(' '));
	const missed = norm(input)
		.split(' ')
		.filter((w) => w.length > 1 && !h.has(w));
	return missed;
}

async function synth(text, voice) {
	const t0 = nowMs();
	const r = await fetch(`${TTS}/tts`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ text, voice }),
		signal: AbortSignal.timeout(30000)
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const buf = Buffer.from(await r.arrayBuffer());
	return { buf, synthMs: nowMs() - t0 };
}

const report = [];

// 1) Which candidate voices does this Jetson actually have loaded?
const available = [];
for (const v of VOICES) {
	try {
		const { buf } = await synth('Voice check.', v);
		if (analyzeWav(buf)) available.push(v);
	} catch {
		/* not loaded */
	}
}
report.push(`Available voices: ${available.join(', ') || '(none)'}`);

// 2) Full phrase set on the CURRENT default voice.
const DEFAULT = 'am_fenrir';
report.push(`\n== Current default voice: ${DEFAULT} ==`);
report.push('phrase       synthMs  durS  rate  peak%  rmsDb');
const intelligibility = [];
for (const p of PHRASES) {
	try {
		const { buf, synthMs } = await synth(p.text, DEFAULT);
		const a = analyzeWav(buf);
		const file = `${OUT}/${DEFAULT}__${p.id}.wav`;
		writeFileSync(file, buf);
		const rate = a ? (p.text.length / a.durationS).toFixed(0) : '?';
		report.push(
			`${p.id.padEnd(12)} ${String(synthMs).padStart(6)}  ${String(a?.durationS).padStart(4)}  ${String(rate).padStart(4)}  ${String(a?.peakPct).padStart(5)}  ${String(a?.rmsDb).padStart(5)}`
		);
		let heard = '';
		let sttFailed = false;
		try {
			const t = transcribe(file);
			heard = t.heard;
			sttFailed = t.sttFailed;
		} catch (e) {
			heard = `(STT error: ${e.message})`;
			sttFailed = true;
		}
		const missed = sttFailed ? [] : divergence(p.text, heard);
		intelligibility.push({ id: p.id, text: p.text, heard, missed, sttFailed });
	} catch (e) {
		report.push(`${p.id.padEnd(12)} ERROR ${e.message}`);
	}
}

// Intelligibility: TTS→STT round-trip. Missed words = likely mispronunciations.
report.push(`\n== Intelligibility (TTS → STT round-trip; missed words = fix candidates) ==`);
for (const r of intelligibility) {
	report.push(`\n[${r.id}]`);
	report.push(`  said:  ${r.text}`);
	report.push(`  heard: ${r.heard}`);
	report.push(
		`  ${r.sttFailed ? '(STT unreliable — retried, skip)' : r.missed.length ? 'FLAG mispronounced: ' + r.missed.join(', ') : 'clean'}`
	);
}

// 3) A/B: two representative phrases across every available voice.
report.push(`\n== Voice A/B (greeting + numbers) ==`);
for (const v of available) {
	for (const pid of ['greeting', 'numbers']) {
		const p = PHRASES.find((x) => x.id === pid);
		try {
			const { buf, synthMs } = await synth(p.text, v);
			const a = analyzeWav(buf);
			const file = `${OUT}/AB__${v}__${pid}.wav`;
			writeFileSync(file, buf);
			report.push(`${v.padEnd(14)} ${pid.padEnd(9)} ${String(synthMs).padStart(5)}ms  ${a?.durationS}s  ${file}`);
		} catch (e) {
			report.push(`${v.padEnd(14)} ${pid.padEnd(9)} ERROR ${e.message}`);
		}
	}
}

const text = report.join('\n');
writeFileSync(`${OUT}/REPORT.txt`, text);
console.log(text);
console.log(`\nWAVs + REPORT.txt written to ${OUT}`);
