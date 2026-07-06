// Wave 2 split (2026-07-06): this file used to hold every artifact-store
// concern directly (495 lines). It's now a re-export barrel over
// artifactClassify.ts (ext/preview/thumb/language/type-classification
// helpers), artifactManifest.ts (store paths + manifest I/O + purge), and
// artifactPromote.ts (both promotion flavors: worker-file + teacher-inline).
// Kept as a barrel — not deleted — because this module has wide external
// fanout (8+ importers across routes/lib/tests); every existing
// `from '$lib/server/artifactStore'` import keeps working unchanged.

export {
	ext,
	basename,
	previewFromText,
	previewFromFile,
	languageForExt,
	thumbUrlFor,
	classifyArtifactType,
	ARTIFACT_TYPE,
	PREVIEW_TYPES
} from './artifactClassify';

export {
	storeRoot,
	artifactRepoRoot,
	storeDirFor,
	findStoreDir,
	writeManifestAtomic,
	readManifest,
	purgeThreadArtifacts,
	type ArtifactMetadata
} from './artifactManifest';

export {
	selectPromotions,
	promoteArtifactsForTask,
	mintTeacherTraceId,
	promoteInlineArtifacts,
	type Promotion,
	type PromoteInput,
	type PromoteResult,
	type InlineArtifactInput
} from './artifactPromote';
