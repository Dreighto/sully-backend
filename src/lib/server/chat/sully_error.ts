// Typed error frames. Every sdk-stream error path emits a `data-sully-error`
// data part {code, message, recovery} IN ADDITION to the SDK-standard error
// part, so the client can render an actionable recovery hint instead of a raw
// provider string. Shared by sdk_cli_reply / sdk_local_reply / sdk_direct_reply
// / +server.ts (this module is the one scope-shared home for the helpers).
// Deliberately dependency-free (pure) — split out of sdk_direct_reply.ts
// (Wave 4, 2026-07-06) so error-frame unit tests don't need to stub the
// DB/dispatch modules the rest of that file drags in at import time.

export type SullyErrorCode =
	| 'credential_unavailable'
	| 'rate_limit'
	| 'timeout'
	| 'provider_error'
	| 'context_overflow'
	| 'unknown';

export type SullyErrorFrame = {
	code: SullyErrorCode;
	message: string;
	recovery: string;
};

const SULLY_ERROR_RECOVERY: Record<SullyErrorCode, string> = {
	credential_unavailable: 'Switch model — this one is missing a working credential.',
	rate_limit: 'Retry in ~30s or switch model.',
	timeout: 'Retry — the provider did not answer in time.',
	provider_error: 'Retry, or switch model if it keeps failing.',
	context_overflow: 'Start a new thread — this one exceeds the model context window.',
	unknown: 'Retry, or switch model if it persists.'
};

export function sullyErrorFrame(code: SullyErrorCode, message: string): SullyErrorFrame {
	return { code, message, recovery: SULLY_ERROR_RECOVERY[code] };
}

/** Auto mode may silently try the next provider when these occur before any text. */
export function isAutoFallbackableError(code: SullyErrorCode): boolean {
	return (
		code === 'rate_limit' ||
		code === 'provider_error' ||
		code === 'credential_unavailable' ||
		code === 'timeout' ||
		code === 'unknown'
	);
}

export function classifySullyError(message: string, statusCode?: number): SullyErrorFrame {
	const msg = message || 'unknown_stream_error';
	const m = msg.toLowerCase();
	let code: SullyErrorCode = 'unknown';
	if (statusCode === 404 || /not.?found|model.*not found|does not exist|unknown model/.test(m)) {
		code = 'provider_error';
	} else if (
		statusCode === 401 ||
		statusCode === 403 ||
		/credential unavailable|authentication|permission|api key|unauthorized|token expired|auth failed/.test(
			m
		)
	) {
		code = 'credential_unavailable';
	} else if (statusCode === 429 || /rate.?limit|too many requests|quota exceeded/.test(m)) {
		code = 'rate_limit';
	} else if (/timed? ?out|etimedout|abort|deadline exceeded/.test(m)) {
		code = 'timeout';
	} else if (
		/context.{0,24}(window|length|overflow)|prompt is too long|too many tokens|maximum context|token limit exceeded/.test(
			m
		)
	) {
		code = 'context_overflow';
	} else if (
		(statusCode !== undefined && statusCode >= 500) ||
		/overloaded|internal server|bad gateway|service unavailable|econnrefused|econnreset|fetch failed|socket hang up/.test(
			m
		)
	) {
		code = 'provider_error';
	}
	return sullyErrorFrame(code, msg);
}

// Structural writer type (same pattern as ReplyIdWriter in sdk_stream_common)
// so any UIMessageStream writer satisfies it without dragging generics around.
export type SullyErrorWriter = {
	write: (chunk: { type: 'data-sully-error'; data: SullyErrorFrame }) => void;
};

export function emitSullyError(writer: SullyErrorWriter, frame: SullyErrorFrame): void {
	try {
		writer.write({ type: 'data-sully-error', data: frame });
	} catch {
		/* stream already closed — the SDK-standard error part remains the fallback */
	}
}
