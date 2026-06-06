// Slash-command registry + runner. Extracted from chat/+page.svelte (PR E2).
//
// Plain TS — NO $state. The registry is built once per page mount via
// `createSlashCommandsController(deps)` so each command's handler closes over
// the page's getters/actions. The page keeps the `slashQuery` / `slashMatches`
// / `slashMode` $derived (they depend on `textDraft`, which is composer-owned
// $state); those derived expressions reference `controller.commands` as a
// stable array. No reactive boundary is crossed here — slash is a side-effect
// dispatcher, not a UI state holder.
//
// Cross-controller wiring: /regen reaches into streaming, /new reaches into
// threads. Those must go THROUGH this controller's deps port — slash-commands
// must NEVER import streaming.svelte.ts / threads.svelte.ts directly. The
// page is the integration point.

import { resolve } from '$app/paths';
import { toasts } from '$lib/utils/toasts';
import type { SlashCmd } from '$lib/types/slash';
import type { ChatMessage } from '$lib/types/chat-ui';

export interface SlashDeps {
	// Reads
	getActiveThread: () => string;
	getMessages: () => ChatMessage[];
	// Composer surface (write — these clear the draft on a successful run)
	setTextDraft: (s: string) => void;
	clearAttachments: () => void;
	focusComposer: () => void;
	// Messages feed
	appendSystemMessage: (text: string) => void;
	pollMessages: () => Promise<void>;
	// Tools unlock (page-owned $state; controller exposes the setter so /unlock
	// and /lock can flip it). localStorage write happens inside the handler.
	setToolsKey: (key: string) => void;
	// Cross-controller dispatch (page provides closures into other controllers)
	regenerateReply: (m: ChatMessage) => Promise<void>;
	createThread: (rest: string) => Promise<void>;
}

export interface SlashCommandsController {
	readonly commands: readonly SlashCmd[];
	/**
	 * Inspect the composer draft; if it starts with `/<key>`, run that command
	 * (clearing the draft + attachments first) and return true. Otherwise
	 * return false so the caller knows to send the draft as a normal message.
	 */
	runFromDraft: (textDraft: string) => Promise<boolean>;
	/**
	 * Operator clicked a row in the autocomplete popover. Commands that take
	 * an argument (`<…>` in usage) prefill the composer; flag-only commands
	 * run immediately.
	 */
	pick: (cmd: SlashCmd, textDraft: string) => Promise<void>;
}

export function createSlashCommandsController(deps: SlashDeps): SlashCommandsController {
	const commands: SlashCmd[] = [
		{
			key: 'clear',
			usage: '/clear',
			description: 'Reset conversation context (server slices history at this marker)',
			run: async () => {
				// Persist a system marker — /api/chat and /api/chat/sdk-stream
				// slice thread history at the latest `--- NEW CONVERSATION ---`
				// line, so this drops the LLM's working memory without deleting
				// prior messages from the operator's view.
				await fetch(resolve('/api/chat'), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						sender: 'system',
						message: '--- NEW CONVERSATION ---',
						thread: deps.getActiveThread(),
						agent: 'silent'
					})
				}).catch(() => null);
				await deps.pollMessages();
				toasts.add('Conversation context reset', 'success');
			}
		},
		{
			key: 'new',
			usage: '/new <name>',
			description: 'Create + switch to a new thread',
			run: async (rest) => {
				// Threads controller owns the slug-collision + switch flow. Slash
				// is just a UI trigger; all the thread CRUD belongs there.
				await deps.createThread(rest);
			}
		},
		{
			key: 'regen',
			usage: '/regen',
			description: 'Regenerate the most recent assistant reply',
			run: async () => {
				// Walk backwards for the last non-operator, non-system reply.
				const msgs = deps.getMessages();
				for (let i = msgs.length - 1; i >= 0; i--) {
					if (msgs[i].sender !== 'operator' && msgs[i].sender !== 'system') {
						await deps.regenerateReply(msgs[i]);
						return;
					}
				}
				toasts.add('No assistant reply to regenerate', 'error');
			}
		},
		{
			key: 'unlock',
			usage: '/unlock <code>',
			description:
				'Enable file-reading + web tools on this device (paste the code CC gave you)',
			run: (rest) => {
				const code = rest.trim();
				if (!code) {
					toasts.add('Paste the code: /unlock <code>', 'error');
					return;
				}
				deps.setToolsKey(code);
				try {
					localStorage.setItem('companion-tools-key', code);
				} catch {
					/* private mode — stays in memory for this session */
				}
				deps.appendSystemMessage(
					'🔓 Tools unlocked on this device. The companion can now read files and search the web here.'
				);
			}
		},
		{
			key: 'lock',
			usage: '/lock',
			description: 'Disable file-reading + web tools on this device',
			run: () => {
				deps.setToolsKey('');
				try {
					localStorage.removeItem('companion-tools-key');
				} catch {
					/* ignore */
				}
				deps.appendSystemMessage('🔒 Tools locked on this device.');
			}
		},
		{
			key: 'help',
			usage: '/help',
			description: 'Show available slash commands',
			run: () => {
				const body = commands.map((c) => `- \`${c.usage}\` — ${c.description}`).join('\n');
				deps.appendSystemMessage(`**Slash commands**\n\n${body}`);
			}
		},
		{
			key: 'codex',
			usage: '/codex',
			description: 'Show comprehensive guide to all available commands and features',
			run: () => {
				const codexContent = `
# Codex — Command Reference

## Chat Commands
• **@cc** — Engage Claude Code for complex programming tasks
• **@agy** — Engage Antigravity/Gemini for general assistance
• **@gemini** — Alias for @agy

## Slash Commands
${commands.map((c) => `• **\`${c.usage}\`** — ${c.description}`).join('\n')}

## Workflow Buttons
• **Build** — Execute the proposed changes
• **Critique** — Request a review of the plan
• **Verify** — Run tests and checks
• **Retry** — Attempt the task again

## Navigation Features
• Use thread tabs to organize different conversations
• Archive threads to clean up your workspace
• Pin important threads for quick access

## Provider Selection
• Use the provider pill to choose between Claude, Gemini, or local models
• Set model preferences for different types of tasks

## Image Generation
• Toggle image mode to generate images with Gemini
• Works with general prompts and creative requests

## Tools Access
• Use **/unlock** with a code to enable file reading and web search
• **/lock** disables these tools for security
`;
				deps.appendSystemMessage(codexContent);
			}
		}
	];

	async function runFromDraft(textDraft: string): Promise<boolean> {
		if (!textDraft.startsWith('/')) return false;
		const trimmed = textDraft.trim();
		const spaceIdx = trimmed.indexOf(' ');
		const key = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
		const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
		const cmd = commands.find((c) => c.key === key);
		if (!cmd) return false;
		// Clear the draft + attachments BEFORE awaiting the handler. Original
		// semantics: a thrown handler leaves the composer empty (operator can
		// re-type) — do NOT add a try-finally restore.
		deps.setTextDraft('');
		deps.clearAttachments();
		try {
			await cmd.run(rest);
		} catch (e) {
			toasts.add(`Command failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error');
		}
		return true;
	}

	async function pick(cmd: SlashCmd, _textDraft: string): Promise<void> {
		// If the command takes args (`<>` in usage), prefill the composer so
		// the operator can type the arg instead of running immediately.
		if (cmd.usage.includes('<')) {
			deps.setTextDraft(`/${cmd.key} `);
			deps.focusComposer();
			return;
		}
		deps.setTextDraft(`/${cmd.key}`);
		await runFromDraft(`/${cmd.key}`);
	}

	return {
		get commands() {
			return commands;
		},
		runFromDraft,
		pick
	};
}
