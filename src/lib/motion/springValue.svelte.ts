// Single-axis mass-spring-damper — one transform value as source of truth.
// Velocity is injected on release (px/s). Unmount on onRest, never setTimeout.

export type SpringConfig = {
	stiffness?: number;
	damping?: number;
	mass?: number;
	/** Position epsilon for "at rest" */
	restEpsilon?: number;
	/** Velocity epsilon for "at rest" (px/s) */
	velocityEpsilon?: number;
};

export type SpringValue = {
	readonly value: number;
	readonly target: number;
	readonly isAnimating: boolean;
	/** Direct position during drag — stops physics, no interpolation */
	set: (position: number) => void;
	/** Animate toward target; velocity in px/s */
	animateTo: (target: number, velocityPxPerSec?: number, onRest?: () => void) => void;
	snapTo: (target: number) => void;
	stop: () => void;
};

function prefersReducedMotion(): boolean {
	return (
		typeof window !== 'undefined' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

export function createSpringValue(initial: number, config: SpringConfig = {}): SpringValue {
	const stiffness = config.stiffness ?? 170;
	const damping = config.damping ?? 26;
	const mass = config.mass ?? 1;
	const restEpsilon = config.restEpsilon ?? 0.5;
	const velocityEpsilon = config.velocityEpsilon ?? 3;

	const maxDtSec = 1 / 30;

	let pos = $state(initial);
	let target = initial;
	let vel = 0;
	let rafId = 0;
	let lastTs: number | null = null;
	let onRestCb: (() => void) | null = null;
	let animating = $state(false);

	function finishAtRest() {
		pos = target;
		vel = 0;
		rafId = 0;
		animating = false;
		const cb = onRestCb;
		onRestCb = null;
		cb?.();
	}

	function tick(now: number) {
		const dt =
			lastTs === null
				? 1 / 60
				: Math.min(Math.max((now - lastTs) / 1000, 1 / 1000), maxDtSec);
		lastTs = now;

		const f = -stiffness * (pos - target) - damping * vel;
		vel += (f / mass) * dt;
		pos += vel * dt;

		if (Math.abs(vel) < velocityEpsilon && Math.abs(pos - target) < restEpsilon) {
			finishAtRest();
			return;
		}
		rafId = requestAnimationFrame(tick);
	}

	function startLoop() {
		animating = true;
		lastTs = null;
		if (!rafId) rafId = requestAnimationFrame(tick);
	}

	return {
		get value() {
			return pos;
		},
		get target() {
			return target;
		},
		get isAnimating() {
			return animating;
		},
		set(position: number) {
			if (rafId) {
				cancelAnimationFrame(rafId);
				rafId = 0;
			}
			animating = false;
			onRestCb = null;
			lastTs = null;
			pos = position;
			target = position;
			vel = 0;
		},
		animateTo(nextTarget: number, velocityPxPerSec = 0, onRest?: () => void) {
			if (prefersReducedMotion()) {
				pos = nextTarget;
				target = nextTarget;
				vel = 0;
				animating = false;
				onRest?.();
				return;
			}
			target = nextTarget;
			vel = velocityPxPerSec;
			onRestCb = onRest ?? null;
			startLoop();
		},
		snapTo(nextTarget: number) {
			this.set(nextTarget);
		},
		stop() {
			if (rafId) cancelAnimationFrame(rafId);
			rafId = 0;
			animating = false;
			onRestCb = null;
			lastTs = null;
		}
	};
}
