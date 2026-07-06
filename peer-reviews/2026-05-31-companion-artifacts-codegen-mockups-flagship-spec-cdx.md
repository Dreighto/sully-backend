# Companion Flagship Surface: Artifacts + Code Gen + Mockups

**Date:** 2026-05-31  
**Author:** CDX (Codex)  
**Status:** Proposed implementation map for flagship all-in-one Companion experience

## Goal

Turn Companion into a flagship LLM app surface that removes manual copy/paste across multiple tools by providing:

- First-class artifacts
- Safe code generation and apply flow
- Mockup generation with preview/export
- Persistent history and recoverable runs

This should feel like one operating surface for ideation -> generation -> review -> apply.

## Product Direction

Companion should support this default workflow:

1. Prompt in chat
2. Generate one or more artifacts
3. Review output (preview + metadata + diff)
4. Approve and apply changes to workspace
5. Preserve version history and run traceability

The system must preserve safety:

- No silent writes to repo files
- All write paths go through explicit review/approval
- Every apply action is auditable

## Visual Roadmap

```mermaid
flowchart TD
    A[Current Companion Chat] --> B[Phase 1: Artifacts v1]
    B --> B1[Artifact model: id, type, thread_id, run_id, path, status]
    B --> B2[Artifact storage: local files + metadata index]
    B --> B3[UI panel: list/open/reuse artifacts]
    B --> B4[Safety: preview before apply]

    B --> C[Phase 2: Code Gen v1]
    C --> C1[Templates: component/api/test/script]
    C --> C2[Generate -> Diff Preview -> Approve -> Write]
    C --> C3[Attach outputs to thread/run]

    C --> D[Phase 3: Mockups v1]
    D --> D1[Prompt -> HTML/CSS/TSX artifact]
    D --> D2[Isolated live preview sandbox]
    D --> D3[Explicit export to repo]

    D --> E[Phase 4: Flagship UX]
    E --> E1[Retry/resume generation]
    E --> E2[Version history per artifact]
    E --> E3[Status/cost/runtime metadata]
    E --> E4[Multi-artifact bundles]

    E --> F[Phase 5: Advanced]
    F --> F1[Worktree-aware targets]
    F --> F2[Shareable artifact links]
    F --> F3[Autonomous background generation with policy gates]
```

## Screen-by-Screen Flow

```mermaid
flowchart TD
    A[Chat Screen] --> B[Composer Actions]
    B --> B1[Generate Artifact]
    B --> B2[Generate Code]
    B --> B3[Generate Mockup]

    B1 --> C1[Artifact Wizard]
    B2 --> C2[Code Wizard]
    B3 --> C3[Mockup Wizard]

    C1 --> D[Run Generation]
    C2 --> D
    C3 --> D

    D --> E[Generation Status Sheet]
    E --> E1[Queued]
    E --> E2[Running]
    E --> E3[Succeeded]
    E --> E4[Failed + Retry]

    E3 --> F[Artifact Detail Screen]
    F --> F1[Content Preview]
    F --> F2[Metadata: type/thread/run/time/cost]
    F --> F3[Version History]
    F --> F4[Actions]
    F4 --> F41[Copy]
    F4 --> F42[Regenerate]
    F4 --> F43[Open Diff]
    F4 --> F44[Export/Apply]

    F43 --> G[Diff Review Screen]
    G --> G1[Accept All]
    G --> G2[Accept Hunks]
    G --> G3[Reject]

    G1 --> H[Write Confirmation]
    G2 --> H
    H --> I[Applied Result Toast + Log Entry]

    I --> J[Artifacts Panel]
    J --> J1[All Artifacts]
    J --> J2[By Thread]
    J --> J3[By Project]
    J --> J4[Search/Filter]
```

## Component Tree

```text
App
└─ ChatPage
   ├─ ChatThreadList
   ├─ ChatMessageList
   ├─ ChatComposer
   │  ├─ ActionMenu
   │  │  ├─ GenerateArtifactButton
   │  │  ├─ GenerateCodeButton
   │  │  └─ GenerateMockupButton
   │  └─ ModelSelector
   ├─ GenerationStatusSheet
   │  ├─ QueueState
   │  ├─ RunningState
   │  ├─ SuccessState
   │  └─ FailureState
   ├─ ArtifactsPanel
   │  ├─ ArtifactFilters (thread/project/type/status/search)
   │  ├─ ArtifactList
   │  │  └─ ArtifactListItem
   │  └─ ArtifactDetailDrawer
   │     ├─ PreviewTab
   │     ├─ DiffTab
   │     ├─ HistoryTab
   │     └─ MetadataTab
   ├─ DiffReviewModal
   │  ├─ FileDiffView
   │  ├─ HunkSelector
   │  └─ ApplyActions
   └─ ConfirmApplyModal
```

## Data Model

```json
{
	"artifact": {
		"id": "art_01...",
		"thread_id": "thr_01...",
		"run_id": "run_01...",
		"project": "LogueOS-Console",
		"type": "markdown|code|json|mockup|image",
		"title": "string",
		"status": "queued|running|succeeded|failed|applied|archived",
		"source_prompt": "string",
		"model": "string",
		"cost_usd": 0.0,
		"duration_ms": 0,
		"file_paths": ["/abs/path/..."],
		"preview_path": "/abs/path/preview.html",
		"diff_path": "/abs/path/diff.patch",
		"error": null,
		"version": 3,
		"created_at": "ISO8601",
		"updated_at": "ISO8601"
	}
}
```

## API Contract

### `POST /api/artifacts/generate`

Request:

```json
{
	"thread_id": "thr_01",
	"project": "LogueOS-Console",
	"mode": "artifact|code|mockup",
	"prompt": "Build a responsive settings panel",
	"template": "react_component",
	"target_paths": ["src/lib/components/SettingsPanel.svelte"],
	"options": {
		"model": "gemini-2.5-flash",
		"temperature": 0.2
	}
}
```

Response:

```json
{
	"artifact_id": "art_01",
	"run_id": "run_01",
	"status": "queued"
}
```

### Other routes

- `GET /api/artifacts/:id`
- `GET /api/artifacts?thread_id=&project=&type=&status=&q=`
- `POST /api/artifacts/:id/regenerate`
- `GET /api/artifacts/:id/diff`
- `POST /api/artifacts/:id/apply`
- `POST /api/artifacts/:id/archive`
- `GET /api/artifacts/:id/history`

Apply request example:

```json
{
	"approve": true,
	"strategy": "all|selected_hunks",
	"selected_hunks": ["hunk_1", "hunk_4"]
}
```

## Client State Shape

```text
artifactStore
- byId: Record<artifact_id, Artifact>
- list: artifact_id[]
- filters: {thread, project, type, status, q}
- activeArtifactId: string | null
- generationJobs: Record<run_id, {status, progress, error}>
- ui: {detailOpen, diffOpen, statusSheetOpen}
```

## Reliability + Safety Requirements

- Default write path is always: generate -> preview -> approve -> apply.
- Never auto-write repo files on generation success.
- Persist source hash pre/post apply for rollback visibility.
- Every apply action records actor, time, target files, selected hunks.
- Failed generations must support retry with preserved parameters.

## Why This Is Flagship

This reduces tool sprawl and manual transfer friction:

- Single chat-driven operating surface
- Structured outputs instead of ad-hoc copy/paste
- Safe write controls with diff review
- Durable artifacts and version history
- Clear operator confidence through metadata and auditability

## Recommended Build Order

1. Artifacts v1 storage + panel + detail view
2. Code-gen diff/apply flow
3. Mockup generation + isolated preview
4. Versioning + resume/retry + cost/runtime metadata
5. Advanced worktree-aware and bundle generation
