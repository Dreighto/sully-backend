// Composer state controller — extracted from chat/+page.svelte (PR E3).
//
// Owns: textDraft, attachments, isDragging, draftPersistFailing + the 400ms
// debounced draft autosave $effect + paste-to-attachment + uploads + drag/drop.
// Bindable state is exposed via paired get/set so <Composer bind:textDraft=…>
// keeps working — same pattern as the threads controller.
//
// Composer's send-readiness formula (canSend) is INTENTIONALLY NOT moved here:
// the legacy + SDK send paths early-return on different signals (imageMode +
// composerMode + sending), and the canSend check is consumed by both the page's
// sendMessage and Composer's disabled gate. PR E4 will own the send path and
// can collapse this if it makes sense then.

import { resolve } from '$app/paths';
import { toasts } from '$lib/utils/toasts';
import type { Attachment } from '$lib/types/chat-ui';

const PASTE_TO_ATTACHMENT_THRESHOLD = 5000;

export interface ComposerDeps {
	getActiveThread: () => string;
	getSelectedRepo: () => string;
	/** Re-focus the textarea after a drop / paperclip upload completes. */
	focusComposer: () => void;
}

export interface ComposerStateController {
	textDraft: string; // bindable
	attachments: Attachment[]; // bindable
	isDragging: boolean; // bindable
	readonly draftPersistFailing: boolean;
	handlePaste: (e: ClipboardEvent) => void;
	handleUpload: (e: Event) => Promise<void>;
	uploadOneFile: (file: File) => Promise<void>;
	handleDragEnter: (e: DragEvent) => void;
	handleDragOver: (e: DragEvent) => void;
	handleDragLeave: (e: DragEvent) => void;
	handleDrop: (e: DragEvent) => Promise<void>;
	removeAttachment: (id: string) => void;
	/** Append speech-dictated text to the draft (called by voice controller). */
	appendText: (s: string) => void;
	clearAttachments: () => void;
	/** onDestroy hook — clears the draft-persist timer. */
	destroy: () => void;
}

export function createComposerStateController(deps: ComposerDeps): ComposerStateController {
	let textDraft = $state('');
	let attachments = $state<Attachment[]>([]);
	let isDragging = $state(false);
	let draftPersistFailing = $state(false);

	let draftDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let dragCounter = 0;

	// Draft autosave — 400ms debounced PUT to /api/chat/drafts. Persistent
	// failures toast once; transient success clears the warning. tid captured
	// at TIMER-SCHEDULE time so a fast thread switch routes to the right row.
	$effect(() => {
		const text = textDraft;
		if (draftDebounceTimer) clearTimeout(draftDebounceTimer);
		const tid = deps.getActiveThread();
		draftDebounceTimer = setTimeout(() => {
			void fetch(resolve(`/api/chat/drafts?thread_id=${encodeURIComponent(tid)}`), {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ body: text })
			})
				.then((r) => {
					if (!r.ok) {
						if (!draftPersistFailing) {
							console.warn('[draft] persist failed:', r.status);
							toasts.add(
								`Draft autosave failing (${r.status}) — finish your message before closing the tab.`,
								'warning'
							);
							draftPersistFailing = true;
						}
					} else if (draftPersistFailing) {
						draftPersistFailing = false;
					}
				})
				.catch((err) => {
					if (!draftPersistFailing) {
						console.warn('[draft] network error:', err);
						toasts.add(
							'Draft autosave failing — finish your message before closing the tab.',
							'warning'
						);
						draftPersistFailing = true;
					}
				});
		}, 400);
		return () => {
			if (draftDebounceTimer) clearTimeout(draftDebounceTimer);
		};
	});

	async function uploadOneFile(file: File): Promise<void> {
		const tempId = crypto.randomUUID();
		attachments = [
			...attachments,
			{
				id: tempId,
				filename: file.name,
				url: '',
				mime: file.type,
				size: file.size,
				uploading: true
			}
		];
		const fd = new FormData();
		fd.append('file', file);
		fd.append('target_repo', deps.getSelectedRepo());
		try {
			toasts.add(`Uploading ${file.name}...`, 'info');
			const r = await fetch(resolve('/api/chat/uploads'), { method: 'POST', body: fd });
			if (!r.ok) {
				const err = await r.json().catch(() => ({}));
				throw new Error(err.message || `HTTP ${r.status}`);
			}
			const body = await r.json();
			if (body.url) {
				attachments = attachments.map((a) =>
					a.id === tempId
						? {
								...a,
								id: body.filename || tempId,
								url: body.url,
								mime: body.mime || file.type,
								size: body.size || file.size,
								uploading: false
							}
						: a
				);
			}
		} catch (err) {
			attachments = attachments.filter((a) => a.id !== tempId);
			toasts.add(`Upload failed: ${err instanceof Error ? err.message : 'unknown'}`, 'error');
		}
	}

	function handlePaste(e: ClipboardEvent) {
		const items = Array.from(e.clipboardData?.items ?? []);
		const imageFiles = items
			.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
			.map((it) => it.getAsFile())
			.filter((f): f is File => f !== null);
		if (imageFiles.length > 0) {
			e.preventDefault();
			for (const f of imageFiles) void uploadOneFile(f);
			return;
		}
		const pastedText = e.clipboardData?.getData('text/plain') ?? '';
		if (pastedText.length > PASTE_TO_ATTACHMENT_THRESHOLD) {
			e.preventDefault();
			const id =
				typeof crypto !== 'undefined' && 'randomUUID' in crypto
					? crypto.randomUUID()
					: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const ts = new Date().toISOString().slice(11, 19);
			attachments = [
				...attachments,
				{
					id,
					filename: `paste-${ts}.txt`,
					url: '',
					mime: 'text/plain',
					size: pastedText.length,
					text: pastedText
				}
			];
			toasts.add(`Pasted ${pastedText.length.toLocaleString()} chars as attachment`, 'info');
		}
	}

	async function handleUpload(e: Event) {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;
		try {
			await uploadOneFile(file);
			deps.focusComposer();
		} finally {
			target.value = '';
		}
	}

	function handleDragEnter(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		dragCounter++;
		isDragging = true;
	}
	function handleDragOver(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
	}
	function handleDragLeave(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		dragCounter = Math.max(0, dragCounter - 1);
		if (dragCounter === 0) isDragging = false;
	}
	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragCounter = 0;
		isDragging = false;
		const files = Array.from(e.dataTransfer?.files ?? []);
		if (files.length === 0) return;
		for (const file of files) await uploadOneFile(file);
		deps.focusComposer();
	}

	function removeAttachment(id: string) {
		attachments = attachments.filter((a) => a.id !== id);
	}

	function clearAttachments() {
		attachments = [];
	}

	function appendText(s: string) {
		textDraft = (textDraft + ' ' + s).trim();
	}

	return {
		get textDraft() {
			return textDraft;
		},
		set textDraft(v) {
			textDraft = v;
		},
		get attachments() {
			return attachments;
		},
		set attachments(v) {
			attachments = v;
		},
		get isDragging() {
			return isDragging;
		},
		set isDragging(v) {
			isDragging = v;
		},
		get draftPersistFailing() {
			return draftPersistFailing;
		},
		handlePaste,
		handleUpload,
		uploadOneFile,
		handleDragEnter,
		handleDragOver,
		handleDragLeave,
		handleDrop,
		removeAttachment,
		appendText,
		clearAttachments,
		destroy: () => {
			if (draftDebounceTimer) clearTimeout(draftDebounceTimer);
		}
	};
}
