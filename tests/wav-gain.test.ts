import { describe, expect, it } from 'vitest';
import { normalizeWavPeak } from '../src/lib/server/wav_gain';

function makeWav(samples: number[]): Buffer {
	const data = Buffer.alloc(samples.length * 2);
	samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
	const header = Buffer.alloc(44);
	header.write('RIFF', 0, 'ascii');
	header.writeUInt32LE(36 + data.length, 4);
	header.write('WAVE', 8, 'ascii');
	header.write('fmt ', 12, 'ascii');
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(24000, 24);
	header.writeUInt32LE(24000 * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36, 'ascii');
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

function peakOf(buf: Buffer): number {
	let peak = 0;
	for (let i = 44; i + 1 < buf.length; i += 2) {
		peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
	}
	return peak;
}

const TARGET = Math.round(32767 * Math.pow(10, -3 / 20)); // -3 dBFS

describe('normalizeWavPeak', () => {
	it('boosts quiet audio to the -3 dBFS target', () => {
		const quiet = makeWav([2000, -3000, 1500, -2500]); // peak 3000, well below target
		const out = normalizeWavPeak(quiet);
		expect(peakOf(out)).toBeGreaterThan(peakOf(quiet));
		expect(peakOf(out)).toBeLessThanOrEqual(TARGET + 1);
	});

	it('caps the boost at 12 dB for near-silent audio', () => {
		const nearSilent = makeWav([100, -80, 60]);
		const out = normalizeWavPeak(nearSilent);
		const maxGain = Math.pow(10, 12 / 20);
		expect(peakOf(out)).toBeLessThanOrEqual(Math.ceil(100 * maxGain) + 1);
	});

	it('never attenuates audio already at or above target', () => {
		const loud = makeWav([30000, -31000, 29000]);
		const out = normalizeWavPeak(loud);
		expect(out.equals(loud)).toBe(true);
	});

	it('returns non-WAV buffers unchanged', () => {
		const junk = Buffer.from('not a wav file at all, just text padding to 44+ bytes......');
		expect(normalizeWavPeak(junk).equals(junk)).toBe(true);
	});

	it('returns silent audio unchanged', () => {
		const silent = makeWav([0, 0, 0, 0]);
		expect(normalizeWavPeak(silent).equals(silent)).toBe(true);
	});
});
