// Resume an in-flight sdk-stream turn (AI SDK v6 resumable-stream pattern,
// single-user in-memory variant). While a direct turn generates, its UIMessage
// chunks are buffered per thread in sdk_stream_common; this endpoint replays
// the buffered chunks from ?startIndex=N as an SSE UIMessage stream, then
// continues live until the turn finishes. When no stream is active for the
// thread (idle, finished, errored, or rolled back) it returns 204.

import type { RequestHandler } from './$types';
import { hasActiveStream, streamResponseFromBuffer } from '$lib/server/chat/sdk_stream_common';

export const GET: RequestHandler = ({ url }) => {
	const threadParam = url.searchParams.get('thread');
	const threadId = threadParam && threadParam.trim() ? threadParam.trim() : 'default';

	const rawStart = Number(url.searchParams.get('startIndex') ?? '0');
	const startIndex = Number.isFinite(rawStart) && rawStart > 0 ? Math.floor(rawStart) : 0;

	if (!hasActiveStream(threadId)) return new Response(null, { status: 204 });
	return streamResponseFromBuffer(threadId, startIndex);
};
