export interface UsageMetrics {
	totalPredictedCost: number;
	totalPredictedTokens: number;
	workerBreakdown: Record<string, { cost: number; tokens: number; count: number }>;
	recentDispatches: number;
}

export interface WorkerUsage {
	worker: string;
	cost: number;
	tokens: number;
	dispatches: number;
}

export interface DailyUsage {
	date: string;
	workers: WorkerUsage[];
	totalCost: number;
	totalTokens: number;
	totalDispatches: number;
}

export interface UsageProjection {
	monthToDate: number;
	/** Month-to-date cost per worker, keyed by registry worker id. */
	byWorker: Record<string, number>;
	daysElapsed: number;
	daysInMonth: number;
	dailyAvg: number;
	projectedEOM: number;
}

export interface UsageHistory {
	days: DailyUsage[];
	projection: UsageProjection;
	totalEvents: number;
}

export interface TicketCost {
	ticket_id: string;
	worker: string;
	cost: number;
	tokens: number;
	dispatches: number;
}

export interface HourlyBucket {
	date: string;
	hour: number;
	cost: number;
	dispatches: number;
}
