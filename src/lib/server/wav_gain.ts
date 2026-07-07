// Peak-normalize a PCM WAV buffer so speech is audible on phone speakers.
//
// Why: raw TTS output (Azure included) lands around -22 to -18 LUFS with
// peaks near -6 to -4 dBFS, which reads as "very low" on iPhone speakers
// (operator finding, build 193). Production voice apps target roughly -20 to
// -16 LUFS for speech with true peak at or under -3 dBFS. We do simple peak
// normalization to -3 dBFS: deterministic, no ffmpeg, works on the
// per-sentence buffers we already hold in memory.
//
// Same defensive RIFF parsing contract as wav_pad.ts: anything that is not a
// parseable 16-bit PCM WAV is returned unchanged. Never throws.

const TARGET_PEAK_DBFS = -3;
// Cap the boost so a near-silent buffer (leading breath, room tone) cannot be
// amplified into audible noise.
const MAX_BOOST_DB = 12;

export function normalizeWavPeak(buf: Buffer): Buffer {
	if (buf.length < 44) return buf;
	if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
		return buf;
	}
	let off = 12;
	let dataOff = -1;
	let dataSize = 0;
	let bits = 16;
	let format = 1;
	while (off + 8 <= buf.length) {
		const id = buf.toString('ascii', off, off + 4);
		const sz = buf.readUInt32LE(off + 4);
		if (id === 'fmt ' && off + 24 <= buf.length) {
			format = buf.readUInt16LE(off + 8);
			bits = buf.readUInt16LE(off + 22);
		} else if (id === 'data') {
			dataOff = off + 8;
			dataSize = sz;
			break;
		}
		off += 8 + sz + (sz & 1);
	}
	if (dataOff < 0 || format !== 1 || bits !== 16) return buf;
	const end = Math.min(dataOff + dataSize, buf.length) - 1;

	let peak = 0;
	for (let i = dataOff; i + 1 <= end; i += 2) {
		const s = Math.abs(buf.readInt16LE(i));
		if (s > peak) peak = s;
	}
	if (peak === 0) return buf;

	const targetPeak = Math.round(32767 * Math.pow(10, TARGET_PEAK_DBFS / 20));
	if (peak >= targetPeak) return buf; // already at or above target, never attenuate
	const maxGain = Math.pow(10, MAX_BOOST_DB / 20);
	const gain = Math.min(targetPeak / peak, maxGain);

	const out = Buffer.from(buf);
	for (let i = dataOff; i + 1 <= end; i += 2) {
		const scaled = Math.round(out.readInt16LE(i) * gain);
		out.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i);
	}
	return out;
}
