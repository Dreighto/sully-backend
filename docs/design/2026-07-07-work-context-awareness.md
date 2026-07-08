# Sully Work-Context Awareness (retrieval, no bloat)

Operator directive 2026-07-07: "Begin to have Sully actually understand
context from our work without context bloat."

## Goal

Sully answers questions about the ongoing LogueOS work — what we shipped,
project status, what we built and why — by RETRIEVING the relevant slice of
that work per turn, never by stuffing the whole history into the prompt.

## Principle: retrieve, gate, cap

Reuse the existing `semantic.ts` pattern verbatim (mxbai-embed-large via
Ollama, cosine over stored vectors — the same infra behind `getRelevantFacts`).

1. **Index** the work artifacts as embedded document chunks in a new store.
2. **Gate**: only retrieve+inject when the turn is actually about our work
   (relevance gate). Unrelated turns get NOTHING extra — that is the anti-bloat
   guarantee.
3. **Cap**: top-K (4) chunks, hard char cap (~1.5KB), chunks are SUMMARIES not
   raw logs.

## Store (mirror episodic_facts)

- Table `work_knowledge (id, source, source_key, chunk, updated_at, importance)`
  - `work_knowledge_embeddings (chunk_id, embedding, embed_model)`.
- `source` ∈ {ship_log, current_lane, project_memory}. `source_key` is a stable
  dedupe id (trace_id for ships; file#section hash for docs) so re-ingest
  UPSERTs instead of duplicating.

## Ingestion (`work_ingest.ts` + `tools/ingest-work-context.mjs`)

Read → chunk → embed → upsert. Sources (phase 1):

- **Ship log**: `~/dev/LogueOS-Orchestrator/data/cc_completion_log.jsonl` — one
  chunk per row: `"<date> · <status> · <summary>"` keyed by trace_id. Tail the
  last ~200 rows (recent work is what matters).
- **Current lane**: `~/dev/LogueOS-Orchestrator/.logueos/context/current_lane.md`
  — chunk by heading.
- **Project memory** (reference): the operator's `project_*.md` memory files —
  one chunk per file (the title + hook line), keyed by filename.

Idempotent: skip a chunk whose (source_key, content-hash) is unchanged. Manual
run for phase 1; phase 2 wires a 15-min cron.

## Retrieval + wiring

- `getRelevantWorkContext(query, topK = 4): Promise<string[]>` — cosine over
  work_knowledge, threshold-gated (reuse DEFAULT_THRESHOLD).
- **Relevance gate** (the anti-bloat core): a cheap check that the turn is
  work-related before retrieving — keyword prefilter (ship, build, shipped,
  status, working on, project, dispatch, what did we, progress, kernel, Sully
  app, backend, wave, ticket, LOS-/SUL-) OR the top retrieval score clears a
  higher bar. If neither, inject nothing.
- **Injection**: in `buildSystemPrompt`, when gated-in, append a bounded block:
  `\n\n## What we've been working on (relevant to this)\n- <chunk>\n- ...`
  Total appended text hard-capped at ~1500 chars; drop lowest-scored chunks to
  fit. Text surfaces only; voice can reuse the same retrieval later.

## Bloat guardrails (explicit)

- No injection on unrelated turns (gate).
- Top-K=4, ~1.5KB cap, summaries not raw JSON.
- Store holds SUMMARIES (the completion-log `summary` field), not full traces.
- Retrieval is per-turn and stateless; nothing accumulates in the thread.

## Phases

- **Phase 1 (this ticket)**: store + ingestion (ship log + lane + memory) +
  `getRelevantWorkContext` + relevance-gated bounded injection in the text
  prompt + a manual ingest script + unit tests (gate excludes unrelated turns;
  retrieval returns relevant chunks; cap enforced).
- **Phase 2**: 15-min cron auto-ingest; Linear ships as a source; importance
  weighting (recent + confirmed-working ranked higher); voice-path wiring.
