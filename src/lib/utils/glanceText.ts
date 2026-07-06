const IMPERATIVE_PREFIX =
	/^(?:please\s+)?(?:make|create|build|add|fix|update|research|audit|implement|write|design|ship)\s+(?:a|an|the)?\s+/i;

const LIVE_STEP_SHORTCUTS: Record<string, string> = {
	'awaiting operator action': 'Needs you',
	'awaiting instructions': 'Standing by',
	queued: 'Queued'
};

/** One-line task headline for glance surfaces (card title, Dynamic Island peek). */
export function compactGlanceTitle(title: string, maxWords = 4, maxChars = 32): string {
	let text = title.trim().replace(/\s+/g, ' ');
	if (!text) return 'Task';

	text = text.replace(IMPERATIVE_PREFIX, '');
	text = text.charAt(0).toUpperCase() + text.slice(1);

	const words = text.split(' ').filter(Boolean);
	if (words.length > maxWords) {
		return `${words
			.slice(0, maxWords)
			.join(' ')
			.replace(/[\s,.;:–-]+$/u, '')}…`;
	}

	return truncateAtWord(text, maxChars);
}

/** Short live-activity line under the title (Next banner, worker row). */
export function compactLiveStep(step: string, maxChars = 30): string {
	let text = step.trim().replace(/\s+/g, ' ');
	if (!text) return '';

	const shortcut = LIVE_STEP_SHORTCUTS[text.toLowerCase()];
	if (shortcut) return shortcut;

	if (text.includes('/')) {
		const parts = text.split('/').filter(Boolean);
		const tail = parts[parts.length - 1];
		if (tail.length <= maxChars) text = tail;
	}

	return truncateAtWord(text, maxChars);
}

export function truncateAtWord(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;

	const slice = text.slice(0, maxChars);
	const lastSpace = slice.lastIndexOf(' ');
	const cut = lastSpace > Math.floor(maxChars * 0.45) ? slice.slice(0, lastSpace) : slice.trimEnd();

	return `${cut.replace(/[\s,.;:–-]+$/u, '')}…`;
}
