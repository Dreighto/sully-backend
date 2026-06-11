<script lang="ts">
	// LOS-204 leaf-site proof: the shell is the SullyCard primitive
	// (--surface-card / --line / --r-lg / --shadow-card) — replaces the old
	// dashed-transparent ad-hoc shell. Inner layout (flex, gap, padding,
	// md:col-span-2) stays at the call site per the card's shell-only contract.
	import SullyCard from './sully/SullyCard.svelte';
	import type { WorkSurfaceTask } from '$lib/types/workSurface';

	let { task }: { task: WorkSurfaceTask } = $props();

	// Map proof verdicts to Tailwind text classes
	const getVerdictClass = (verdict: string) => {
		switch (verdict) {
			case 'go':
				return 'text-status-green';
			case 'no-go':
				return 'text-status-red';
			case 'pending':
				return 'text-status-amber';
			case 'skipped':
				return 'text-muted-foreground';
			default:
				return 'text-white';
		}
	};

	// Map check statuses to Tailwind background classes for the dot
	const getCheckStatusDotClass = (status: string) => {
		switch (status) {
			case 'pass':
				return 'bg-status-green';
			case 'fail':
				return 'bg-status-red';
			case 'pending':
				return 'bg-status-amber';
			case 'skip':
				return 'bg-muted-foreground/50';
			default:
				return 'bg-muted-foreground/50';
		}
	};
</script>

{#if task.proof}
	<SullyCard class="flex flex-col gap-1.5 p-3 md:col-span-2" data-testid="proof-card">
		<div class="proof-header">
			<h4 class="proof-verdict">
				Proof: <span class={getVerdictClass(task.proof.verdict)}>{task.proof.verdict}</span>
			</h4>
			{#if task.proof.score !== undefined && task.proof.score !== null}
				<span class="proof-conf">Score: {task.proof.score}%</span>
			{/if}
		</div>
		{#if task.proof.evidenceRef}
			<p class="proof-log">Evidence ref: {task.proof.evidenceRef}</p>
		{/if}
		{#if task.proof.checks.length > 0}
			<h5 class="proof-checks-title">Checks:</h5>
			<ul class="proof-checks-list">
				{#each task.proof.checks as check}
					<li>
						<span class="check-dot {getCheckStatusDotClass(check.status)}"></span>
						<span class="text-white">{check.name}:</span>
						<span class="text-muted-foreground"
							>{check.status} {check.detail ? `(${check.detail})` : ''}</span
						>
					</li>
				{/each}
			</ul>
		{/if}
	</SullyCard>
{/if}

<style lang="postcss">
	@reference "../../app.css";
	.proof-header {
		@apply flex justify-between text-xs font-semibold text-white;
	}

	.proof-conf {
		@apply text-status-green; /* Mock had a green for score, even for pending/no-go verdicts. Sticking to the mock. */
	}

	.proof-log {
		@apply font-mono text-xs leading-tight text-muted-foreground;
	}

	.proof-checks-title {
		@apply mt-2 text-sm font-semibold text-white;
	}

	.proof-checks-list {
		@apply list-none space-y-1 pl-0; /* Removed list-disc to use custom dot, added space-y-1 */
	}
	.proof-checks-list li {
		@apply flex items-center gap-1.5;
	}

	.check-dot {
		@apply h-1.5 w-1.5 flex-shrink-0 rounded-[var(--r-pill)];
	}
</style>
