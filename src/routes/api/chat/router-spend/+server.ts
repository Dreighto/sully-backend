import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { getSullySpendSnapshot } from '$lib/server/sully_model_router';

export const GET: RequestHandler = async () => {
	return json(getSullySpendSnapshot());
};
