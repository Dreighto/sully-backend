<!-- src/lib/work-surface/hybrid/HybridDetailSheet.svelte -->
<script lang="ts">
	import { base } from '$app/paths';
	import { Dialog } from 'bits-ui';
	import { useSwipe, type SwipeCustomEvent } from 'svelte-gestures';
	import type { SeedSurface } from './hybrid-types';

	let {
		surface,
		onclose
	}: {
		surface: SeedSurface;
		onclose: () => void;
	} = $props();

	let open = $state(true);

	// Swipe-down to dismiss. useSwipe() returns props to spread on the touch target.
	// Applied to the WHOLE swipe-zone (handle + header) so a phone gesture doesn't
	// need to hit the 28px handle precisely. minSwipeDistance lowered to 40px and
	// timeframe widened to 360ms — easier to trigger on a real iPhone in flow.
	const handleSwipeProps = useSwipe(
		(e: SwipeCustomEvent) => {
			if (e.detail.direction === 'bottom') {
				open = false;
				onclose();
			}
		},
		() => ({ timeframe: 360, minSwipeDistance: 40, touchAction: 'pan-y' })
	);

	function close() {
		open = false;
		onclose();
	}

	const PHASE_LABELS: Record<string, string> = {
		read: 'Read',
		research: 'Research',
		build: 'Build',
		check: 'Check',
		approve: 'Approve',
		reply: 'Reply'
	};

	const FILE_STATUS_LABELS: Record<string, string> = {
		available: 'Available',
		generating: 'Generating…',
		'needs-approval': 'Needs approval',
		failed: 'Failed',
		superseded: 'Superseded'
	};

	function fmtBytes(b?: number) {
		if (!b) return '';
		if (b < 1024) return `${b} B`;
		if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
		return `${(b / (1024 * 1024)).toFixed(1)} MB`;
	}

	/** Render activity timestamps as relative time when fresh, absolute clock when older. */
	function formatActivityTime(ts: string): string {
		if (!ts) return '';
		const t = Date.parse(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
		if (Number.isNaN(t)) return ts;
		const ageMs = Date.now() - t;
		const ageSec = Math.floor(ageMs / 1000);
		if (ageSec < 60) return `${Math.max(ageSec, 0)}s ago`;
		const ageMin = Math.floor(ageSec / 60);
		if (ageMin < 60) return `${ageMin}m ago`;
		const d = new Date(t);
		return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}

	const traceId = $derived(surface.surfaceId);
	const availableFiles = $derived(surface.files.filter((f) => f.status === 'available'));

	function artifactUrl(filePath: string, download = false): string {
		const segments = filePath.split('/').map((s) => encodeURIComponent(s));
		const url = `${base}/api/artifacts/${encodeURIComponent(traceId)}/${segments.join('/')}`;
		return download ? `${url}?download=1` : url;
	}

	function bundleUrl(): string {
		return `${base}/api/artifacts/${encodeURIComponent(traceId)}/bundle.zip`;
	}

	function openFile(filePath: string) {
		window.open(artifactUrl(filePath), '_blank', 'noopener,noreferrer');
	}

	async function shareFile(filePath: string) {
		const url = artifactUrl(filePath);
		if (typeof navigator !== 'undefined' && navigator.share) {
			try {
				await navigator.share({ title: filePath, url });
				return;
			} catch {
				// User cancelled or share failed — fall through to copy.
			}
		}
		await copyText(url);
	}

	async function copyPath(filePath: string) {
		await copyText(filePath);
	}

	async function copyText(text: string) {
		if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
		}
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(v) => {
		if (!v) onclose();
	}}
>
	<Dialog.Portal>
		<Dialog.Overlay class="sheet-overlay" onclick={close} />
		<Dialog.Content
			class="sheet-content"
			data-testid="detail-sheet"
			aria-label="Task detail — {surface.title}"
		>
			<!-- Swipe-down dismiss wrapper covers BOTH the visible handle AND the
				 header (title + X), so a downward swipe anywhere on the top of the
				 sheet closes it, not just on the 28px handle pip. -->
			<div class="sheet-swipe-zone" {...handleSwipeProps}>
				<div class="sheet-handle-zone">
					<div class="sheet-handle" aria-hidden="true"></div>
				</div>

				<!-- bits-ui v2 requires a Title + Description or it logs a console error. Screen-reader-only. -->
				<Dialog.Title class="sr-only">{surface.title}</Dialog.Title>
				<Dialog.Description class="sr-only">Task detail for {surface.title}</Dialog.Description>

				<!-- Header -->
				<div class="sheet-header">
					<span class="sheet-title">{surface.title}</span>
					<Dialog.Close class="sheet-close" aria-label="Close" onclick={close}>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							aria-hidden="true"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</Dialog.Close>
				</div>
			</div>
			<!-- /sheet-swipe-zone -->

			<div class="sheet-body">
				<!-- Activity log — what the worker actually did, plain English -->
				{#if (surface.activity ?? []).length > 0}
					<section class="sheet-section">
						<h2 class="sheet-section-label">Activity</h2>
						<div class="activity-log">
							{#each surface.activity as entry, i (`${entry.timestamp}_${i}_${entry.action}`)}
								<div class="activity-row" data-testid="activity-row" data-action={entry.action}>
									<span class="activity-time">{formatActivityTime(entry.timestamp)}</span>
									<span class="activity-text">{entry.description}</span>
								</div>
							{/each}
						</div>
					</section>
				{/if}

				<!-- Stage timeline -->
				<section class="sheet-section">
					<h2 class="sheet-section-label">Stage timeline</h2>
					<div class="timeline">
						{#each surface.phases as phase}
							<div
								class="timeline-row timeline-row--{phase.status}"
								data-testid="timeline-row"
								data-phase={phase.key}
								data-status={phase.status}
							>
								<div class="timeline-dot timeline-dot--{phase.status}" aria-hidden="true"></div>
								<span
									class="timeline-label"
									class:timeline-label--skipped={phase.status === 'skipped'}
								>
									{PHASE_LABELS[phase.key]}
								</span>
								<span class="timeline-time">
									{phase.status === 'skipped'
										? 'skipped'
										: (phase.endedAt ?? phase.startedAt ?? '—')}
								</span>
							</div>
							{#if phase.status === 'skipped' && phase.reason}
								<div class="timeline-reason" data-testid="skipped-full-reason">
									{phase.reason}
								</div>
							{/if}
						{/each}
					</div>
				</section>

				<!-- Result files (only when files exist) -->
				{#if surface.files.length > 0}
					<section class="sheet-section">
						<div class="section-header">
							<h2 class="sheet-section-label">Result files</h2>
							{#if availableFiles.length > 0}
								<a
									class="download-all-btn"
									href={bundleUrl()}
									download
									data-testid="download-all-btn"
								>
									Download all ({availableFiles.length})
								</a>
							{/if}
						</div>
						<div class="file-list">
							{#each surface.files as file}
								<div class="file-entry" data-testid="file-entry" data-status={file.status}>
									<div class="file-dot file-dot--{file.status}" aria-hidden="true"></div>
									{#if file.status === 'available'}
										<button
											type="button"
											class="file-name file-name--link"
											data-testid="file-open"
											onclick={() => openFile(file.path)}
										>
											{file.path}
										</button>
										<span class="file-meta">{fmtBytes(file.sizeBytes)}</span>
										<div class="file-actions">
											<button
												type="button"
												class="file-action-btn"
												data-testid="file-share"
												aria-label="Share {file.path}"
												onclick={() => shareFile(file.path)}
											>
												Share
											</button>
											<a
												class="file-action-btn"
												href={artifactUrl(file.path, true)}
												download
												data-testid="file-download"
											>
												Download
											</a>
											<button
												type="button"
												class="file-action-btn"
												data-testid="file-copy-path"
												aria-label="Copy path for {file.path}"
												onclick={() => copyPath(file.path)}
											>
												Copy path
											</button>
										</div>
									{:else}
										<span
											class="file-name"
											class:file-name--superseded={file.status === 'superseded'}
										>
											{file.path}
										</span>
										<span class="file-meta">{fmtBytes(file.sizeBytes)}</span>
										<span class="file-label file-label--{file.status}">
											{FILE_STATUS_LABELS[file.status] ?? file.status}
										</span>
									{/if}
								</div>
							{/each}
						</div>
					</section>
				{/if}

				<!-- Worker registry -->
				<section class="sheet-section">
					<h2 class="sheet-section-label">Workers</h2>
					{#each surface.workers as worker}
						<div class="worker-entry">
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								style="color: {worker.color}; flex: none;"
								aria-hidden="true"
							>
								<use href="#{worker.iconId}" />
							</svg>
							<span class="worker-code">{worker.shortcode}</span>
							<span class="worker-step">{worker.currentStep}</span>
						</div>
					{/each}
				</section>
			</div>

			<!-- Actions -->
			<div class="sheet-actions">
				<button class="sheet-btn sheet-btn--cancel" type="button" onclick={close}>Close</button>
				{#if surface.aggr === 'failed'}
					<button class="sheet-btn sheet-btn--retry" type="button">Retry</button>
				{/if}
				{#if surface.aggr === 'running' || surface.aggr === 'needs-you'}
					<button class="sheet-btn sheet-btn--stop" type="button">Stop task</button>
				{/if}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	:global(.sheet-overlay) {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		z-index: 49;
		animation: fade-in 0.2s ease-out;
	}
	:global(.sheet-content) {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		max-height: 88dvh;
		background: var(--color-surface);
		border-radius: 20px 20px 0 0;
		border-top: 1px solid var(--color-edge);
		overflow-y: auto;
		z-index: 50;
		padding-bottom: env(safe-area-inset-bottom, 16px);
		animation: slide-up 0.28s cubic-bezier(0.32, 0.72, 0, 1);
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.sheet-overlay),
		:global(.sheet-content) {
			animation: none !important;
		}
		:global(.file-dot--generating) {
			animation: none !important;
		}
	}

	.sheet-handle-zone {
		display: flex;
		justify-content: center;
		padding: 12px;
		cursor: grab;
	}
	.sheet-handle {
		width: 36px;
		height: 4px;
		border-radius: 2px;
		background: var(--color-edge-active);
	}
	.sheet-header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 16px 10px;
		border-bottom: 1px solid var(--color-edge);
	}
	.sheet-title {
		flex: 1;
		font-size: 14px;
		font-weight: 600;
		color: var(--color-text, #e8eaf0);
	}
	:global(.sheet-close) {
		width: 44px;
		height: 44px;
		border-radius: 50%;
		background: var(--color-surface-raised);
		border: none;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--color-st-done);
	}

	.sheet-section {
		padding: 14px 16px;
		border-bottom: 1px solid var(--color-edge);
	}
	.section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 10px;
	}
	.sheet-section-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-st-done);
		margin-bottom: 0;
	}
	.download-all-btn {
		font-size: 11px;
		font-weight: 600;
		color: var(--color-brand);
		background: transparent;
		border: 1px solid var(--color-brand);
		border-radius: 6px;
		padding: 4px 10px;
		cursor: pointer;
		min-height: 44px;
		display: flex;
		align-items: center;
		justify-content: center;
		text-decoration: none;
	}
	.download-all-btn:hover {
		background: rgba(207, 111, 147, 0.08);
	}

	/* ── Timeline ── */
	.timeline {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 10px;
	}
	.timeline-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
	}
	.timeline-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex: none;
	}
	.timeline-dot--done {
		background: var(--color-st-done);
	}
	.timeline-dot--active {
		background: var(--color-brand);
	}
	.timeline-dot--failed {
		background: var(--color-st-fail);
	}
	.timeline-dot--needs-you {
		background: var(--color-st-needs);
	}
	.timeline-dot--pending {
		background: var(--color-edge-active);
	}
	.timeline-dot--blocked {
		background: var(--color-st-needs);
	}
	.timeline-dot--skipped {
		background: transparent;
		border: 1.5px dashed var(--color-edge-active);
	}
	.timeline-label {
		font-weight: 500;
		color: var(--color-text, #e8eaf0);
	}
	.timeline-label--skipped {
		text-decoration: line-through;
		opacity: 0.5;
	}
	.timeline-time {
		flex: 1;
		text-align: right;
		color: var(--color-st-done);
		font-size: 11px;
	}
	.timeline-reason {
		padding: 2px 0 4px 15px;
		font-size: 11px;
		font-style: italic;
		color: var(--color-st-done);
	}

	/* ── File list ── */
	.file-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.file-entry {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 10px;
		padding: 10px 0;
		border-bottom: 1px solid var(--color-edge);
		font-size: 12px;
	}
	.file-entry:last-child {
		border-bottom: none;
	}
	.file-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex: none;
	}
	.file-dot--available {
		background: #4a9a6a;
	}
	.file-dot--generating {
		background: var(--color-st-run);
		animation: breath 1.2s ease-in-out infinite;
	}
	.file-dot--needs-approval {
		background: var(--color-st-needs);
	}
	.file-dot--failed {
		background: var(--color-st-fail);
	}
	.file-dot--superseded {
		background: var(--color-st-done);
	}
	.file-name {
		flex: 1 1 100%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--color-text, #e8eaf0);
		min-width: 0;
	}
	.file-name--link {
		background: none;
		border: none;
		padding: 0;
		text-align: left;
		cursor: pointer;
		font: inherit;
		color: var(--color-brand);
		text-decoration: underline;
		text-underline-offset: 2px;
		min-height: 44px;
	}
	.file-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		flex: 1 1 100%;
	}
	.file-action-btn {
		font-size: 10px;
		font-weight: 600;
		padding: 6px 10px;
		border-radius: 6px;
		border: 1px solid var(--color-edge);
		background: var(--color-surface-raised);
		color: var(--color-st-done);
		cursor: pointer;
		min-height: 44px;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.file-action-btn:hover {
		border-color: var(--color-brand);
		color: var(--color-brand);
	}
	.file-name--superseded {
		text-decoration: line-through;
		opacity: 0.5;
	}
	.file-meta {
		font-size: 10.5px;
		color: var(--color-st-done);
		flex: none;
	}
	.file-label {
		font-size: 10px;
		font-weight: 600;
		padding: 2px 6px;
		border-radius: 4px;
		flex: none;
		white-space: nowrap;
	}
	.file-label--available {
		background: rgba(74, 154, 106, 0.12);
		color: #4a9a6a;
	}
	.file-label--needs-approval {
		background: rgba(201, 163, 78, 0.12);
		color: var(--color-st-needs);
	}
	.file-label--superseded {
		background: var(--color-surface-raised);
		color: var(--color-st-done);
	}
	.file-label--generating {
		background: rgba(212, 212, 216, 0.12);
		color: var(--color-st-run);
	}
	.file-label--failed {
		background: rgba(194, 91, 91, 0.12);
		color: var(--color-st-fail);
	}

	/* ── Worker registry ── */
	.worker-entry {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 0;
		font-size: 12px;
	}
	.worker-code {
		font-size: 10px;
		font-weight: 700;
		padding: 1px 5px;
		border-radius: 3px;
		background: var(--color-surface-raised);
		color: var(--color-st-done);
		flex: none;
	}
	.worker-step {
		flex: 1;
		color: var(--color-st-done);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	/* ── Actions ── */
	.sheet-actions {
		display: flex;
		gap: 8px;
		padding: 12px 16px;
	}
	.sheet-btn {
		flex: 1;
		padding: 10px;
		border-radius: 10px;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		border: none;
		min-height: 44px;
	}
	.sheet-btn--cancel {
		background: var(--color-surface-raised);
		color: var(--color-st-done);
		border: 1px solid var(--color-edge);
	}
	.sheet-btn--retry {
		background: var(--color-surface-raised);
		color: white;
		border: 1px solid var(--color-edge);
	}
	.sheet-btn--stop {
		background: rgba(194, 91, 91, 0.12);
		color: var(--color-st-fail);
		border: 1px solid var(--color-st-fail);
	}

	@keyframes fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes slide-up {
		from {
			transform: translateY(100%);
		}
		to {
			transform: translateY(0);
		}
	}
	@keyframes breath {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}

	.sheet-swipe-zone {
		touch-action: pan-y;
	}

	/* ── Activity log ── */
	.activity-log {
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-height: 280px;
		overflow-y: auto;
		padding-right: 4px;
	}
	.activity-row {
		display: flex;
		gap: 10px;
		font-size: 13px;
		line-height: 1.45;
		padding: 6px 8px;
		border-radius: 6px;
		background: var(--color-surface-raised, rgba(255, 255, 255, 0.02));
		border: 1px solid var(--color-edge, rgba(255, 255, 255, 0.06));
		align-items: baseline;
	}
	.activity-row[data-action='completed'],
	.activity-row[data-action='synthesis_completed'],
	.activity-row[data-action='reply_persisted'] {
		border-color: color-mix(in srgb, var(--color-st-done) 35%, var(--color-edge));
	}
	.activity-row[data-action='verification_poll'],
	.activity-row[data-action='adversary_reviewed'] {
		border-color: color-mix(in srgb, var(--color-st-needs) 25%, var(--color-edge));
	}
	.activity-time {
		flex: none;
		font-size: 11px;
		color: var(--color-st-done);
		font-variant-numeric: tabular-nums;
		min-width: 56px;
	}
	.activity-text {
		flex: 1 1 0;
		min-width: 0;
		color: var(--color-text, #e8eaf0);
		word-break: break-word;
	}
</style>
