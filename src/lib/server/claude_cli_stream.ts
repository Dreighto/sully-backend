// Claude Code CLI bridge — used when Anthropic's direct /v1/messages API
// rejects a model under our auth tier. Specifically: Claude Max OAuth tokens
// grant API-style access to Haiku ONLY; Sonnet + Opus return HTTP 429
// rate_limit_error (with empty message "Error") when called directly via the
// OAuth Bearer header.
//
// The CLI binary itself IS the authorized client — it can call Sonnet/Opus
// through its own auth path. So for those models, we shell out to it with:
//   - a clean $HOME so no CLAUDE.md / memory / skills auto-load (cuts ~6K
//     tokens per call)
//   - the operator's CLAUDE_CODE_OAUTH_TOKEN passed via env
//   - the dead ANTHROPIC_API_KEY env vars STRIPPED (otherwise the CLI prefers
//     the dead key over OAuth and fails 401)
//   - `--system-prompt` + `--disable-slash-commands` to avoid the harness's
//     full scaffolding
//   - `--print --output-format stream-json --include-partial-messages` for
//     line-delimited NDJSON streaming
//
// Performance numbers (verified 2026-05-27 on a "What is 2+2?" probe):
//   ttft 1.0s, duration 1.1s, ~12K tokens (10K cached after first hit).
//   Slower than the direct API (~500ms) but free under the operator's
//   Claude Max subscription. Operator explicitly chose this path over
//   paying for a billed API key (see [[reference_oauth_first_llm_routing]]
//   and operator directive 2026-05-27).

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

// systemd starts the Console with a stripped PATH that doesn't include
// ~/.npm-global/bin (where `claude` lives for an npm-global install).
// Resolve the binary path once at module load: explicit env override first,
// then common install locations, then bare 'claude' for PATH-aware shells.
function resolveClaudeBin(): string {
	const explicit = process.env.CLAUDE_BIN;
	if (explicit && existsSync(explicit)) return explicit;
	const candidates = [
		join(homedir(), '.npm-global/bin/claude'),
		'/usr/local/bin/claude',
		'/usr/bin/claude',
		join(homedir(), '.local/bin/claude')
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return 'claude'; // fall back to PATH lookup
}
const CLAUDE_BIN = resolveClaudeBin();

// Reusable scratch dir so the CLI's per-session state doesn't accumulate in
// the operator's real ~/.claude.
const BARE_HOME = join(tmpdir(), 'logueos-console-claude-cli-home');
try {
	mkdirSync(BARE_HOME, { recursive: true });
} catch {
	/* exists */
}

export interface ClaudeCLIOptions {
	model: string;
	systemPrompt: string;
	userPrompt: string;
	signal?: AbortSignal;
}

export type ClaudeCLIChunk =
	| { type: 'text-delta'; delta: string }
	| { type: 'finish'; reason: string }
	| { type: 'error'; message: string };

/**
 * Translate the CLI's raw error result text into something the operator can
 * act on. Anthropic occasionally surfaces upstream policy / filter / quota
 * failures via the CLI's `result` field — most are not bugs in this app,
 * they're upstream decisions the operator needs to know are upstream.
 */
function formatCliError(raw: string | undefined, statusCode: number | null | undefined): string {
	const text = (raw || 'unknown error').trim();
	const lower = text.toLowerCase();
	const status = statusCode ? ` (HTTP ${statusCode})` : '';

	if (lower.includes('content filter') || lower.includes('content filtering policy')) {
		return `Anthropic's content filter blocked this response. The model started generating but their safety policy stopped it mid-stream. Try rephrasing, splitting the request, or switching to a different model.`;
	}
	if (lower.includes('not logged in') || lower.includes('please run /login')) {
		return `Claude CLI lost its OAuth session. Check that CLAUDE_CODE_OAUTH_TOKEN is current in the canonical .env, then restart the Console.`;
	}
	if (lower.includes('rate limit') || lower.includes('overage')) {
		return `Anthropic rate limit (your Claude Max 5-hour window). Wait a few minutes or switch to Haiku/Gemini/Local in the meantime.`;
	}
	if (lower.includes('invalid api key')) {
		return `Claude CLI got "invalid x-api-key". A dead ANTHROPIC_API_KEY env var is overriding OAuth — strip it from the canonical .env and restart.`;
	}
	if (lower.includes('context window') || lower.includes('too long')) {
		return `Conversation exceeded the model's context window. Start a fresh thread or summarize the history.`;
	}
	if (lower.includes('overloaded')) {
		return `Anthropic reports the model is currently overloaded. Try again in a moment or switch model.`;
	}
	return `Claude CLI: ${text}${status}`;
}

/**
 * Stream a single-turn completion via the Claude Code CLI binary. Yields
 * incremental text deltas as they arrive, then a single finish/error event.
 *
 * The CLI is invoked in --print mode, so each call is stateless from its
 * perspective (no session persistence). Multi-turn context must be baked
 * into `userPrompt` (e.g. "Previous: [user]: ... [assistant]: ... \nCurrent: ...").
 */
export async function* streamViaClaudeCLI(
	opts: ClaudeCLIOptions
): AsyncGenerator<ClaudeCLIChunk, void, void> {
	const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
	if (!oauth) {
		yield {
			type: 'error',
			message: 'CLAUDE_CODE_OAUTH_TOKEN is not set; CLI bridge cannot authenticate.'
		};
		return;
	}

	// Strip the dead API-key envs so the CLI falls back to OAuth.
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: BARE_HOME };
	delete env.ANTHROPIC_API_KEY;
	delete env.LOGUEOS_ROUTING_KEY;
	delete env.MIRU_ROUTING_KEY;

	// Write the system prompt to a temp file rather than passing it as a CLI
	// arg. The chat system prompt is ~2KB; passing it inline blows past the
	// kernel's ARG_MAX for the spawn syscall on some setups and crashes the
	// host Node process. --system-prompt-file is supported by the CLI for
	// exactly this reason.
	const systemPromptPath = join(BARE_HOME, `sys-${randomBytes(6).toString('hex')}.txt`);
	try {
		writeFileSync(systemPromptPath, opts.systemPrompt, 'utf-8');
	} catch (err) {
		yield {
			type: 'error',
			message: `Failed to write system prompt: ${(err as Error).message}`
		};
		return;
	}

	const args = [
		'--print',
		'--model',
		opts.model,
		'--system-prompt-file',
		systemPromptPath,
		'--disable-slash-commands',
		'--output-format',
		'stream-json',
		'--include-partial-messages',
		'--verbose'
	];

	const child = spawn(CLAUDE_BIN, args, {
		env,
		cwd: BARE_HOME,
		stdio: ['pipe', 'pipe', 'pipe']
	});

	// CRITICAL: attach an 'error' handler BEFORE any other operation. If
	// spawn fails (ENOENT, EACCES, etc.) the ChildProcess emits an unhandled
	// 'error' event that crashes the host Node process. Capture it into a
	// local var the generator can yield.
	let spawnError: string | null = null;
	child.on('error', (err: NodeJS.ErrnoException) => {
		spawnError = `Failed to spawn ${CLAUDE_BIN}: ${err.code || ''} ${err.message}`.trim();
		try {
			child.stdin.end();
		} catch {
			/* already closed */
		}
	});

	let aborted = false;
	const onAbort = () => {
		aborted = true;
		try {
			child.kill('SIGTERM');
		} catch {
			/* already gone */
		}
	};
	opts.signal?.addEventListener('abort', onAbort);

	// Write the user prompt to stdin and close it so the CLI knows the
	// turn is complete (otherwise --print mode hangs waiting for more input).
	try {
		child.stdin.write(opts.userPrompt);
		child.stdin.end();
	} catch (err) {
		opts.signal?.removeEventListener('abort', onAbort);
		// Spawn-error handler may have populated this already.
		yield {
			type: 'error',
			message: spawnError || `Failed to write to CLI stdin: ${(err as Error).message}`
		};
		try {
			unlinkSync(systemPromptPath);
		} catch {
			/* gone */
		}
		return;
	}
	// Also handle stdin EPIPE errors silently
	child.stdin.on('error', () => {
		/* swallow EPIPE from early exit */
	});

	// Drain stderr in the background so the pipe doesn't fill up. Capture it
	// for diagnostic surface if the CLI exits non-zero.
	let stderrBuf = '';
	child.stderr.setEncoding('utf-8');
	child.stderr.on('data', (chunk: string) => {
		stderrBuf += chunk;
	});

	// Parse stdout NDJSON line-by-line.
	const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
	let yieldedFinish = false;
	// Tracks whether we've emitted visible text yet. Used to insert a paragraph
	// break when a SECOND text block opens (i.e. a tool-use turn ran in between),
	// so pre-tool prose and post-tool prose don't concatenate with no separator
	// ("...dig.Worker's back..."). Bug from thread B7BB0D39.
	let sawText = false;

	try {
		for await (const line of rl) {
			if (aborted) break;
			if (!line.trim()) continue;
			let evt: unknown;
			try {
				evt = JSON.parse(line);
			} catch {
				continue; // ignore non-JSON lines
			}
			const e = evt as {
				type?: string;
				event?: {
					type?: string;
					delta?: { type?: string; text?: string };
					content_block?: { type?: string };
				};
				is_error?: boolean;
				result?: string;
				stop_reason?: string;
				api_error_status?: number | null;
			};

			// A new TEXT block opening after we've already emitted text means a
			// tool-use turn ran in between (the parser drops tool blocks). Insert
			// a paragraph break so the segments don't abut ("dig.Worker's back").
			if (
				e.type === 'stream_event' &&
				e.event?.type === 'content_block_start' &&
				e.event.content_block?.type === 'text' &&
				sawText
			) {
				yield { type: 'text-delta', delta: '\n\n' };
				continue;
			}

			// Incremental text deltas from the model's stream.
			if (
				e.type === 'stream_event' &&
				e.event?.type === 'content_block_delta' &&
				e.event.delta?.type === 'text_delta' &&
				e.event.delta.text
			) {
				sawText = true;
				yield { type: 'text-delta', delta: e.event.delta.text };
				continue;
			}

			// Final result event — emit finish/error and exit the loop.
			if (e.type === 'result') {
				if (e.is_error) {
					yield { type: 'error', message: formatCliError(e.result, e.api_error_status) };
				} else {
					yield { type: 'finish', reason: e.stop_reason || 'stop' };
				}
				yieldedFinish = true;
				break;
			}
		}
	} finally {
		opts.signal?.removeEventListener('abort', onAbort);
		rl.close();
	}

	// Wait for the child to settle so we don't leak processes — but never
	// hang the request. On a spawn failure (ENOENT/EACCES) 'exit' never fires,
	// so we also resolve on 'close'/'error', and a timeout backstops a wedged
	// child.
	await new Promise<void>((resolve) => {
		if (child.exitCode !== null || spawnError) {
			resolve();
			return;
		}
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		// Backstop a wedged child so the request never hangs. If it fires the
		// child is still alive — kill it so we don't leak the process.
		const timer = setTimeout(() => {
			try {
				child.kill('SIGKILL');
			} catch {
				/* already gone */
			}
			finish();
		}, 5000);
		if (typeof timer.unref === 'function') timer.unref();
		const onSettled = () => {
			clearTimeout(timer);
			finish();
		};
		child.once('exit', onSettled);
		child.once('close', onSettled);
		child.once('error', onSettled);
	});

	// Clean up the temp system-prompt file.
	try {
		unlinkSync(systemPromptPath);
	} catch {
		/* already gone */
	}

	if (!yieldedFinish) {
		if (spawnError) {
			yield { type: 'error', message: spawnError };
		} else if (aborted) {
			yield { type: 'error', message: 'Stream aborted.' };
		} else if (child.exitCode !== 0) {
			yield {
				type: 'error',
				message: `Claude CLI exited with code ${child.exitCode}: ${stderrBuf.slice(0, 200) || 'no stderr'}`
			};
		} else {
			yield { type: 'finish', reason: 'stop' };
		}
	}
}
