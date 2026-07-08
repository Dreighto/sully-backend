import { DOMParser } from '@xmldom/xmldom';
import { describe, it, expect } from 'vitest';
import { speakableText } from '../src/lib/server/tts_normalize';

function wrappedSsml(text: string): string {
	return `<speak version="1.0" xml:lang="en-US"><voice name="test">${text}</voice></speak>`;
}

describe('speakableText', () => {
	it('wraps clock times in Azure time tags', () => {
		expect(speakableText("It's 5:02 PM")).toBe(
			`It's <say-as interpret-as="time" format="hms12">5:02</say-as> PM`
		);
		expect(speakableText('at 5:30')).toBe(
			`at <say-as interpret-as="time" format="hms12">5:30</say-as>`
		);
		expect(speakableText('12:00 noon')).toBe(
			`<say-as interpret-as="time" format="hms12">12:00</say-as> noon`
		);
		expect(speakableText('13:05')).toBe(
			`<say-as interpret-as="time" format="hms12">13:05</say-as>`
		);
	});

	it('wraps dates, ordinals, and years in Azure date tags', () => {
		expect(speakableText('Sunday, May 31, 2026')).toBe(
			`Sunday, <say-as interpret-as="date" format="md">May 31</say-as>, <sub alias="twenty twenty-six">2026</sub>`
		);
		expect(speakableText('the 31st')).toBe(`the <say-as interpret-as="ordinal">31</say-as>`);
		expect(speakableText('2000')).toBe(`<sub alias="two thousand">2000</sub>`);
		expect(speakableText('1999')).toBe(`<sub alias="nineteen ninety-nine">1999</sub>`);
	});

	it('leaves plain integers and decimals as digits', () => {
		expect(speakableText('I have 3 things')).toBe('I have 3 things');
		expect(speakableText('3.5 hours')).toBe('3.5 hours');
	});

	it('leaves alphanumeric tokens alone', () => {
		expect(speakableText('v2 of the app')).toBe('v2 of the app');
	});

	it('wraps storage and clock units in sub tags', () => {
		expect(speakableText('16GB of RAM')).toBe('<sub alias="sixteen gigabytes">16GB</sub> of RAM');
		expect(speakableText('8 GB')).toBe('<sub alias="eight gigabytes">8 GB</sub>');
		expect(speakableText('500 MB drive')).toBe(
			'<sub alias="five hundred megabytes">500 MB</sub> drive'
		);
		expect(speakableText('2 TB')).toBe('<sub alias="two terabytes">2 TB</sub>');
		expect(speakableText('3.2 GHz clock')).toBe(
			'<sub alias="three point two gigahertz">3.2 GHz</sub> clock'
		);
	});

	it('wraps currency and currency ranges in Azure currency tags', () => {
		expect(speakableText('$1')).toBe(
			'<say-as interpret-as="currency" language="en-US">1 USD</say-as>'
		);
		expect(speakableText('$1.50')).toBe(
			'<say-as interpret-as="currency" language="en-US">1.50 USD</say-as>'
		);
		expect(speakableText('$1,145')).toBe(
			'<say-as interpret-as="currency" language="en-US">1145 USD</say-as>'
		);
		expect(speakableText('$399.99')).toBe(
			'<say-as interpret-as="currency" language="en-US">399.99 USD</say-as>'
		);
		expect(speakableText('$400‑$460 range')).toBe(
			'<say-as interpret-as="currency" language="en-US">400 USD</say-as> to <say-as interpret-as="currency" language="en-US">460 USD</say-as> range'
		);
	});

	it('keeps tech model numbers as bare digits', () => {
		expect(speakableText('the RTX 5060 Ti')).toBe('the RTX 5060 Ti');
		expect(speakableText('RTX 5080')).toBe('RTX 5080');
		expect(speakableText('iPhone 15 Pro')).toBe('iPhone 15 Pro');
		expect(speakableText('GTX 1080 Ti')).toBe('GTX 1080 Ti');
		expect(speakableText('Pixel 9')).toBe('Pixel 9');
	});

	it('produces well-formed XML when wrapped in speak/voice tags', () => {
		const parser = new DOMParser({
			onError(level, message) {
				if (level === 'warning') return;
				throw new Error(message);
			}
		});

		const samples = [
			"It's 5:02 PM on Sunday, May 31, 2026.",
			'The 31st order costs $1,145.',
			'Newegg lists the MSI 8GB version at $459.99.',
			'The 3.2 GHz clock beats the 2 TB model.',
			'The RTX 5060 Ti is in the $400‑$460 range.'
		];

		for (const sample of samples) {
			const doc = parser.parseFromString(wrappedSsml(speakableText(sample)), 'text/xml');
			expect(doc.getElementsByTagName('parsererror').length).toBe(0);
		}
	});

	it('matches the real-session SSML snapshot', () => {
		const samples = [
			'The RTX 5060 Ti is hovering in the $400‑$460 range right now.',
			'Newegg lists the MSI 8GB version at $459.99.',
			"It's 5:02 PM on Sunday, May 31, 2026.",
			'The Pixel 9 Pro has 16GB of RAM and a 3.2 GHz clock.',
			'The 31st order came to $1,145 total.'
		];

		expect(samples.map((sample) => ({ sample, ssml: speakableText(sample) }))).toMatchSnapshot();
	});
});
