import { appIdentity } from '$lib/server/config';

// Repo selection from message text — same keyword-scan heuristic as the
// legacy endpoint. Client may also pass an explicit `target_repo`. Exported so
// the voice pipeline derives the dispatch target the same way text does.
export function detectTargetRepo(message: string, hint?: string): string {
	if (hint) return hint;
	const text = message.toLowerCase();
	if (text.includes('miru')) return 'project-miru';
	if (
		text.includes('orchestrator') ||
		text.includes('kernel') ||
		text.includes('logueos-orchestrator')
	) {
		return 'LogueOS-Orchestrator';
	}
	if (text.includes('nasdoom')) return 'NASDOOM';
	// Phase 5 / 5a: artifact builds route to Sully's workspace — AFTER the existing-repo
	// checks above (so "fix the console build" / repo-named work still wins). Triggers on
	// an explicit workspace reference OR an artifact-creation phrase (a build verb + an
	// artifact noun like project/dashboard/mockup). Precise by design — a bare "build"
	// with no artifact noun and no workspace word falls through to the default.
	if (
		text.includes('sully-workspace') ||
		/\b(?:in|into|to|my) (?:the )?workspace\b/.test(text) ||
		/\b(?:build|create|make|generate|scaffold|draft|put|add)\b[^.!?]*\b(?:project|dashboard|mockup|artifact|site|page|app|landing)\b/.test(
			text
		)
	) {
		return 'sully-workspace';
	}
	// Fork-aware fallback: companion mode → 'companion', wired → 'LogueOS-Console'.
	return appIdentity.defaultWorkspace;
}
