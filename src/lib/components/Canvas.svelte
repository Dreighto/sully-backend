<script lang="ts">
	// Canvas side panel — opens a code artifact from the chat in a dedicated
	// right-anchored drawer (desktop) / full-screen modal (mobile). Borrows
	// the Claude Artifacts pattern in light form. PR A of the #20 epic:
	// view-only with syntax highlighting + copy. PR B adds multi-tab + persistence.
	//
	// Design choices:
	//   - Hosts its OWN highlight.js setup so the panel doesn't depend on a
	//     chat-message render running first (the artifact may outlive the
	//     bubble it came from once we add persistence).
	//   - Width 40% on >=lg viewports, 50% on md, full-bleed on mobile.
	//   - Escape key + backdrop click both close.
	//   - Body scroll locked while open so the drawer's overflow handles its
	//     own scrolling without competing with the chat feed underneath.

	import { onMount, onDestroy } from 'svelte';
	import { X, Copy, Check } from 'lucide-svelte';
	import hljs from 'highlight.js/lib/core';
	import bash from 'highlight.js/lib/languages/bash';
	import javascript from 'highlight.js/lib/languages/javascript';
	import typescript from 'highlight.js/lib/languages/typescript';
	import python from 'highlight.js/lib/languages/python';
	import jsonLang from 'highlight.js/lib/languages/json';
	import xml from 'highlight.js/lib/languages/xml';
	import css from 'highlight.js/lib/languages/css';
	import diff from 'highlight.js/lib/languages/diff';
	import yaml from 'highlight.js/lib/languages/yaml';
	import markdownLang from 'highlight.js/lib/languages/markdown';

	hljs.registerLanguage('bash', bash);
	hljs.registerLanguage('sh', bash);
	hljs.registerLanguage('shell', bash);
	hljs.registerLanguage('javascript', javascript);
	hljs.registerLanguage('js', javascript);
	hljs.registerLanguage('typescript', typescript);
	hljs.registerLanguage('ts', typescript);
	hljs.registerLanguage('python', python);
	hljs.registerLanguage('py', python);
	hljs.registerLanguage('json', jsonLang);
	hljs.registerLanguage('xml', xml);
	hljs.registerLanguage('html', xml);
	hljs.registerLanguage('css', css);
	hljs.registerLanguage('diff', diff);
	hljs.registerLanguage('yaml', yaml);
	hljs.registerLanguage('yml', yaml);
	hljs.registerLanguage('markdown', markdownLang);
	hljs.registerLanguage('md', markdownLang);

	let {
		code,
		language,
		title,
		onclose
	}: {
		code: string;
		language: string;
		title?: string;
		onclose: () => void;
	} = $props();

	let copied = $state(false);
	let bodyOverflowPrev = '';

	const highlighted = $derived.by(() => {
		const lang = (language || '').trim().toLowerCase();
		try {
			if (lang && hljs.getLanguage(lang)) {
				return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
			}
			if (code.length < 8000) {
				return hljs.highlightAuto(code).value;
			}
		} catch {
			/* fall through to escaped */
		}
		return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	});

	function handleKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	async function handleCopy() {
		try {
			await navigator.clipboard.writeText(code);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard unavailable */
		}
	}

	onMount(() => {
		window.addEventListener('keydown', handleKey);
		bodyOverflowPrev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
	});

	onDestroy(() => {
		window.removeEventListener('keydown', handleKey);
		document.body.style.overflow = bodyOverflowPrev;
	});

	const langLabel = $derived((language || 'text').toUpperCase());
	const headerTitle = $derived(title || `Artifact · ${langLabel}`);
	const lineCount = $derived(code.split('\n').length);
</script>

<!-- Backdrop. Click-outside closes. -->
<div
	class="canvas-backdrop"
	onclick={(e) => {
		if (e.target === e.currentTarget) onclose();
	}}
	role="presentation"
></div>

<div class="canvas-panel" role="dialog" aria-modal="true" aria-labelledby="canvas-title">
	<header class="canvas-header">
		<div class="canvas-titleblock">
			<div id="canvas-title" class="canvas-title">{headerTitle}</div>
			<div class="canvas-meta">{lineCount} lines</div>
		</div>
		<div class="canvas-actions">
			<button
				type="button"
				class="canvas-btn"
				onclick={handleCopy}
				aria-label={copied ? 'Copied' : 'Copy code'}
			>
				{#if copied}
					<Check size={14} aria-hidden="true" />
					<span>Copied</span>
				{:else}
					<Copy size={14} aria-hidden="true" />
					<span>Copy</span>
				{/if}
			</button>
			<button
				type="button"
				class="canvas-btn canvas-btn-close"
				onclick={onclose}
				aria-label="Close canvas"
			>
				<X size={14} aria-hidden="true" />
			</button>
		</div>
	</header>
	<div class="canvas-body">
		<pre class="canvas-pre"><code class="hljs language-{language}">{@html highlighted}</code></pre>
	</div>
</div>

<style>
	.canvas-backdrop {
		position: fixed;
		inset: 0;
		background: rgb(0 0 0 / 0.55);
		backdrop-filter: blur(2px);
		z-index: 70;
		animation: fade-in var(--dur-fast) ease-out;
	}

	.canvas-panel {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: 100vw;
		max-width: 100vw;
		background: #0a0a0a;
		border-left: 1px solid rgb(168 85 247 / 0.25);
		box-shadow: var(--shadow-float);
		display: flex;
		flex-direction: column;
		z-index: 71;
		animation: slide-in var(--dur-base) ease-out;
	}
	@media (min-width: 768px) {
		.canvas-panel {
			width: 50vw;
		}
	}
	@media (min-width: 1024px) {
		.canvas-panel {
			width: 42vw;
			max-width: 760px;
		}
	}

	.canvas-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: max(0.5rem, calc(env(safe-area-inset-top, 0px) + 0.5rem)) 0.75rem 0.5rem;
		border-bottom: 1px solid rgb(255 255 255 / 0.06);
		background: rgb(255 255 255 / 0.02);
	}
	.canvas-titleblock {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}
	.canvas-title {
		font-family: var(--font-mono);
		font-size: 0.72rem;
		font-weight: 500;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: rgb(216 180 254);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.canvas-meta {
		font-family: var(--font-mono);
		font-size: 0.65rem;
		color: rgb(255 255 255 / 0.4);
	}

	.canvas-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		flex-shrink: 0;
	}
	.canvas-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.3rem 0.55rem;
		background: transparent;
		border: 1px solid rgb(255 255 255 / 0.1);
		border-radius: var(--r-xs);
		color: rgb(255 255 255 / 0.7);
		font-family: var(--font-mono);
		font-size: 0.65rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			background var(--dur-fast),
			color var(--dur-fast),
			border-color var(--dur-fast);
	}
	.canvas-btn:hover {
		background: rgb(255 255 255 / 0.05);
		color: rgb(255 255 255 / 0.9);
		border-color: rgb(255 255 255 / 0.2);
	}
	.canvas-btn-close {
		padding: 0.3rem 0.4rem;
	}

	.canvas-body {
		flex: 1 1 auto;
		overflow: auto;
		background: #0a0a0a;
	}
	.canvas-pre {
		margin: 0;
		padding: 1rem 1.1rem max(1rem, calc(env(safe-area-inset-bottom, 0px) + 1rem));
		font-family: var(--font-mono);
		font-size: 0.82rem;
		line-height: 1.5;
		color: rgb(229 231 235);
	}
	.canvas-pre :global(code.hljs) {
		background: transparent;
		padding: 0;
	}

	@keyframes fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes slide-in {
		from {
			transform: translateX(100%);
		}
		to {
			transform: translateX(0);
		}
	}
</style>
