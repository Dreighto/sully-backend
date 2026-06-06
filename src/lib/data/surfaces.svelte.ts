import type { WorkSurfaceTask, Surface, SurfaceStatus } from '$lib/types/workSurface';

let surfaceIdCounter = 1;
let surfaces = $state<Surface[]>([]);

export function spawnSurface(fromMessageId: string, task: WorkSurfaceTask): string {
	const surfaceId = `surface-${surfaceIdCounter++}`;
	const now = new Date().toISOString();
	const newSurface: Surface = {
		surfaceId,
		spawnedFromMessageId: fromMessageId,
		title: task.title, // Use task title initially
		status: 'running', // Default status
		task: task,
		createdAt: now,
		updatedAt: now
	};
	surfaces.push(newSurface);
	return surfaceId;
}

export function attachToSurface(id: string, patch: Partial<Surface>) {
	const index = surfaces.findIndex((s) => s.surfaceId === id);
	if (index !== -1) {
		surfaces[index] = { ...surfaces[index], ...patch, updatedAt: new Date().toISOString() };
	}
}

export function setStatus(id: string, status: SurfaceStatus) {
	const index = surfaces.findIndex((s) => s.surfaceId === id);
	if (index !== -1) {
		surfaces[index].status = status;
		surfaces[index].updatedAt = new Date().toISOString();
	}
}

export function removeSurface(id: string) {
	surfaces = surfaces.filter((s) => s.surfaceId !== id);
}

export const running = $derived.by(() => surfaces.filter((s) => s.status === 'running'));
export const needsYou = $derived.by(() => surfaces.filter((s) => s.status === 'needs-you'));
export const done = $derived.by(() => surfaces.filter((s) => s.status === 'done'));
