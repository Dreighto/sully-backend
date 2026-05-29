// Today's shipments — PRs merged across the LogueOS repos within the local
// calendar day. This is the universal "shipped" signal: unlike the dispatch
// completion log (which only ever saw dispatched-worker jobs), counting merged
// PRs captures interactive co-working PRs too. See LOS-127.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Absolute path so this doesn't depend on the console server process having
// `gh` on its PATH; falls back to a PATH lookup if gh lives elsewhere.
const GH_ABS = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const GH = existsSync(GH_ABS) ? GH_ABS : 'gh';

const REPOS = ['Dreighto/project-miru', 'Dreighto/LogueOS-Console', 'Dreighto/LogueOS-Orchestrator'];
const OK_TTL_MS = 5 * 60 * 1000;
const ERROR_TTL_MS = 30 * 1000;
const MAX_ITEMS = 15;
const TICKET_RE = /\b(?:LOS|PRO|NAS)-\d+/i;

export interface Shipment {
	/** ISO merge timestamp. */
	timestamp: string;
	/** LOS-/PRO-/NAS- ticket id parsed from the PR, or null. */
	ticket_id: string | null;
	/** PR title. */
	summary: string;
	/** "<repo>#<number>". */
	pr: string;
}

export interface ShipmentsResult {
	today: number;
	items: Shipment[];
}

interface GhPr {
	number: number;
	title: string;
	mergedAt: string;
	headRefName: string;
}

let cache: { at: number; ok: boolean; value: ShipmentsResult } | null = null;
let refreshing: Promise<ShipmentsResult> | null = null;

/** Local calendar day as UTC-millisecond bounds. */
function todayWindow(): { start: number; end: number } {
	const now = new Date();
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
	return { start, end };
}

async function fetchRepo(repo: string, sinceDate: string): Promise<GhPr[]> {
	const { stdout } = await execFileAsync(
		GH,
		[
			'pr',
			'list',
			'-R',
			repo,
			'--state',
			'merged',
			'--search',
			`merged:>=${sinceDate}`,
			'--json',
			'number,title,mergedAt,headRefName',
			'--limit',
			'80'
		],
		{ timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
	);
	return JSON.parse(stdout) as GhPr[];
}

async function refresh(): Promise<ShipmentsResult> {
	const { start, end } = todayWindow();
	// Over-fetch from the prior day so a timezone edge can't clip a real merge;
	// the precise window check below is what actually decides "today".
	const sinceDate = new Date(start - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

	const items: Shipment[] = [];
	let ok = true;

	const perRepo = await Promise.all(
		REPOS.map(async (repo) => {
			try {
				return await fetchRepo(repo, sinceDate);
			} catch (e) {
				ok = false;
				console.error(`shipments: gh failed for ${repo}:`, e);
				return [] as GhPr[];
			}
		})
	);

	REPOS.forEach((repo, i) => {
		for (const pr of perRepo[i]) {
			const t = Date.parse(pr.mergedAt);
			if (!Number.isFinite(t) || t < start || t >= end) continue;
			const m = TICKET_RE.exec(pr.title) ?? TICKET_RE.exec(pr.headRefName);
			items.push({
				timestamp: pr.mergedAt,
				ticket_id: m ? m[0].toUpperCase() : null,
				summary: pr.title,
				pr: `${repo.split('/')[1]}#${pr.number}`
			});
		}
	});

	items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	const value: ShipmentsResult = { today: items.length, items: items.slice(0, MAX_ITEMS) };
	cache = { at: Date.now(), ok, value };
	return value;
}

/**
 * PRs merged today (local calendar day) across the LogueOS repos.
 *
 * Stale-while-revalidate: returns the cached value immediately and refreshes
 * in the background when stale, so the home page never stalls on `gh`. Only
 * the very first call (no cache at all) awaits the fetch. Fails soft — a
 * broken `gh` logs and yields an empty result, never throws.
 */
export async function getTodayShipments(): Promise<ShipmentsResult> {
	const fresh = cache && Date.now() - cache.at < (cache.ok ? OK_TTL_MS : ERROR_TTL_MS);
	if (cache && fresh) return cache.value;

	if (!refreshing) {
		refreshing = refresh()
			.catch((e): ShipmentsResult => {
				console.error('shipments: refresh failed:', e);
				const value = cache?.value ?? { today: 0, items: [] };
				cache = { at: Date.now(), ok: false, value };
				return value;
			})
			.finally(() => {
				refreshing = null;
			});
	}

	// Stale cache → serve it now, the refresh continues in the background.
	if (cache) return cache.value;
	// No cache at all (first call) → await the in-flight refresh.
	return refreshing ?? { today: 0, items: [] };
}
