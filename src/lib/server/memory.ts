import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';
import type { ProvisionalLesson, AdoptedLesson, Observation } from '$lib/types/memory';

type ProvisionalRow = {
	id: string;
	created_at: string;
	synthesized_from?: string;
	task_shape_tags: string | null;
	lesson_text: string;
	proposed_promotion: number;
	last_referenced_at?: string;
	expires_at: string;
	synthesized_by: string;
	project_id: string;
	plain_english_summary?: string;
};

type LessonRow = {
	advice: string;
	title?: string;
	created_at: string;
	project_id?: string;
	task_shape?: string;
	plain_english_summary?: string;
};

type ObservationRow = {
	observation_id: string;
	trace_id?: string;
	ticket_id?: string;
	project_id: string;
	observation_kind: string;
	text: string;
	task_shape?: string;
	timestamp: string;
	plain_english_summary?: string;
};

export async function getMemoryData() {
	let provisional: ProvisionalLesson[] = [];
	let lessons: AdoptedLesson[] = [];
	let raw: Observation[] = [];

	if (!fs.existsSync(serverConfig.memoryDbPath)) {
		return { provisional, lessons, raw };
	}

	const db = new Database(serverConfig.memoryDbPath, { readonly: true });
	try {
		const provisionalRows = db
			.prepare('SELECT * FROM provisional_lessons ORDER BY created_at DESC LIMIT 10')
			.all() as ProvisionalRow[];

		provisional = provisionalRows.map((row) => {
			let task_shape_tags: string[] = [];
			if (row.task_shape_tags) {
				try {
					task_shape_tags = JSON.parse(row.task_shape_tags);
				} catch {
					task_shape_tags = [];
				}
			}
			return {
				...row,
				task_shape_tags,
				plain_english_summary: row.plain_english_summary,
				proposed_promotion: row.proposed_promotion === 1
			} as ProvisionalLesson;
		});

		const lessonRows = db
			.prepare('SELECT * FROM lessons ORDER BY created_at DESC LIMIT 10')
			.all() as LessonRow[];

		lessons = lessonRows.map((row) => {
			let task_shape: string[] = [];
			if (row.task_shape) {
				try {
					task_shape = JSON.parse(row.task_shape);
				} catch {
					task_shape = [];
				}
			}
			return {
				text: row.advice,
				title: row.title,
				adopted_date: row.created_at,
				severity: 'hard-rule',
				applies_to: row.project_id ? [row.project_id] : ['*'],
				task_shape,
				plain_english_summary: row.plain_english_summary
			} as AdoptedLesson;
		});

		const obsRows = db
			.prepare('SELECT * FROM observations ORDER BY timestamp DESC LIMIT 50')
			.all() as ObservationRow[];

		raw = obsRows.map((row) => ({
			observation_id: row.observation_id,
			ts: row.timestamp,
			project_id: row.project_id,
			observation_kind: row.observation_kind,
			text: row.text,
			ticket_id: row.ticket_id,
			task_shape: row.task_shape ? (() => { try { return JSON.parse(row.task_shape!); } catch { return []; } })() : [],
			plain_english_summary: row.plain_english_summary
		} as Observation));
	} finally {
		db.close();
	}

	return { provisional, lessons, raw };
}
