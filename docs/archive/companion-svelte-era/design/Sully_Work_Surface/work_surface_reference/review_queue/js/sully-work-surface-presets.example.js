/**
 * ==========================================================================
 * SULLY WORK SURFACE - REUSABLE STATE TELEMETRY & PRESETS DATA
 * ==========================================================================
 *
 * This file serves as a reference data module when integrating the Work Surface
 * state machine into Svelte, React, nextJS, or pure HTML systems.
 */

export const WORK_SURFACE_PRESETS = {
	'cc-only': {
		title: 'CC Schema Analysis',
		prompt: 'Assess database migrations index layout.',
		systemStatus: 'Sully has dispatched the Coordinator to analyze schemas.',
		status: 'working',
		statusText: 'Working',
		bannerText: 'Next: Optimizing database lookup speed',
		bannerIcon: '⚡',
		headerIcon: 'icon-dispatch',
		activeOwnershipLabel: 'Now: CC researching database indexes',
		activeClass: 'working',
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'active',
				desc: 'Researching index tables'
			}
		],
		phases: [
			{ name: 'Reading user payload', state: 'done', time: '0.2s' },
			{ name: 'Mapping tables & indexing schemas', state: 'active', time: 'Running' },
			{ name: 'Compiling optimization queries', state: 'pending', time: '--' }
		],
		proofScore: 'Active',
		proofDetail: 'Coordinator verifying index bounds. Graph edges active.'
	},
	'cc-verify': {
		title: 'Handshake Diagnostic',
		prompt: 'Verify secure SSL certificate handshake bindings.',
		systemStatus: 'Sully Coordinator ports verified; Verify QA running handshake tests.',
		status: 'checking',
		statusText: 'Checking',
		bannerText: 'Next: Submitting validation report',
		bannerIcon: '🔍',
		headerIcon: 'icon-verify',
		activeOwnershipLabel: 'Now: Verify checking TLS connection handshake',
		activeClass: 'checking',
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'complete',
				desc: 'Ports checked'
			},
			{
				key: 'Ver',
				icon: 'icon-verify',
				role: 'QA Verify',
				state: 'active-checking',
				desc: 'Running TLS v1.3 scans'
			}
		],
		phases: [
			{ name: 'Scanning open gateway ports', state: 'done', time: '0.4s' },
			{ name: 'Checking handshake security profiles', state: 'active', time: 'Checking' },
			{ name: 'Waiting for operator approval', state: 'pending', time: '--' }
		],
		proofScore: '96% Confidence',
		proofDetail: 'SSL negotiation test run matches standard cryptographic validation profiles.'
	},
	'agy-verify': {
		title: 'Deck Handler Refinements',
		prompt: 'Apply mobile-first drag handling routines.',
		systemStatus: 'Antigravity writing gesture code; QA suite checks queued.',
		status: 'working',
		statusText: 'Working',
		bannerText: 'Next: Running gesture telemetry scripts',
		bannerIcon: '⚡',
		headerIcon: 'icon-antigravity',
		activeOwnershipLabel: 'Now: AGY building touch gesture handlers',
		activeClass: 'working',
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'complete',
				desc: 'Scope verified'
			},
			{
				key: 'AGY',
				icon: 'icon-antigravity',
				role: 'Antigravity Agent',
				state: 'active',
				desc: 'Writing drag handlers'
			},
			{
				key: 'Ver',
				icon: 'icon-verify',
				role: 'QA Verify',
				state: 'waiting',
				desc: 'Queued behind build'
			}
		],
		phases: [
			{ name: 'Ingesting touch specifications', state: 'done', time: '0.1s' },
			{ name: 'Injecting drag logic modules', state: 'active', time: 'Writing' },
			{ name: 'Verifying coordinate boundary limits', state: 'pending', time: '--' }
		],
		proofScore: 'Queued',
		proofDetail: 'Gesture test blocks built. Awaiting Touch Handlers compilation.'
	},
	'dpsk-verify': {
		title: 'Sully is checking schema logic',
		prompt: 'Verify database constraints and triggers.',
		systemStatus: 'DeepSeek active verifying constraints logic; QA queued.',
		status: 'checking',
		statusText: 'Checking',
		bannerText: 'Next: Reviewing logic constraint rules',
		bannerIcon: '🔍',
		headerIcon: 'icon-deepseek',
		activeOwnershipLabel: 'Now: DeepSeek verifying schema constraints logic',
		activeClass: 'checking',
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'complete',
				desc: 'Routing complete'
			},
			{
				key: 'DPSK',
				icon: 'icon-deepseek',
				role: 'DeepSeek',
				state: 'active-checking',
				desc: 'Verifying trigger constraints'
			},
			{
				key: 'Ver',
				icon: 'icon-verify',
				role: 'QA Verify',
				state: 'waiting',
				desc: 'Awaiting constraints'
			}
		],
		phases: [
			{ name: 'Mapping model keys', state: 'done', time: '0.3s' },
			{ name: 'Evaluating check triggers', state: 'active', time: 'Verifying' },
			{ name: 'Running integration validation', state: 'pending', time: '--' }
		],
		proofScore: 'Active',
		proofDetail: 'DeepSeek scanning database model mappings. 12 triggers validated.'
	},
	'multi-worker': {
		title: 'Similarity Index Build',
		prompt: 'Process embeddings archive logs context search.',
		systemStatus: 'Antigravity generating vectors; Memory indexes resolved.',
		status: 'working',
		statusText: 'Working',
		bannerText: 'Next: Deploying neural similarity matrix',
		bannerIcon: '⚡',
		headerIcon: 'icon-memory',
		activeOwnershipLabel: 'Now: AGY compiling logs similarity arrays',
		activeClass: 'working',
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'complete',
				desc: 'Workflow mapped'
			},
			{
				key: 'AGY',
				icon: 'icon-antigravity',
				role: 'Antigravity Agent',
				state: 'active',
				desc: 'Synthesizing similarity matrices'
			},
			{
				key: 'Mem',
				icon: 'icon-memory',
				role: 'Memory',
				state: 'complete',
				desc: 'Log indices mapped'
			},
			{
				key: 'Ver',
				icon: 'icon-verify',
				role: 'QA Verify',
				state: 'waiting',
				desc: 'Awaiting final index'
			}
		],
		phases: [
			{ name: 'Reading log history logs', state: 'done', time: '0.3s' },
			{ name: 'Indexing embeddings with vector logic', state: 'active', time: 'Embedding' },
			{ name: 'Validating index latency tests', state: 'pending', time: '--' }
		],
		proofScore: '89% Confidence',
		proofDetail: 'Referencing five memory blocks. Minimum match threshold validated at >= 0.81.'
	},
	blocked: {
		title: 'Approval Needed',
		prompt: 'Delete production migration backup folder logs.',
		systemStatus: 'Sully has paused work. Operator override is required.',
		status: 'blocked',
		statusText: 'Waiting on You',
		bannerText: 'Operator verification required to execute folder deletion.',
		bannerIcon: '⚠️',
		headerIcon: 'icon-blocked',
		activeOwnershipLabel: 'Now: Halted - waiting on operator override',
		activeClass: 'blocked',
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'active-blocked',
				desc: 'Halted at Gate'
			},
			{ key: 'Ver', icon: 'icon-verify', role: 'QA Verify', state: 'idle', desc: 'Halted' }
		],
		phases: [
			{ name: 'Scanning backup files', state: 'done', time: '0.2s' },
			{ name: 'Checking directory protection rules', state: 'done', time: '0.4s' },
			{ name: 'Awaiting manual operator signature', state: 'active', time: 'Halted' }
		],
		proofScore: 'Override Req.',
		proofDetail:
			'Action matches protected pattern: DELETE PRODUCTION LOGS. Halted for operator safety.'
	},
	complete: {
		title: 'Pipeline Verified',
		prompt: 'Deploy sandbox gateway hotfix v1.4.3.',
		systemStatus: 'Hotfix deployment complete. Verification runs successful.',
		status: 'complete',
		statusText: 'Complete',
		bannerText: 'Execution successful. Sandbox environment cleaned.',
		bannerIcon: '✓',
		headerIcon: 'icon-verify',
		activeOwnershipLabel: 'Now: Settled - execution successful',
		activeClass: 'complete',
		workers: [
			{
				key: 'CC',
				icon: 'icon-dispatch',
				role: 'Coordinator',
				state: 'complete',
				desc: 'Successful'
			},
			{ key: 'Ver', icon: 'icon-verify', role: 'QA Verify', state: 'complete', desc: 'Validated' }
		],
		phases: [
			{ name: 'Reading deployment schema', state: 'done', time: '0.1s' },
			{ name: 'Spawning gateway containers', state: 'done', time: '0.8s' },
			{ name: 'Running socket handshake QA checks', state: 'done', time: '1.2s' },
			{ name: 'Compiling response package', state: 'done', time: '0.2s' }
		],
		proofScore: '100% Success',
		proofDetail: 'All four testing suites compiled and executed successfully with zero failures.'
	}
};
