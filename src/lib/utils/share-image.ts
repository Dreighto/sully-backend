// Save-image helper that adapts to the runtime.
//
// On iOS Capacitor: use @capacitor/share — opens the native share sheet
// (Save Image, Save to Files, AirDrop, Messages, etc.). The download
// attribute on <a> elements is silently ignored by iOS WebKit, which is
// what caused the operator's "tapped Download → got navigated to the bare
// image URL with no way back" trap. The share sheet is the canonical iOS
// way to save / forward content.
//
// On web (desktop / mobile browsers): try navigator.share first, then
// fall back to the <a href download> trick which DOES work on Chromium
// and Firefox. Last resort: open the image URL in a new tab so the user
// can long-press → save.
//
// All branches are async + try/catch so a single failure path never
// strands the caller in an awkward state.

import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';

export async function shareImage(
	url: string,
	title = 'Image from Sully'
): Promise<'shared' | 'downloaded' | 'opened' | 'cancelled'> {
	// Native (iOS / Android) — Capacitor Share
	if (Capacitor.isNativePlatform()) {
		try {
			await Share.share({
				title,
				url,
				dialogTitle: 'Save image'
			});
			return 'shared';
		} catch (e) {
			// User cancelled the share sheet — common and not an error.
			const msg = e instanceof Error ? e.message.toLowerCase() : '';
			if (msg.includes('cancel') || msg.includes('user dismissed')) return 'cancelled';
			// Otherwise fall through to web pattern.
		}
	}

	// Web Share API (some mobile browsers, including iOS PWAs).
	if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
		try {
			await navigator.share({ url, title });
			return 'shared';
		} catch (e) {
			const msg = e instanceof Error ? e.message.toLowerCase() : '';
			if (msg.includes('abort') || msg.includes('cancel')) return 'cancelled';
		}
	}

	// Desktop / fallback: download via anchor click. Works on Chromium and
	// Firefox. Forced to anchor-click rather than location.href so the
	// browser keeps the current page open instead of navigating away.
	try {
		const a = document.createElement('a');
		a.href = url;
		a.download = url.split('/').pop() || 'sully-image.png';
		a.rel = 'noopener';
		// Append-click-remove so Safari triggers the download properly even
		// when the anchor isn't in the document already.
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		return 'downloaded';
	} catch {
		// Absolute last resort — open the image in a new tab so the user
		// can long-press to save. NEVER use location.href = url because that
		// would navigate the current page away (the original bug).
		try {
			window.open(url, '_blank', 'noopener');
			return 'opened';
		} catch {
			return 'cancelled';
		}
	}
}
