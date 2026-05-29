export type LessonSeverity = 'advisory' | 'hard-rule' | 'observation';

export interface ProvisionalLesson {
	id: string;
	created_at: string;
	synthesized_from?: string;
	task_shape_tags: string[];
	lesson_text: string;
	proposed_promotion: boolean;
	last_referenced_at?: string;
	expires_at: string;
	synthesized_by: string;
	project_id: string;
	plain_english_summary?: string;
}

export interface AdoptedLesson {
	text: string;
	title?: string;
	adopted_date: string;
	last_applied_date?: string;
	severity: LessonSeverity;
	applies_to: string[]; // project_ids or ['*']
	task_shape?: string[];
	plain_english_summary?: string;
}

export interface Observation {
	observation_id: string;
	ts: string;
	project_id: string;
	worker_id?: string;
	ticket_id?: string;
	task_shape: string[];
	observation_kind: string;
	text: string;
	plain_english_summary?: string;
}
