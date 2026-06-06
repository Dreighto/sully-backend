I'll synthesize the two analyses into a single prioritized adoption roadmap. Let me work through the structure carefully before writing.

The two analyses map five Odysseus patterns onto two systems. Let me cross-reference the shared shapes (especially the endpoint registry and execution graph, which exist on both sides and need contract alignment) and produce the buildable plan.

# LogueOS Odysseus Adoption Roadmap

**Scope:** Five Odysseus patterns adopted across the **Kernel** (LogueOS-Orchestrator — dispatch listener + MCP gateway) and the **Companion** (Sully — Svelte 5 / SQLite). Sequenced near → mid → long term, with explicit ownership, effort, the concrete first ticket per item, and the kernel↔companion contract dependencies.

**The organizing principle:** every near-term piece is a *node or edge* in an eventual **Execution Capability Graph**. We build the graph's raw materials first (endpoint registry, tool catalog, curation files), make them queryable per-tier in the mid-term, then unify them into one navigable substrate long-term. The graph is the long-term unifier; everything else ladders into it.

---

## Architecture seam: who owns what

| Layer | Kernel (Orchestrator) | Companion (Sully) |
|---|---|---|
| Source of truth | YAML files in `.logueos/` (hot-reload on worker boot) | SQLite tables in `bootstrap.ts` (live UI mutation) |
| Endpoints | MCP server endpoints (stdio/http/sse) | LLM model endpoints (local/remote/tailscale) |
| Curation | `worker_preferences.yaml` / `tool_curation.yaml` | `curator_settings` table + Settings drawer |
| Graph | `execution_graph.py` (routing brain) | `capabilityGraph.ts` (dispatch + SVG viz) |

**Key insight: these are two registries of the same kind, not one shared registry.** The kernel tracks *MCP tool endpoints*; the Companion tracks *LLM model endpoints*. They must **not** be merged (Decision 1 polyrepo boundary), but they **must share a field schema** so a future operator UI and the graph queries speak one vocabulary. See the Shared Endpoint Shape contract below.

---

## Shared contract: the Endpoint Shape (do this once, both sides import it)

Before either side builds its registry, agree a canonical field set so the eventual graph can join across them. Both the kernel YAML and the Companion table use these field names:

```
endpoint_id, provider, transport|scope, base_url,
cached_items (tools | models), supports_native_function_calls|supports_tools,
pinned, hidden, last_probe_at, last_probe_error, refresh_mode, health_status|visibility
```

**Dependency:** This shared shape is a near-term blocker for BOTH endpoint-registry tickets. Write it as a one-page spec (`.logueos/reference/endpoint_shape.md` in the kernel, mirrored as a TS type in `src/lib/types/` in the Companion) **first**, then both registries implement against it. This is what lets the long-term graph join kernel MCP endpoints and Companion model endpoints without a translation layer.

---

## NEAR-TERM (foundations — the graph's nodes)

### 1. Endpoint registry — shared shape spec + both loaders
- **First ticket (KERNEL):** Create `.logueos/endpoint_registry.yaml` (parallel to `capability_registry.yaml`) and a `tools/logueos_mcp_gateway/endpoint_registry.py` loader mirroring the `capability_registry.py` pattern, exposing `is_endpoint_allowed(endpoint_id, project_id)` and `list_available_endpoints(project_id)`; wire iteration into `services/dispatch_listener/src/mcp_config.js` so allowed endpoints auto-populate the `.mcp.json` template per project.
- **First ticket (COMPANION):** Add an `endpoints` table to `src/lib/server/bootstrap.ts` and a `src/lib/server/model_endpoints.ts` service (`createEndpoint`/`probeEndpoint`/`listEndpointModels`/`discoverLocal`/`updateCuration`); integrate the cache into `llm_router.ts` provider-fallback. UI (Add Endpoint modal) is a fast follow.
- **Owner:** Both | **Priority:** High | **Effort:** M each
- **Dependency:** Both consume the Shared Endpoint Shape (above). Write that spec first — it's the gating sub-task.

### 2. Persisted operator curation files (kernel) / table (companion)
- **First ticket (KERNEL):** Add `.logueos/tool_curation.yaml` (per-tool `hidden`/`pinned`/`low_quality_filter`/`replacement_tool`) and `.logueos/worker_preferences.yaml` (per-project `preferred_worker_for_task_shape`/`disabled_workers`/`worker_restrictions`), plus a `tools/logueos_mcp_gateway/curation.py` loader exposing `get_curator_hints(tool_name, project_id)` and `get_worker_preferences(project_id)`; expand `capability_registry.yaml` with `curator_hints` tags. Hot-reload on worker boot, no listener restart.
- **First ticket (COMPANION):** Add a `curator_settings` table (`setting_key`, `setting_value` JSON, `updated_at`) to `bootstrap.ts` and `src/lib/server/operatorCuration.ts` (`getCuratedTools`/`getCuratedEndpoints`/`getCuratedWorkerForRole`/`saveCuration`), loaded into `serverConfig` on startup.
- **Owner:** Both | **Priority:** High (kernel) / Medium (companion) | **Effort:** M each
- **Dependency:** Reads endpoint IDs + tool IDs from #1. Curation is "an opinion layer over the node list," so #1 must land first or land in the same PR train.
- **Why near-term:** curation is cheap, additive, and immediately useful (operator can hide noisy tools / pin a worker) — and it's the third graph input.

### 3. Kernel artifact-persistence hook (the kernel's half of "research jobs")
- **First ticket (KERNEL):** Create `tools/logueos_mcp_gateway/artifact_store.py` (writes to a kernel-managed `data/artifacts/<project_id>/`) and enhance `docs_write_tools.py` so workers can persist structured artifacts (research reports, comparison results, audit summaries). Kernel provides durable storage only — **no** research-job semantics (that would violate Decision 1).
- **Owner:** Kernel | **Priority:** Medium | **Effort:** S
- **Dependency:** This is the substrate the Companion's research jobs (mid-term) write into. Land the hook near-term so the Companion's larger research feature has somewhere to land.

---

## MID-TERM (queryable per-tier — the graph's edges + execution modes)

### 4. RAG tool surfacing + hard execution modes
- **First ticket (KERNEL):** Add `tools/logueos_mcp_gateway/tool_catalog.yaml` (fnmatch patterns + descriptions + rankings) and split `profiles.py` `_PROFILE_ALLOWLISTS` into three layers — (1) base category allowlist, (2) execution-mode overrides (`inspect_only` strips writes; `compare_safe` removes dispatch+network), (3) per-worker ranking hints; expose `GET /mcp/tools-by-profile` in `api_v1.py` for workers to query at boot.
- **First ticket (COMPANION):** Create `src/lib/server/tool_index.ts` (`TOOL_REGISTRY`: toolId → description/keywords/category/required_role/execution_modes) and `toolsForContext(tier, mode, worker_role)`; filter tools before system-prompt assembly in `chat_turn.ts`, strip mutation tools (`write_file`/`git_push`) in compare-safe mode; add `executionMode` to `WorkSurfaceTask` + `PATCH /api/chat/dispatch/[trace]/mode`.
- **Owner:** Both | **Priority:** High | **Effort:** M each
- **Dependency:** `profiles.py` becomes the single source of truth for both enforcement AND surfacing — this is the kernel-side enforcement that makes `compare_safe` mode real, which the compare feature (#6) depends on. Build before compare.

### 5. Durable research jobs (Companion userspace)
- **First ticket (COMPANION):** Add a `research_jobs` table to `bootstrap.ts` (`job_id`, `status` planning→done/failed, `plan`, `queries`, `findings`, `final_report`, `provider_used`) and `src/lib/server/deepResearch.ts` (`ResearchEngine`: `startResearch`/`streamResearchProgress` SSE/`getResearchResult`); routes `POST /api/research/start`, `GET /api/research/[job_id]/progress` (SSE), `POST /api/research/[job_id]/spinoff`; store results in `pending_jobs.verification_evidence` so Go/No-Go references them without re-running.
- **Owner:** Companion (lifecycle/UI) + Kernel (storage hook from #3) | **Priority:** High | **Effort:** L
- **Dependency:** Final reports persist via the kernel `artifact_store.py` (#3). Spinoff-into-dispatch reuses the existing dispatch FSM. Land #3 first.

### 6. Blind multi-pane compare across worker bundles
- **First ticket (KERNEL):** Add `compareBundle({bundle_specs:[{worker,role,model_override,tool_profile,worker_flags}]})` to `services/dispatch_listener/src/routing.js` (returns sealed bundles with `blind_mapping` hidden until reveal + `probeResults`) and `POST /dispatch/compare-bundles` in `api_v1.py` that probes worker/endpoint availability and returns dispatch-ready bundles; enforce compare-safe tool-stripping (from #4).
- **First ticket (COMPANION):** Add a `compare_runs` table (`run_id`, `trace_ids[]`, `worker_bundles`, `mode`, `is_blind`, `blind_mapping`, `votes`) to `bootstrap.ts`; `POST /api/compare/start` (probe health, create ephemeral dispatch rows, randomize blind mapping), `GET /api/compare/[run_id]`, `POST /api/compare/[run_id]/vote` (reveal after vote); render two `WorkSurfaceCard`s side-by-side with synced timeline (`CompareMode.svelte`).
- **Owner:** Both | **Priority:** High (kernel primitive) / Medium (companion UI) | **Effort:** M (kernel) / L (companion)
- **Dependency:** Requires compare-safe execution mode from #4 (kernel) and the endpoint registry's health/probe data from #1. The kernel owns *compare semantics + tool-stripping*; the Companion owns *UI + vote lifecycle*. Build #4 before #6.

---

## LONG-TERM (the unifier — the Execution Capability Graph)

### 7. Execution Capability Graph
This is the crown-jewel pattern and the **reason every near-term file was shaped the way it was**. Each prior piece is a graph input:

- worker roster (`allowlist.js`) → **worker nodes**
- endpoint registry (#1) → **endpoint nodes**
- tool catalog + profiles (#4) → **tool nodes + worker↔tool edges**
- curation (#2) → **edge weights / visibility filters**
- routing rules (`dispatch_routing.json`, `w2_routing_rules.json`) → **task-shape → worker edges**

- **First ticket (KERNEL):** Create `tools/logueos_mcp_gateway/execution_graph.py` — an `ExecutionGraph` class synthesizing the scattered state above, with `resolve_worker_bundle(task_shape, project_id, mode)`, `query_by_capability(capability_name, project_id)`, `get_routing_candidates(role, project_id)` (availability + health filtered); wire into the dispatch POST handler in `api_v1.py`; expose read-only `GET /api/v1/execution-graph/query`; document schema at `.logueos/reference/execution_graph_schema.md`.
- **First ticket (COMPANION):** Create `src/lib/server/capabilityGraph.ts` (`CapabilityGraph`: nodes={core, workers, endpoints}, edges={worker↔endpoint, worker↔tool, endpoint↔model}) with `queryCapability(need) → {best_worker, endpoint, available_tools}`; expose `GET /api/capability-graph`; replace manual worker selection in `companionDispatch.ts` with `queryCapability({role:'Build'})`; feed `WorkGraph.svelte` SVG layout.
- **Owner:** Both | **Priority:** High (kernel) / Low (companion, viz-led) | **Effort:** L each
- **Dependency (critical):** The Companion's `capabilityGraph.ts` should **query the kernel's `GET /api/v1/execution-graph/query`** for the worker/endpoint/tool substrate rather than re-deriving it — the kernel is the authority on worker availability and tool profiles. The Companion graph adds the *model-endpoint* dimension and the *visualization*. This is exactly why the Shared Endpoint Shape (top of doc) matters: the join only works if both sides named fields identically.

### 8. Operator experience layer (Console + viz)
- **First ticket (KERNEL/CONSOLE):** Add Console queries against the graph, an execution-graph visualization, and a "routing debug" card — operator reasons about/visualizes routing instead of hand-editing `dispatch_routing.json`.
- **Owner:** Kernel (Console-side) + Companion (`WorkGraph.svelte`) | **Priority:** Low | **Effort:** M
- **Dependency:** Consumes #7's query endpoints on both sides.

---

## How the ladder works

```
NEAR              MID                      LONG
endpoint reg #1 ─┐
tool catalog ────┤→ tools-by-profile #4 ─┐
curation #2 ─────┘                       ├→ EXECUTION CAPABILITY GRAPH #7 ─→ operator viz #8
artifact hook #3 ─→ research jobs #5     │
                    compare bundles #6 ──┘
```

Near-term builds the **nodes** (endpoints, tools, curation). Mid-term builds the **edges and execution semantics** (surfacing, modes, compare, research). Long-term **synthesizes** them into one queryable graph and exposes it to the operator. Skip the foundations and the graph has nothing to synthesize.

---

## DO-FIRST 3

1. **Write the Shared Endpoint Shape spec** (`.logueos/reference/endpoint_shape.md` + mirrored TS type in Companion `src/lib/types/`). One page, both teams import it. It's the only true cross-repo blocker and it unblocks both #1 tickets and the long-term graph join. **Kernel-led, S, do today.**
2. **Kernel endpoint registry** (`.logueos/endpoint_registry.yaml` + `endpoint_registry.py` loader + `mcp_config.js` wiring). The first graph node-set and the highest-leverage kernel infra. **Kernel, M.**
3. **Kernel curation files** (`tool_curation.yaml` + `worker_preferences.yaml` + `curation.py`). Cheap, additive, immediately operator-visible, and the second graph input — hot-reloads with no restart. **Kernel, M.**

(The Companion's parallel #1 endpoint table + `model_endpoints.ts` is the natural fourth, runnable in parallel by the Companion team once the Shared Shape lands.)