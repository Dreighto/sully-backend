// artifact_sentinel.ts — the teacher's inline-artifact protocol.
//
// Mirrors the SULLY_GATE pattern (decisionGate.ts): the teacher emits a sentinel
// block in its reply, and the backend extracts it, promotes the inline content
// to the durable artifact store (so it shows in the library + cards with
// provenance source_worker="teacher"), and strips the block from the displayed/
// persisted text. This is the consistent path for the CLI-bridge teacher (which
// has --tools "" — no callable tools), and works for the local/SDK path too.
//
// Format the teacher emits (taught in the system prompt):
//   <<<SULLY_ARTIFACT {"type":"doc|plan|code|data","title":"…","language":"…"}>>>
//   …the artifact content…
//   <<<END_SULLY_ARTIFACT>>>

import {
	promoteInlineArtifacts,
	type InlineArtifactInput,
	type ArtifactMetadata
} from '$lib/server/artifactStore';

// Opening sentinel (self-delimited by `>>>`, like SULLY_GATE). The CLOSE tag is
// OPTIONAL — LLMs are unreliable with paired delimiters, so we treat content as
// running to the close tag, the next opening sentinel, or end-of-message.
const OPEN_RE = /<<<SULLY_ARTIFACT\s*(\{[\s\S]*?\})\s*>>>/g;
const CLOSE_TAG = '<<<END_SULLY_ARTIFACT>>>';

// Non-global (no lastIndex state) variant used to decide whether the live
// "generating…" card should fire mid-stream. Same header shape as OPEN_RE plus
// a capture of everything after the closing `>>>` so we can require content.
const LIVE_OPEN_RE = /<<<SULLY_ARTIFACT\s*(\{[\s\S]*?\})\s*>>>([\s\S]*)/;

/** True if the text contains an artifact sentinel — cheap pre-check. */
export function hasArtifactSentinel(text: string): boolean {
	return text.includes('<<<SULLY_ARTIFACT');
}

/**
 * True only for a sentinel that would actually promote: a complete opening
 * sentinel (`<<<SULLY_ARTIFACT {header}>>>`) with a parseable JSON header AND
 * at least one non-whitespace byte of content before the close tag. Mirrors the
 * promote-eligibility test in extractAndPromoteArtifacts so the mid-stream live
 * card can never outlive a block that won't be promoted (no ghost cards).
 */
export function hasLiveArtifactSignal(text: string): boolean {
	const m = text.match(LIVE_OPEN_RE);
	if (!m) return false;
	try {
		JSON.parse(m[1]);
	} catch {
		return false;
	}
	const after = m[2].split(CLOSE_TAG)[0];
	return after.trim().length > 0;
}

/**
 * Extract every SULLY_ARTIFACT block from `text`, promote each to the durable
 * store, and return the prose with the blocks stripped. Lenient: a block runs
 * from its opening sentinel to (whichever comes first) the close tag, the next
 * opening sentinel, or end-of-text — so a forgotten close tag doesn't drop the
 * artifact or leak the raw block.
 */
export function extractAndPromoteArtifacts(
	text: string,
	ctx: { threadId?: string; taskId?: string } = {},
	forcedTraceId?: string
): { strippedText: string; artifacts: ArtifactMetadata[] } {
	if (!hasArtifactSentinel(text)) return { strippedText: text, artifacts: [] };

	// Collect opening sentinels with their header + body span.
	type Block = { start: number; end: number; header: string; content: string };
	const blocks: Block[] = [];
	const opens: { index: number; header: string; bodyStart: number }[] = [];
	let m: RegExpExecArray | null;
	OPEN_RE.lastIndex = 0;
	while ((m = OPEN_RE.exec(text)) !== null) {
		opens.push({ index: m.index, header: m[1], bodyStart: m.index + m[0].length });
	}
	for (let i = 0; i < opens.length; i++) {
		const o = opens[i];
		const nextOpen = i + 1 < opens.length ? opens[i + 1].index : text.length;
		const closeIdx = text.indexOf(CLOSE_TAG, o.bodyStart);
		const bodyEnd = closeIdx !== -1 && closeIdx < nextOpen ? closeIdx : nextOpen;
		const end = closeIdx !== -1 && closeIdx < nextOpen ? closeIdx + CLOSE_TAG.length : nextOpen;
		blocks.push({
			start: o.index,
			end,
			header: o.header,
			content: text.slice(o.bodyStart, bodyEnd).replace(/^\n+|\n+$/g, '')
		});
	}

	// Collect every well-formed block as one input batch, strip it from the prose,
	// then promote the whole batch under ONE shared trace so the turn's artifacts
	// group into a single inline card. A malformed header keeps its raw block.
	const inputs: InlineArtifactInput[] = [];
	let stripped = '';
	let cursor = 0;
	for (const b of blocks) {
		stripped += text.slice(cursor, b.start);
		cursor = b.end;
		let meta: { type?: unknown; title?: unknown; language?: unknown };
		try {
			meta = JSON.parse(b.header);
		} catch {
			// malformed header — keep the raw block rather than lose the content
			stripped += text.slice(b.start, b.end);
			continue;
		}
		if (!b.content.trim()) continue;
		inputs.push({
			content: b.content,
			artifactType: typeof meta.type === 'string' ? meta.type : 'doc',
			title: typeof meta.title === 'string' ? meta.title : 'Artifact',
			language: typeof meta.language === 'string' ? meta.language : undefined,
			threadId: ctx.threadId,
			taskId: ctx.taskId
		});
	}
	stripped += text.slice(cursor);

	const artifacts = promoteInlineArtifacts(inputs, forcedTraceId);
	const strippedText = stripped.replace(/\n{3,}/g, '\n\n').trim();
	return { strippedText, artifacts };
}

/**
 * One-call wrapper for reply-persist sites: extract + promote any inline
 * artifact blocks and return the stripped text plus the artifact trace id to
 * stamp on the persisted row. Falls back to the raw text when no sentinel is
 * present (or extraction yields nothing). Wired into the LOCAL and direct-SDK
 * paths 2026-07-07 — previously only the CLI-bridge teacher ran extraction,
 * so a local-model artifact (DeepSeek "architecture map", thread of 07-07)
 * was generated, never promoted, and the operator saw nothing.
 */
export function extractForPersist(
	text: string,
	ctx: { threadId?: string; taskId?: string } = {}
): { text: string; artifactTraceId: string | null } {
	// Deterministic per-task trace: a regenerate/retry of the same Task
	// re-promotes into the SAME store dir instead of minting an orphan
	// duplicate on every attempt (in-house review finding, 2026-07-07).
	const forced = ctx.taskId ? `sully-teacher-${ctx.taskId}` : undefined;
	const { strippedText, artifacts } = extractAndPromoteArtifacts(text, ctx, forced);
	// Fall back to the raw text ONLY when nothing was extracted. If the whole
	// reply WAS the artifact block, stripping leaves '' — re-emitting the raw
	// sentinel there would resurface the original bug (CodeRabbit, PR #114).
	const fallback = artifacts.length > 0 ? 'Artifact ready — open the card to view it.' : text;
	return { text: strippedText || fallback, artifactTraceId: artifacts[0]?.trace_id ?? null };
}
