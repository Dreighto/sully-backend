<script lang="ts">
	// Markdown renderer for chat messages.
	//
	// Rendering pipeline:
	//   1. marked parses the markdown source to HTML.
	//   2. Code-block renderer is overridden to run highlight.js on the body.
	//   3. DOMPurify sanitizes the final HTML before {@html} injection.
	//
	// Why DOMPurify even though marked escapes HTML in the source: defense in
	// depth. Chat messages come from multiple senders (operator, cc, agy,
	// system) — system messages are formatted by api/chat/+server.ts and may
	// embed worker output. We never want a worker's stdout to inject script.
	//
	// Client-only render: DOMPurify needs a real DOM. On SSR we emit the raw
	// text wrapped in a div; the markdown shape comes in at hydration. Messages
	// are short enough that the flash is imperceptible.
	import { onMount } from 'svelte';
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import hljs from 'highlight.js/lib/core';

	// Lazy-register only the languages we expect in operator co-working chat.
	// Bundle size: each language is ~5-15kb; nine languages stays under 100kb
	// total which is acceptable for a primary feature. Add more if a chat
	// surfaces an unsupported language often.
	import bash from 'highlight.js/lib/languages/bash';
	import javascript from 'highlight.js/lib/languages/javascript';
	import typescript from 'highlight.js/lib/languages/typescript';
	import python from 'highlight.js/lib/languages/python';
	import jsonLang from 'highlight.js/lib/languages/json';
	import xml from 'highlight.js/lib/languages/xml'; // HTML/SVG/XML
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

	// Configure marked once. Module-scope so we don't re-configure on every
	// component instance — but the renderer override is idempotent so the
	// duplicate calls are harmless.
	marked.use({
		breaks: true, // \n becomes <br>, matches chat-message expectation
		gfm: true, // GitHub-flavored markdown (tables, strikethrough, autolinks)
		renderer: {
			code(token) {
				const lang = String(token.lang || '')
					.trim()
					.toLowerCase();
				const source = String(token.text || '');
				let body = '';
				try {
					if (lang && hljs.getLanguage(lang)) {
						body = hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
					} else if (source.length < 2000) {
						// Skip auto-detect on very long blocks — it's slow and often wrong.
						body = hljs.highlightAuto(source).value;
					} else {
						body = escapeHtml(source);
					}
				} catch {
					body = escapeHtml(source);
				}
				const cls = lang ? `language-${lang}` : '';
				const langLabel = lang ? lang : '';
				return `<div class="md-codeblock-wrap" data-lang="${escapeHtml(lang)}"><div class="md-codeblock-bar"><span class="md-codeblock-lang">${langLabel}</span><div class="md-codeblock-actions"><button type="button" class="md-codeblock-canvas" aria-label="Open in canvas"><span class="md-canvas-icon" aria-hidden="true">⌧</span><span class="md-canvas-label">Canvas</span></button><button type="button" class="md-codeblock-copy" aria-label="Copy code"><span class="md-copy-icon" aria-hidden="true">📋</span><span class="md-copy-label">Copy</span></button></div></div><pre class="md-codeblock"><code class="hljs ${cls}">${body}</code></pre></div>`;
			}
		}
	});

	function escapeHtml(s: string): string {
		return s
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	let {
		content,
		inline = false,
		oncanvas
	}: {
		content: string;
		inline?: boolean;
		oncanvas?: (code: string, language: string) => void;
	} = $props();

	let rendered = $state('');
	let mounted = $state(false);
	let containerEl = $state<HTMLDivElement | null>(null);

	onMount(() => {
		mounted = true;
	});

	// Per-codeblock Copy button. Listens at the wrapper for delegated clicks
	// on .md-codeblock-copy. Reads the adjacent <pre><code> textContent, writes
	// to clipboard, then flips the button label to "Copied" for 1500ms.
	async function handleCopyClick(e: Event) {
		const target = e.target as HTMLElement | null;
		const btn = target?.closest('.md-codeblock-copy') as HTMLButtonElement | null;
		if (!btn || !containerEl?.contains(btn)) return;
		const wrap = btn.closest('.md-codeblock-wrap');
		const code = wrap?.querySelector('pre.md-codeblock code');
		const text = code?.textContent ?? '';
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			const label = btn.querySelector('.md-copy-label');
			const icon = btn.querySelector('.md-copy-icon');
			const prevLabel = label?.textContent ?? 'Copy';
			const prevIcon = icon?.textContent ?? '📋';
			if (label) label.textContent = 'Copied';
			if (icon) icon.textContent = '✓';
			btn.classList.add('md-copy-success');
			setTimeout(() => {
				if (label) label.textContent = prevLabel;
				if (icon) icon.textContent = prevIcon;
				btn.classList.remove('md-copy-success');
			}, 1500);
		} catch {
			/* clipboard unavailable */
		}
	}

	// Canvas button — opens the code block in the side panel via the
	// `oncanvas` callback. Same delegation pattern as Copy; the callback is
	// optional, so chat surfaces that don't wire it stay silent (no error).
	function handleContainerClick(e: Event) {
		const target = e.target as HTMLElement | null;
		const canvasBtn = target?.closest('.md-codeblock-canvas') as HTMLButtonElement | null;
		if (canvasBtn && containerEl?.contains(canvasBtn)) {
			const wrap = canvasBtn.closest('.md-codeblock-wrap') as HTMLElement | null;
			const code = wrap?.querySelector('pre.md-codeblock code');
			const text = code?.textContent ?? '';
			const lang = wrap?.dataset.lang || '';
			if (text && oncanvas) oncanvas(text, lang);
			return;
		}
		// Fall through to Copy if not Canvas.
		void handleCopyClick(e);
	}

	$effect(() => {
		if (!mounted) return;
		const raw = inline
			? marked.parseInline(content || '', { async: false })
			: marked.parse(content || '', { async: false });
		rendered = DOMPurify.sanitize(String(raw), {
			// Conservative allowlist. We render trusted-but-cautious content.
			ALLOWED_TAGS: [
				'p',
				'br',
				'strong',
				'em',
				'b',
				'i',
				'u',
				's',
				'del',
				'code',
				'pre',
				'a',
				'ul',
				'ol',
				'li',
				'blockquote',
				'h1',
				'h2',
				'h3',
				'h4',
				'h5',
				'h6',
				'hr',
				'table',
				'thead',
				'tbody',
				'tr',
				'th',
				'td',
				'span',
				'div',
				'img',
				'button'
			],
			ALLOWED_ATTR: [
				'href',
				'title',
				'class',
				'target',
				'rel',
				'src',
				'alt',
				'type',
				'aria-label',
				'aria-hidden',
				'data-lang'
			],
			ADD_ATTR: ['target'],
			// Force all links to open in a new tab safely.
			FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick']
		});
	});
</script>

{#if mounted}
	<div
		bind:this={containerEl}
		class="md-content {inline ? 'md-inline' : ''}"
		onclick={handleContainerClick}
		role="presentation"
	>
		{@html rendered}
	</div>
{:else}
	<!-- SSR + first paint: render the raw text. Hydration replaces with markdown shape. -->
	<div class="md-content {inline ? 'md-inline' : ''} whitespace-pre-wrap">{content}</div>
{/if}

<style>
	/* Scoped to the rendered markdown only. Inherits color/size from the parent
	   bubble — we just style the markdown shapes (p, code, lists, etc.). */
	.md-content :global(p) {
		margin: 0;
	}
	.md-content :global(p + p),
	.md-content :global(ul + p),
	.md-content :global(ol + p),
	.md-content :global(blockquote + p),
	.md-content :global(pre + p),
	.md-content :global(p + ul),
	.md-content :global(p + ol),
	.md-content :global(p + pre),
	.md-content :global(p + blockquote) {
		margin-top: 0.5rem;
	}

	.md-content :global(strong) {
		font-weight: 600;
	}
	.md-content :global(em) {
		font-style: italic;
	}
	.md-content :global(del),
	.md-content :global(s) {
		text-decoration: line-through;
		opacity: 0.7;
	}

	/* Inline code */
	.md-content :global(code:not(pre code)) {
		background: rgb(255 255 255 / 0.06);
		border: 1px solid rgb(255 255 255 / 0.08);
		border-radius: 0.25rem;
		padding: 0.1rem 0.35rem;
		font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.92em;
		word-break: break-word;
	}

	/* Code block wrap — header bar with language + copy button, then pre below. */
	.md-content :global(.md-codeblock-wrap) {
		background: rgb(0 0 0 / 0.4);
		border: 1px solid rgb(255 255 255 / 0.08);
		border-radius: 0.5rem;
		margin: 0.5rem 0;
		overflow: hidden;
	}
	.md-content :global(.md-codeblock-bar) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.25rem 0.5rem 0.25rem 0.75rem;
		background: rgb(255 255 255 / 0.03);
		border-bottom: 1px solid rgb(255 255 255 / 0.06);
		font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.7em;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}
	.md-content :global(.md-codeblock-lang) {
		color: rgb(255 255 255 / 0.35);
	}
	.md-content :global(.md-codeblock-actions) {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.md-content :global(.md-codeblock-canvas) {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.15rem 0.4rem;
		background: transparent;
		border: 1px solid rgb(168 85 247 / 0.25);
		border-radius: 0.25rem;
		color: rgb(216 180 254);
		font-family: inherit;
		font-size: inherit;
		letter-spacing: inherit;
		text-transform: inherit;
		cursor: pointer;
		transition:
			background 120ms,
			color 120ms,
			border-color 120ms;
	}
	.md-content :global(.md-codeblock-canvas:hover) {
		background: rgb(168 85 247 / 0.12);
		color: rgb(233 213 255);
		border-color: rgb(168 85 247 / 0.5);
	}
	.md-content :global(.md-codeblock-copy) {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.15rem 0.4rem;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 0.25rem;
		color: rgb(255 255 255 / 0.45);
		font-family: inherit;
		font-size: inherit;
		letter-spacing: inherit;
		text-transform: inherit;
		cursor: pointer;
		transition:
			background 120ms,
			color 120ms;
	}
	.md-content :global(.md-codeblock-copy:hover) {
		background: rgb(255 255 255 / 0.05);
		color: rgb(255 255 255 / 0.85);
		border-color: rgb(255 255 255 / 0.1);
	}
	.md-content :global(.md-codeblock-copy.md-copy-success) {
		color: rgb(110 231 183);
	}
	/* Code block */
	.md-content :global(pre.md-codeblock) {
		background: transparent;
		border: none;
		border-radius: 0;
		padding: 0.75rem 0.9rem;
		margin: 0;
		overflow-x: auto;
		font-size: 0.85em;
		line-height: 1.45;
		font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}
	.md-content :global(pre.md-codeblock code) {
		background: transparent;
		border: none;
		padding: 0;
		font-size: inherit;
		color: inherit;
	}

	.md-content :global(a) {
		color: var(--cta, #a3e635);
		text-decoration: underline;
		text-underline-offset: 2px;
		word-break: break-word;
	}

	.md-content :global(ul),
	.md-content :global(ol) {
		margin: 0.25rem 0;
		padding-left: 1.25rem;
	}
	.md-content :global(li) {
		margin: 0.1rem 0;
	}

	.md-content :global(blockquote) {
		border-left: 2px solid rgb(255 255 255 / 0.2);
		margin: 0.5rem 0;
		padding: 0 0.75rem;
		opacity: 0.85;
	}

	.md-content :global(h1),
	.md-content :global(h2),
	.md-content :global(h3),
	.md-content :global(h4) {
		font-weight: 600;
		margin: 0.5rem 0 0.25rem 0;
		line-height: 1.3;
	}
	.md-content :global(h1) {
		font-size: 1.1em;
	}
	.md-content :global(h2) {
		font-size: 1.05em;
	}
	.md-content :global(h3),
	.md-content :global(h4) {
		font-size: 1em;
	}

	.md-content :global(hr) {
		border: 0;
		border-top: 1px solid rgb(255 255 255 / 0.1);
		margin: 0.75rem 0;
	}

	.md-content :global(img) {
		max-width: 100%;
		max-height: 60vh;
		height: auto;
		border-radius: 0.375rem;
		border: 1px solid rgb(255 255 255 / 0.08);
		margin: 0.4rem 0;
		display: block;
	}

	.md-content :global(table) {
		border-collapse: collapse;
		margin: 0.5rem 0;
		font-size: 0.92em;
	}
	.md-content :global(th),
	.md-content :global(td) {
		border: 1px solid rgb(255 255 255 / 0.1);
		padding: 0.3rem 0.6rem;
		text-align: left;
	}
	.md-content :global(th) {
		background: rgb(255 255 255 / 0.04);
		font-weight: 600;
	}

	.md-inline :global(p) {
		display: inline;
	}

	/* highlight.js atom-one-dark theme (trimmed to languages we register).
	   Inlined to avoid a separate stylesheet import + SSR FOUC. */
	.md-content :global(.hljs) {
		color: #abb2bf;
		background: transparent;
	}
	.md-content :global(.hljs-comment),
	.md-content :global(.hljs-quote) {
		color: #5c6370;
		font-style: italic;
	}
	.md-content :global(.hljs-doctag),
	.md-content :global(.hljs-keyword),
	.md-content :global(.hljs-formula) {
		color: #c678dd;
	}
	.md-content :global(.hljs-section),
	.md-content :global(.hljs-name),
	.md-content :global(.hljs-selector-tag),
	.md-content :global(.hljs-deletion),
	.md-content :global(.hljs-subst) {
		color: #e06c75;
	}
	.md-content :global(.hljs-literal) {
		color: #56b6c2;
	}
	.md-content :global(.hljs-string),
	.md-content :global(.hljs-regexp),
	.md-content :global(.hljs-addition),
	.md-content :global(.hljs-attribute),
	.md-content :global(.hljs-meta .hljs-string) {
		color: #98c379;
	}
	.md-content :global(.hljs-attr),
	.md-content :global(.hljs-variable),
	.md-content :global(.hljs-template-variable),
	.md-content :global(.hljs-type),
	.md-content :global(.hljs-selector-class),
	.md-content :global(.hljs-selector-attr),
	.md-content :global(.hljs-selector-pseudo),
	.md-content :global(.hljs-number) {
		color: #d19a66;
	}
	.md-content :global(.hljs-symbol),
	.md-content :global(.hljs-bullet),
	.md-content :global(.hljs-link),
	.md-content :global(.hljs-meta),
	.md-content :global(.hljs-selector-id),
	.md-content :global(.hljs-title) {
		color: #61afef;
	}
	.md-content :global(.hljs-built_in),
	.md-content :global(.hljs-title.class_),
	.md-content :global(.hljs-class .hljs-title) {
		color: #e6c07b;
	}
	.md-content :global(.hljs-emphasis) {
		font-style: italic;
	}
	.md-content :global(.hljs-strong) {
		font-weight: bold;
	}
</style>
