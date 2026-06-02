# Workspace + Context Architecture Comparison — June 2026

**For Sully (LogueOS-Companion).** This file is the canonical reference for how flagship AI chat apps (Claude, Gemini, Perplexity, ChatGPT) handle per-workspace context, files, and instructions as of June 2026. Re-research only on a clear feature shift; until then, reference this doc when designing Sully's workspace UI.

> **Why this exists:** Sully currently buries "Edit Sully's context" as a footer item inside the model-picker popover. Every one of the four flagship apps treats per-workspace context as a _first-class surface_ — not as an accessory to model selection. This doc explains how each does it, what's worth borrowing, and where Sully should land.

---

## TL;DR

- **All four apps make context first-class.** None of them hide instruction/file editing behind a model picker. Claude uses right-side knowledge panels inside Projects; Gemini uses Gems + NotebookLM's three-column layout; Perplexity uses Spaces with a dedicated creation modal; ChatGPT uses Project Settings via a three-dot menu inside the project. Sully's footer-inside-model-picker pattern is an outlier.
- **All four explicitly layer global vs per-workspace.** Every app has an account-wide preferences layer (Claude profile instructions, Gemini global instructions, ChatGPT global Custom Instructions; Perplexity is the exception with no global-instructions field, only org-level Enterprise governance). Each _also_ has a per-workspace layer that stacks on top, and three of the four explicitly document the override/precedence order.
- **Files are universally a workspace concern, not a chat concern.** Claude Projects, Gemini Notebooks/Gems, Perplexity Spaces, and ChatGPT Projects all give the workspace its own files panel — separate from per-message attachments. Files persist; they aren't re-uploaded each chat.
- **Memory is a distinct third layer in Claude and ChatGPT.** Both treat auto-synthesized memory as a separate global axis from instructions. Gemini's "Saved Info" is the same shape. Perplexity does not yet have a comparable account-wide memory layer.

**Most important finding:** Every app surfaces context-editing where users _look for it_ (the workspace page itself, a dedicated Settings page, or a creation modal). Sully's current footer-in-model-picker pattern asks operators to open one menu to perform an unrelated action — the empirical pattern across the industry is that this conflation suppresses both discoverability and usage.

---

## Per-app deep dive

### Claude (Anthropic)

**Workspace concepts:**

- **Projects** — Self-contained workspaces with their own knowledge base (uploaded files), per-project custom instructions, and persistent chat history. 200K context window per project, with RAG fallback on paid plans expanding effective capacity ~10x. Launched June 2024; by 2026 available to all tiers (free capped at 5 projects, paid unlimited). Team/Enterprise add Can use / Can edit sharing permissions.
- **Skills (Agent Skills)** — Filesystem-style folders containing `SKILL.md` + optional scripts. Auto-loaded by metadata at startup, contents read on-demand when triggered. Per-user on claude.ai (zip upload via Settings > Features), workspace-wide on the API, filesystem-based in Claude Code. Launched October 2025; 17 official skills + 135K+ stars on the public repo by May 2026.
- **Memory** — Auto-synthesized facts-about-the-user summary updated ~every 24h. User-editable list at Settings > Memory. Rolled out to all tiers including free in March 2026. File-based "Memory Files" + Claude Dreaming (background consolidation) launched as research preview at Code with Claude May 2026.
- **Profile Instructions (global)** — Account-wide "Instructions for Claude" text block applied to every conversation regardless of project. Set via user-initials avatar (top-right) > Settings.

**Where context is set:** Three distinct locations:

1. **Global profile instructions:** user-initials avatar (top-right) > Settings > "Instructions for Claude" [^cla1][^cla3]
2. **Per-project instructions:** open project from left sidebar > dedicated "Instructions" panel adjacent to the knowledge base [^cla1][^cla2]
3. **Project knowledge base:** right-side panel on the project's main page with a `+` button to add content [^cla2]
4. **Custom Skills:** Settings > Features (zip upload) [^cla4]
5. **Memory:** Settings > Memory (individually editable snippets) [^cla6]

**Input types:**

- Text instructions (per-project block, ~200–500 words recommended)
- File uploads: PDF, DOCX, CSV, TXT, HTML, code files, markdown; up to 30 MB per file, unlimited file count (200K token soft cap, RAG expands ~10x on paid)
- Pasted text snippets into the knowledge base
- Custom Skills (zip uploads via Settings > Features, claude.ai surface)
- Account-global profile instructions (text, ~500 words recommended)
- Memory snippets (auto-generated or user-dictated)

**Per-workspace vs global:** Both layers exist explicitly and stack. Stacking order per Anthropic docs: profile preferences (global) load first → per-project instructions add context on top → Skills/Styles adjust delivery on activation. Project instructions take precedence on direct conflict but do **not** replace global preferences. Memory is a third separate global layer that applies across all chats and is not per-project. [^cla3]

**Distinctive features:**

- Knowledge base with auto-RAG when content exceeds 200K (paid)
- Per-project custom instructions (system-prompt-equivalent)
- Persistent chat history scoped to the project
- Team sharing with Can use / Can edit roles (Team/Enterprise)
- Shared project activity feed (Team)
- Skills auto-trigger on description match — no per-chat picker
- Settings > Memory exposes every stored snippet individually editable/deletable
- Privacy guarantee: project data not used for training without explicit consent

**Limits:**

- Per file: 30 MB
- File count: unlimited (soft cap = 200K token context window; RAG expands ~10x on paid)
- Free tier: 5 projects max; paid: unlimited
- Profile + project instructions recommended 200–500 words (best practice, not enforced)
- Skill name 64 chars max, description 1024 chars max

**Key UI patterns worth borrowing:**

- Right-side knowledge panel on the project page — files always visible, persistent above any conversation, prominent `+` add-content button
- Project instructions in their _own_ panel inside the project page (NOT inside the model picker or a footer)
- Global "Instructions for Claude" reached via the user-initial avatar in the top-right > Settings — a _conventional_ location for account-wide settings
- Skills activated automatically by YAML frontmatter description matching — zero picker overhead
- Memory has its own Settings > Memory page with individually editable snippets
- Projects appear as first-class entries in the left sidebar _above_ standalone chats — "which workspace am I in?" is always answerable at a glance

**Citations:** [^cla1] [^cla2] [^cla3] [^cla4] [^cla5] [^cla6] [^cla7]

---

### Gemini (Google)

**Workspace concepts:**

- **Gems** — Saved reusable Gemini configurations bundling Name, Description, Instructions, an optional default tool, and optional Knowledge files. Acts like a persistent custom persona / mini-agent (writing coach, coding mentor) opened from the Gem manager. Per-Gem scope only. Global Gemini personalization is _explicitly not applied_ inside Gems or Live chats. Gem creation gated to Gemini Advanced ($19.99/mo) per 2026 reporting.
- **NotebookLM Notebooks** — A research workspace pinned to a curated set of sources. Three-column layout: **Sources (left) │ Chat (middle) │ Studio (right)**. Every chat answer is grounded in and cites the uploaded sources. Studio generates derivative artifacts: Audio Overviews, Video Overviews, Mind Maps, Reports, Slide Decks, Infographics, Flashcards, Quizzes. Per-notebook scope — no cross-notebook memory. Three-panel Studio redesign mid-2025; March 2026 update added EPUB sources, PPTX export, saved chat history, slide revisions, 10 infographic styles, persistent flashcard progress.
- **Gemini Personalization / Saved Info** — Account-level personalization: global custom instructions ("Instructions for Gemini"), Saved Info (long-term memory), memory of past chats, optional connections to Google apps (Gmail, Drive, Calendar). Personal Intelligence decides per-prompt which to pull in. Personal-Google-account only — not Workspace/school/supervised. Workspace Intelligence (org-level equivalent) announced 2026.

**Where context is set:** Three different surfaces depending on concept:

1. **Global Gemini custom instructions:** Menu > Settings & help > Personal Intelligence > Instructions for Gemini (web) or Menu > profile > Personal Intelligence > Instructions for Gemini (mobile). Single text field, applies to every chat. [^gem1][^gem2]
2. **Gem-level instructions:** Gem editor opened from "Explore Gems" > New Gem (or the Gem manager from the profile menu). Dedicated Instructions box plus a separate Knowledge files uploader. [^gem1]
3. **NotebookLM notebook context:** add Sources from the left-hand Sources panel (Add button > upload, paste URLs, pick from Drive, or search Web/Drive via Fast/Deep Research). [^gem3][^gem4]

**Input types:**

- Plain-text instructions (Gem Instructions box; Gemini global "Instructions for Gemini")
- Knowledge files attached to a Gem (device or Google Drive)
- NotebookLM sources: PDFs, .docx, .txt, .md, CSV, .pptx, EPUB
- NotebookLM Google Workspace sources: Docs, Slides (up to 100), Sheets (100k token cap)
- NotebookLM media: MP3/WAV audio; images (JPEG/PNG/WebP/GIF/HEIF/TIFF, including handwritten notes)
- NotebookLM web URLs (space- or newline-separated, multiple at once)
- NotebookLM YouTube links (public, captions required, more than 72h old)
- Pasted text (NotebookLM "paste text" source)
- Gemini Chats imported into NotebookLM as context
- Connected Google apps as ambient context for Gemini personalization
- Saved Info / Memory entries added by asking Gemini to "remember" something

**Per-workspace vs global:** Both layers exist and are explicitly separate.

- **Global:** "Instructions for Gemini" + Saved Info + connected apps + past-chat memory, in Settings > Personal Intelligence. Applies to every regular Gemini chat.
- **Per-workspace:** Gems (each Gem has its own Instructions + Knowledge, _isolated from global instructions_ — docs state global instructions are "not available in Gems or Live chats") and NotebookLM Notebooks (each notebook is its own corpus, no cross-notebook memory).

Net effect: a user can run global voice/format preferences plus N specialized Gems plus M source-grounded notebooks in parallel.

**Distinctive features:**

- Gems: persona/role definition with recommended 500–2,000-char structure (Role → Style → Knowledge → Format → Constraints)
- Gems: attachable Knowledge files for repeatable context
- Gems: optional Default tool per Gem
- Gems: premade Gems library (career coach, brainstormer, coding helper)
- NotebookLM: every answer cites the underlying source passages (the differentiator)
- NotebookLM Studio: Audio Overviews (two-host podcast with interactive "join the conversation" voice mode)
- NotebookLM Studio: Cinematic Video Overviews (March 2026), Mind Maps, Reports, Slide Decks, Infographics (10 styles incl. Kawaii/Editorial/Bento), Flashcards + Quizzes with persistent progress
- NotebookLM: Fast Research vs Deep Research source-finding from Web or Drive
- NotebookLM: PPTX export and EPUB import (March 2026)
- NotebookLM: Drive sources auto-sync every few minutes
- Personalization: Saved Info, past-chat memory, connected Google apps; Personal Intelligence chooses what to apply per prompt
- Workspace Intelligence (Enterprise): org-level context layer that learns voice/format from Workspace data

**Limits:**

- NotebookLM (Free): up to 50 sources per notebook; each up to 500,000 words or 200 MB
- Google Sheets capped at 100k tokens; Slides up to 100 slides
- YouTube must be public, captioned, and older than 72h
- NotebookLM does **not** import footnotes or comments from Google files
- Gems: recommended (not enforced) 500–2,000 characters per instruction; no published character/file/Gem-count limits
- Gemini global instructions: single text field, no documented character limit; "forget/avoid" instructions unreliable
- Audio Overview interactive voice mode is English-only at launch

**Key UI patterns worth borrowing:**

- **NotebookLM three-column layout:** Sources (left) │ Chat (middle) │ Studio (right) — mirrors the linear workflow gather → ask → produce
- **NotebookLM Studio:** four creation tiles pinned at top of right panel (Audio / Video / Mind Map / Reports), with previously-generated artifacts listed below as cards
- **NotebookLM Sources panel:** prominent "Add" button at top opens a unified picker (upload / Drive / URL / paste / Web search / Deep Research) instead of separate buttons
- **Gems** as a first-class creation flow from profile menu / Explore Gems — NOT hidden under a settings submenu
- **Gem editor:** persona-as-character framing with named fields (Persona / Task / Context / Format) and a separate Knowledge uploader
- Global Gemini instructions are _deliberately_ low-prominence vs. Gems — Google's design choice to push users toward Gems for anything non-trivial
- Connected-apps toggles surfaced as a discrete reviewable/disconnectable list — privacy as a UI affordance
- NotebookLM source cards double as citation chips inside chat replies (clicking scrolls/highlights the source)

**Citations:** [^gem1] [^gem2] [^gem3] [^gem4] [^gem5] [^gem6] [^gem7] [^gem8]

---

### Perplexity

**Workspace concepts:**

- **Space** — Persistent project-scoped workspace bundling related Threads, a knowledge layer (uploaded files + linked URLs), a default model, custom instructions, and collaborator access controls. Functions as a "folder" that owns the AI context for everything inside. Launched October 17, 2024 alongside Internal Knowledge Search; feature-expanded through June 2026 (Computer-in-Spaces, Scheduled Tasks for Pro, Templates Gallery).
- **Thread** — Single conversation history, created automatically with each new search. The atomic Q&A unit. Threads live free-standing in History or parented to a Space (then inherit Space files + instructions + model).
- **Internal Knowledge Search** — Capability layer that lets Pro and Enterprise Pro users search uploaded files and connected cloud sources (Drive, OneDrive, SharePoint, Dropbox, Box) alongside the live web. Account-level capability, surfaces inside Spaces.
- **Enterprise Team workspace** — Org-level container above Spaces. Adds SSO, SCIM, role-based access, audit logging, "unlimited teammate collaboration in private Spaces."

**Where context is set:** Custom Instructions and the default model are set inside the Space creation/edit modal, reached via the **Spaces** tab in the left navigation rail > "Create a Space" (or `+`) button. Modal contains: Title, optional emoji/icon, Description textarea, **Custom Instructions textarea**, Default Model dropdown. After creation, Space detail view exposes the same controls for editing, plus an "Add Sources / Add Files / Add Links" panel typically rendered on the **right side**, and a top-right "Share" button. The student-guide blog explicitly says: _"click Add Sources on the right side of your screen to upload your course documents…if you want to give specific instructions, you can do so by clicking Add Instructions just above."_ [^pplx1][^pplx2]

**Input types:**

- Custom Instructions text (persistent persona / response-style / grounding rules applied to every thread in the Space)
- File uploads: PDF, Word (.doc/.docx), Excel (.xls/.xlsx), PowerPoint, CSV, plain text, code, images, audio, video
- Cloud-source connectors: Google Drive, OneDrive, SharePoint, Dropbox, Box (Pro/Enterprise)
- Web links/URLs added via Add Links — ingested as Space-grounding knowledge
- Default model selection per Space (Sonar, Claude variants, GPT variants, customized DeepSeek R1)
- Enterprise integrations: Crunchbase, FactSet (with active org subscriptions)
- Computer-in-Spaces artifacts (April 2026): docs, slides, sheets created by Perplexity's Computer agent, saved back into the Space

**Per-workspace vs global:** Strongly per-Space. Each Space owns its Custom Instructions, default model, file/link knowledge set, and sharing permissions; Threads inside inherit. Outside of Spaces, threads run with global account defaults. **There is no documented account-wide "system prompt / global custom instructions"** equivalent to ChatGPT's account-level Custom Instructions — persistent persona/grounding lives at the Space level. Enterprise adds an org-level layer (SSO, SCIM, role-based access, audit logging, default training opt-out) but that governs _access_ and _data-handling_, not a global instruction prompt.

**Distinctive features:**

- Persistent Custom Instructions per Space that auto-apply to every new Thread inside
- Per-Space default model selector (a Space can be pinned to Sonar, Claude, GPT, or DeepSeek R1)
- Internal Knowledge Search: AI answers cite uploaded files AND live web in the same response, with file-level citations
- Granular collaborator sharing: Private / Anyone-with-link View / Contributor / org-wide
- Enterprise Pro: uploaded files + queries excluded from AI training by default; Pro users opt out manually
- Spaces Templates Gallery (2026): pre-built Spaces for Competitive Intelligence, Course Planner, etc.
- Scheduled Tasks inside Spaces (2026 Pro): Space proactively runs recurring research threads and notifies collaborators
- Computer-in-Spaces (April 2026): Computer agent creates/edits docs, slides, sheets in the Space; saved artifacts become persistent context
- Move existing Threads into a Space to inherit instructions + files (manual)

**Limits:**

- Pro tier: up to 50 files per Space, 25 MB per file
- Enterprise Pro: up to 500 files per Space, per-file cap raised to 50 MB in Threads context
- Free tier: file uploads exist but tightly capped (~10 file uploads/day for Pro on consumer-thread side; Max plan lifts to ~100/day) — this is the _daily-action_ cap, not the per-Space storage cap
- Supported types: PDF, Word, Excel, PowerPoint, CSV, plain text, code, images, audio, video
- No documented total-knowledge byte budget; public cap is `file-count × per-file-size`

**Key UI patterns worth borrowing:**

- Left nav rail **Spaces** tab as the persistent entry point alongside Home/Discover/Library
- "Create a Space" `+` button opens a **single modal** with all foundational fields stacked: Title, emoji, Description, Custom Instructions, Default Model, Continue — the canonical _"configure once, use forever"_ pattern
- Space detail view: two-zone layout, main chat/thread area left, **Sources/Knowledge sidebar on the right** with "Add Sources" button, file chips, and **"Add Instructions" right above the sources panel**
- Top-right "Share" button on Space header with visibility toggle and email-invite with role dropdown
- Threads within a Space listed under the Space header, scoped (not in global History)
- File chips show ingestion status; clicking surfaces metadata
- In 2026 the Space header displays the default model badge so users see _at a glance_ which model this Space uses before they ask

**Citations:** [^pplx1] [^pplx2] [^pplx3] [^pplx4] [^pplx5] [^pplx6] [^pplx7]

---

### ChatGPT (OpenAI)

**Workspace concepts:**

- **Projects** — Smart workspace bundling chats, uploaded reference files, and project-specific custom instructions. Each project gets a name, icon, color, optional instructions, file/source library, and its own memory mode (default vs project-only). Project instructions OVERRIDE global Custom Instructions inside the project. Available Free, Go, Plus, Pro, Business, Enterprise, Edu. Generally available 2025; project sharing GA'd to all plans Oct 22, 2025.
- **Custom GPTs** — Separate, more "app-like" construct: custom version of ChatGPT with system prompt, knowledge files, connected tools/actions. Single-player, static, discoverable in a GPT store. Distinct from Projects: Projects are multi-player live context hubs that evolve; GPTs are reusable curated assistants. Up to 10 knowledge files per GPT for its lifetime.
- **Custom Instructions (global)** — Two long-form text fields applied to every conversation account-wide: "What would you like ChatGPT to know about you to provide better responses?" and "How would you like ChatGPT to respond?" Overridden by Project instructions inside a project. 1,500-character limit per field. All plans, Web/Desktop/iOS/Android.
- **Memory (Saved Memories + Reference Chat History)** — Two-layer cross-chat memory: (1) Saved Memories — explicit notepad of facts ChatGPT chose or was asked to remember; (2) Reference Chat History — implicit recall of patterns and details from past conversations. New in 2026: Plus/Pro get automatic memory management (prioritize/deprioritize, version history, restore), and Memory Sources show which memories/chats/files informed a given response.

**Where context is set:** Two distinct locations:

1. **Per-Project instructions:** open the project, click the three-dot (⋯) menu in the upper right of the project, choose "Project settings" > enter instructions in the Custom Instructions field. Files added via the project's sources area / "Add source" button (or drag-drop) in the project header. [^cgpt1]
2. **Global Custom Instructions + Memory:** profile picture > Settings > Personalization > "Custom Instructions" (two text fields) and "Memory" section with toggles for "Reference saved memories" and "Reference chat history" plus a "Manage memories" panel. [^cgpt2][^cgpt3]

**Input types:**

- Free-form text instructions (Project Settings instructions + global Custom Instructions two fields, 1,500 chars each)
- File uploads: PDFs, Word, PPT, CSV/XLSX, code, plaintext, images (up to 20 MB), any common text-doc extension
- Pasted raw text (treated as a source)
- Pasted links from connected apps as project sources — Google Drive files/folders, Slack channels
- Saved chat responses — "Save to project" / "Add to project sources" from a message menu
- Connected apps (via tools menu `+`): Gmail (memory integration), Google Drive search, Slack, others in the ChatGPT app directory
- Memory entries — auto-captured by the model or manually added via "Remember that…" utterances

**Per-workspace vs global:** THREE explicit layers, explicitly hierarchical:

1. **Global Custom Instructions** — apply to every chat account-wide.
2. **Global Memory** (saved memories + reference chat history) — apply to every chat unless suppressed.
3. **Per-Project Instructions + Files + Project-scoped memory** — apply only inside that project.

Crucially: _Project instructions override global Custom Instructions while inside the project_ ("Project instructions only apply inside the respective project and will override your global custom instructions" — OpenAI Help). In Enterprise/Edu projects, global Custom Instructions are NOT available inside the project at all — only project instructions apply. Project-only memory mode further isolates a project; once a project is shared, project-only memory turns on automatically and can't be reverted.

**Distinctive features:**

- Per-project Custom Instructions overriding global instructions inside the project
- Per-project file/source library (PDFs, docs, sheets, images, pasted text, Slack channels, Drive files/folders)
- Project-only memory mode (isolates from cross-account saved memories and other chats); set at creation, can't be flipped
- Default memory mode (project can reference saved memories + other chats within the same project)
- Project sharing with Edit vs Chat roles; individual/group/workspace-link invites; shared projects force project-only memory
- Branched chats — fork to explore an alternative without disturbing the original; appears tagged "Branch"
- Move existing chat into a project; moved chats inherit instructions + file context
- Save a chat response back into project sources
- Project icon + color picker for sidebar identification
- Project Memory keeps continuity across all chats/files inside the project regardless of mode
- **Library** (April 2026 redesign): separate sidebar tab where every uploaded or generated file lives
- **Memory Sources** (May 2026): per-response panel showing which saved memories / past chats / instructions / library files / Gmail entries informed the response, with mark-relevant/not-relevant feedback and inline edit/delete
- Automatic memory management for Plus/Pro (May 2026): prioritize/deprioritize, search, sort, version history with restore
- Connected apps inside projects (Gmail, Drive, Slack) via tools menu `+`
- Standard tools available inside project chats: Canvas, image generation, Study mode, Voice mode, Web search, plus Deep Research and Agent mode on paid plans

**Limits:**

- Per-project file caps (May 2026): Free 5, Go/Plus 25 (Projects help — file-uploads FAQ still lists Plus at 20 during transition), Edu/Pro/Business/Enterprise 40
- Only 10 files can be uploaded simultaneously
- Global file constraints: 512 MB per file hard cap; 2M tokens per text/document file; CSV/spreadsheets ~50 MB; images 20 MB
- Rolling-rate cap: 80 file uploads per 3 hours (Free: 3 uploads/day)
- Storage: 25 GB per end-user, 100 GB per organization
- Custom Instructions: 1,500 chars per field (two fields)
- Saved Memories: no hard documented numeric cap; Plus/Pro see automatic memory management when "memory full" approaches; community measurements suggest ~1,200–1,400-word total budget
- Reference Chat History: "no storage limit" per OpenAI
- Shared-project collaborator caps: Pro 100 / 40 files; Plus/Go 10 / 25 files; Free 5 / 5 files; Business/Enterprise/Edu workspace projects 100 / 40 files

**Key UI patterns worth borrowing:**

- Sidebar: "New project" button at top of project list; project entries each with custom icon + color, expandable to show chats inside
- Project page header shows project name + icon at top with **three-dot (⋯) menu in upper-right** exposing "Project settings" (instructions), "Share", "Delete project" — the primary settings entry point
- **Project Settings dialog/panel** contains the Custom Instructions field for THIS project (single multi-line input with example placeholder)
- Project sources/files panel attached to the project (separate from per-message attachments) with "Add source" affordance for files, Drive links, Slack channels, saved chat responses
- Composer `+` tools menu (beside the input) exposes mode chips/affordances: photos, study tools, image creation, web search, Canvas — _action chips that pre-arm a mode before sending_
- Branched-chat affordance on existing messages; branches show as separate threads tagged "Branch"
- Share dialog with role chips (Edit / Chat) and "Anyone with a link" vs "Only those invited" radio + Copy link
- Personalization page (profile > Settings > Personalization) contains both Custom Instructions and Memory toggles + Manage memories
- **Memory Sources** inline panel attached to a response listing saved memories / past chats / custom instructions / files / Gmail entries used, each with thumbs-up/down and quick edit/delete
- "Remembering" and "personalizing" status pills shown inline — transient indicator that memory is being consulted
- New-project creation dialog with a Memory selector toggle (Default vs Project-only), chosen at creation, locked thereafter

**Citations:** [^cgpt1] [^cgpt2] [^cgpt3] [^cgpt4] [^cgpt5] [^cgpt6]

---

## Cross-app pattern table

| Feature                                   | Claude                                                                                                                                          | Gemini                                                                                                            | Perplexity                                                                                                                 | ChatGPT                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Workspace primitive**                   | Projects                                                                                                                                        | Gems (persona) + NotebookLM Notebooks (sources)                                                                   | Spaces                                                                                                                     | Projects (+ Custom GPTs)                                                                                       |
| **Global custom instructions**            | "Instructions for Claude" (Settings, account-wide, layered first)                                                                               | "Instructions for Gemini" (Settings > Personal Intelligence; NOT applied in Gems or Live)                         | **None** (Space-level only; no documented global field)                                                                    | Custom Instructions (two 1,500-char fields, account-wide; overridden inside Projects)                          |
| **Per-workspace instructions**            | Project Instructions panel inside project page                                                                                                  | Gem Instructions box in Gem editor                                                                                | Custom Instructions textarea in Space create/edit modal                                                                    | Project Settings > Custom Instructions (overrides global)                                                      |
| **File uploads (per-workspace)**          | Right-side knowledge panel, `+` add-content; PDF/DOCX/CSV/TXT/HTML/code/MD, 30 MB/file, unlimited count (200K token soft cap, RAG ~10x on paid) | NotebookLM Sources panel (left); 50 sources/notebook, 500k words or 200 MB each (Free) — plus Gem Knowledge files | Right-side Sources panel; 50 files/Space (Pro) or 500 (Enterprise); 25 MB/file (Pro) or 50 MB (Enterprise)                 | Project sources area; 5/25/40 files per project by tier; 512 MB/file hard cap, 20 MB images                    |
| **URL ingestion**                         | Pasted into knowledge base                                                                                                                      | NotebookLM URL paste (multi-URL); YouTube w/captions, >72h old                                                    | Add Links action in Space                                                                                                  | Drive folder/file links, Slack channel links as project sources                                                |
| **Memory (cross-chat)**                   | Memory at Settings > Memory (auto-synthesized; user-editable per-snippet)                                                                       | Saved Info + past-chat memory (Personal Intelligence)                                                             | **None** (no documented account-wide memory)                                                                               | Saved Memories + Reference Chat History; Memory Sources panel (May 2026); auto-management (Plus/Pro)           |
| **Per-workspace vs global stacking**      | Profile (global) → Project (per-WS) → Skills/Styles (on activation). Project layers ON TOP, doesn't replace global.                             | Global instructions explicitly NOT applied inside Gems/Live. Gems = isolated. Notebooks = isolated.               | Strongly per-Space; no global instructions to stack                                                                        | Three-tier: Global Custom Instructions → Global Memory → Project Instructions (override global inside project) |
| **Where context-editing UI lives**        | Inside the project page (right knowledge panel + instructions panel); global at user-avatar > Settings                                          | Gem editor (first-class flow); NotebookLM Sources panel (left); global buried in Settings > Personal Intelligence | Space creation modal up front + right-side Sources panel with "Add Instructions" just above; left-rail Spaces tab as entry | Project three-dot (⋯) menu > Project settings; global at profile > Settings > Personalization                  |
| **Mobile UI location**                    | Same patterns — projects in left sidebar, Settings > Memory accessible                                                                          | Menu > profile > Personal Intelligence > Instructions for Gemini                                                  | Spaces tab in mobile nav rail                                                                                              | Profile > Settings > Personalization on mobile; project ⋯ menu identical                                       |
| **Per-thread vs per-workspace overrides** | Per-thread attachments still possible inside a project                                                                                          | Notebook = thread-bound chat; Gem stays loaded across that Gem's chats                                            | Threads inherit Space; can move existing Thread into a Space manually                                                      | Per-message attachments distinct from project sources; move chat into project to inherit                       |
| **Sharing model**                         | Team/Enterprise: Can use / Can edit                                                                                                             | Notebooks: shared/published; Gems: private                                                                        | Private / link-view / Contributor / org (Enterprise)                                                                       | Edit vs Chat roles; individual/group/workspace; shared projects auto-flip to project-only memory               |
| **Default model per workspace**           | Inherited from chat picker                                                                                                                      | Optional Default tool per Gem                                                                                     | **Per-Space default model dropdown** (Sonar/Claude/GPT/DeepSeek)                                                           | Inherited from chat picker                                                                                     |
| **Citations panel**                       | N/A (RAG mode is implicit)                                                                                                                      | NotebookLM cites every answer to source passages; source cards = citation chips                                   | Cites uploaded files + live web in same response; file-level citations                                                     | Memory Sources panel (May 2026) shows what informed the response                                               |

---

## What this means for Sully

### 1. Where Sully's "Edit Sully's context" should live

**Current state:** buried as a footer item inside the model-picker popover.

**Synthesis across all four apps:** _Nobody hides context-editing inside the model picker._ The pattern is universal:

- **Claude:** dedicated instructions panel + right-side knowledge panel on the project page
- **Gemini:** Gem editor as a first-class creation flow; global instructions in Settings
- **Perplexity:** Space creation modal up front + right-side Sources panel with "Add Instructions" right above it
- **ChatGPT:** three-dot (⋯) menu on the project > Project Settings dialog; global in Settings > Personalization

**Recommendation:** Lift context-editing out of the model picker entirely. Sully should adopt one of two patterns:

- **Pattern A (workspace-light, recommended for current Sully):** Promote context to a dedicated entry point in the header or sidebar — a persistent header chip showing the active context name (e.g. "Sully knows about: LogueOS Captain"), click to open a sheet/drawer with the instructions field, files panel, and (eventually) URL list. Mirror Claude's "right-side knowledge panel" pattern in the drawer.
- **Pattern B (full workspace primitive):** If Sully ever introduces multiple workspaces/personas (e.g. one for ops, one for personal life, one for shopping), follow Perplexity's Space pattern: a single creation modal with Title + Description + Instructions + Default Model + Files stacked vertically; a left-rail entry for the active workspace; right-side persistent Sources panel.

**The model picker should pick models. Context editing should live where users look when they want to teach Sully something.**

### 2. What workspace input types Sully should add (priority order)

1. **Text instructions** — table stakes; already present, just relocate.
2. **File uploads** — universal across all four. Start with PDF, DOCX, TXT, MD, code files at minimum. Adopt Claude's "right-side knowledge panel" with a prominent `+` button so files are _always visible_, not hidden behind a button press.
3. **URL ingestion** — supported by Gemini (most aggressive), Perplexity (Add Links), and ChatGPT (Drive links). Useful for Sully because the operator routinely shares Linear tickets, GitHub PRs, and canon-doc URLs.
4. **Account-level Memory layer** — three of the four apps have this; the fourth (Perplexity) is conspicuously the odd one out. Sully already has tactical memory (`logueos_memory.db`) and operator MEMORY.md; surface this in the UI as a Settings > Memory list with individually editable/deletable snippets (Claude's pattern).
5. **Connected sources** — Gmail/Drive/Slack on ChatGPT, Drive/OneDrive/Dropbox on Perplexity. Lower priority for Sully (the operator's stack is Linear + GitHub + Notion + the LogueOS gateway), but the _pattern_ — connected-app toggles as a discrete reviewable list — is worth borrowing.

### 3. The "Notebooks" vs "Projects" vs "Spaces" mental model

Three distinct mental models exist in the wild:

- **Gemini NotebookLM Notebooks** — _source-grounded research workspace_. Every answer cites a source. Best for "I want to learn from this corpus."
- **Claude Projects / ChatGPT Projects** — _instruction-and-files persistent workspace_. The AI behaves a certain way and knows certain files. Best for "this is an ongoing project."
- **Perplexity Spaces** — _research-anchored workspace with per-Space model choice and Threads as the atomic unit_. Best for "I have multiple lines of inquiry within one domain."

**For Sully's actual use (LogueOS agent orchestration with a single operator):** the closest match is the **Claude/ChatGPT Projects** model. The operator is not running 50 research notebooks; the operator runs _one persistent companion_ (Sully) with a stable persona + a growing knowledge base of LogueOS canon, MEMORY.md, and active project context.

**Recommendation:** treat Sully itself as the workspace (singular). Per-thread context overrides are useful later, but the primary mental model should be:

- One Sully workspace
- Instructions: who Sully is, who the operator is, the LogueOS protocol summary
- Files: canon docs, MEMORY.md exports, active session handoffs
- Memory: cross-thread facts (the existing `logueos_memory.db` + auto-synthesized MEMORY.md, surfaced as an editable list)
- Threads: every chat session inherits all of the above

If Sully ever needs sub-workspaces (e.g. "ops Sully" vs "shopping Sully"), graduate to a Spaces-style model. Don't build for that now.

### 4. UI patterns to borrow (priority order)

1. **Right-side knowledge panel** (Claude + Perplexity) — files always visible, prominent `+` to add. Highest signal-to-noise pattern in the industry.
2. **Three-dot (⋯) menu on the workspace header** (ChatGPT) — clean entry point for "settings for this workspace" without polluting the composer or sidebar.
3. **Header chip showing active context name** (Perplexity's 2026 model-badge pattern, generalized) — answers "what does this AI know about me right now?" at a glance.
4. **Memory Sources inline panel** (ChatGPT, May 2026) — per-response, "this answer used: <saved memory X>, <file Y>, <past chat Z>" with mark-relevant feedback. High trust-building value for an operator who needs to debug Sully's behavior.
5. **Single creation modal** (Perplexity Spaces) — Title + Description + Instructions + Default Model + Files in one pass when initializing a new workspace/persona. Avoid multi-step onboarding.
6. **Connected-apps as a discrete reviewable list** (Gemini, ChatGPT) — privacy/control as a UI affordance. Important when Sully starts touching Linear, GitHub, gateway.
7. **NotebookLM-style "source card → citation chip" linkage** — when Sully cites a file, clicking the citation should scroll to/highlight the file. Useful when Sully gets file uploads.

---

## Recommendations for Sully (priority-ranked)

| #   | Change                                                                                                                               | Rationale                                                                                                                                                          | Effort | Priority |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------- |
| 1   | Move "Edit Sully's context" out of the model-picker footer                                                                           | Conflates model selection with context editing; all four flagship apps treat these as separate first-class surfaces. Discoverability hit + mental-model confusion. | Low    | **Now**  |
| 2   | Add a persistent header chip showing active context summary (e.g. "Sully knows: LogueOS Captain") that opens a context drawer on tap | Mirrors Claude's project-as-first-class-entry + Perplexity's 2026 model-badge pattern. Answers "what does this AI know about me right now?" at a glance.           | Low    | **Now**  |
| 3   | Build a context drawer/sheet with text-instructions field as the first input                                                         | Table-stakes — every app has this as a dedicated panel. The drawer becomes the home for everything in items 4-7.                                                   | Low    | **Now**  |
| 4   | Add file uploads to the context drawer (PDF/DOCX/TXT/MD/code minimum) with a Claude-style always-visible files panel + `+` button    | Universal across all four flagship apps. Operator routinely wants to drop canon docs / handoffs into Sully's context.                                              | Medium | **Next** |
| 5   | Add URL ingestion (paste link to add as a source) to the context drawer                                                              | Operator's day-to-day involves Linear tickets, GitHub PRs, canon URLs. Three of four flagships support this.                                                       | Medium | **Next** |
| 6   | Surface the existing memory layer (logueos_memory.db + MEMORY.md) as a Settings > Memory list with individually editable snippets    | Three of four flagships do this; it's the dominant pattern for trust + control. Memory already exists in the backend — this is purely UI surfacing.                | Medium | **Next** |
| 7   | Implement ChatGPT's "Memory Sources" inline panel on each reply (which memories/files/past-chats informed this answer)               | High trust-building value for an operator debugging Sully's behavior. Most novel 2026 pattern.                                                                     | High   | Later    |
| 8   | Connected-apps toggles as a discrete reviewable list (Linear, GitHub, gateway sources)                                               | Mirrors Gemini/ChatGPT privacy-as-affordance pattern. Becomes relevant once Sully's tool surface stabilizes.                                                       | High   | Later    |
| 9   | If Sully ever introduces multiple personas/workspaces, adopt Perplexity's single-modal Space creation pattern + left-rail Spaces tab | Don't pre-build this. Only graduate to Spaces if/when the operator demands multiple Sullies.                                                                       | High   | Later    |
| 10  | Adopt Gemini NotebookLM's source-card-as-citation-chip linkage once files are in                                                     | Adds RAG-style transparency. Lower priority because Sully is companion-first, research-second.                                                                     | High   | Later    |

---

## Source citations (consolidated)

### Claude (Anthropic)

[^cla1]: ["What are projects?" — Claude Help Center](https://support.claude.com/en/articles/9517075-what-are-projects). Official: projects are "self-contained workspaces with their own chat histories and knowledge bases"; free tier capped at 5; sharing permissions Can use / Can edit; RAG on paid expands capacity ~10x.

[^cla2]: ["How can I create and manage projects?" — Claude Help Center](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects). Official: project knowledge base is on the right side of the project's main page; click `+` to add content; uploads apply across all chats in that project.

[^cla3]: ["Understanding Claude's personalization features" — Claude Help Center](https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features). Official: layered model — profile Instructions for Claude (global, set via user initials > Settings) vs project instructions (per-project) vs Skills (on-demand).

[^cla4]: ["Agent Skills Overview" — Anthropic API docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview). Official: Skills architecture, progressive disclosure, per-surface scoping (claude.ai = per-user via Settings > Features zip upload; API = workspace-wide; Claude Code = filesystem).

[^cla5]: ["Collaborate with Claude on Projects" — Anthropic announcement](https://www.anthropic.com/news/projects). Official: 200K context window per project, custom instructions tailor responses, Team feed for shared snapshots.

[^cla6]: ["Free Claude users can now use memory and import context from rivals" — 9to5Mac](https://9to5mac.com/2026/03/02/free-claude-users-can-now-use-memory-and-import-context-from-rivals/). March 2026 rollout: memory enabled for all tiers including free; Settings > Memory shows individual editable snippets.

[^cla7]: ["Claude Features 2026: Projects, Artifacts, Memory, Computer Use, Skills, MCP" — Suprmind](https://suprmind.ai/hub/claude/features/). Aggregated 2026 feature inventory cross-referencing Projects, Skills, Memory, and Artifacts behavior.

### Gemini (Google)

[^gem1]: ["Tips for creating custom Gems" — Gemini Apps Help](https://support.google.com/gemini/answer/15235603?hl=en). Official Gems help: creation flow, persona/task/context/format fields, Knowledge uploader.

[^gem2]: ["Customize Gemini's responses with your instructions" — Gemini Apps Help](https://support.google.com/gemini/answer/16598625?hl=en). Official path to global custom instructions; confirms instructions do NOT apply in Gems or Live chats.

[^gem3]: ["Add or discover new sources for your notebook" — NotebookLM Help](https://support.google.com/notebooklm/answer/16215270?hl=en). Official source catalog: supported file types, 500k-word / 200MB / 50-source / 100k-token Sheets limits, Drive sync behavior, YouTube caption rule.

[^gem4]: ["NotebookLM adds Deep Research and support for more source types" — Google blog](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-deep-research-file-types/). Official announcement of Sheets / .docx / images / Drive-as-URL sources and Fast vs Deep Research.

[^gem5]: ["New ways to customize and interact with your content in NotebookLM" — Workspace Updates (March 2026)](https://workspaceupdates.googleblog.com/2026/03/new-ways-to-customize-and-interact-with-your-content-in-NotebookLM.html). 2026 update list: slide revisions, infographic styles, EPUB sources, PPTX export, saved chat history, persistent flashcards.

[^gem6]: ["What's new in NotebookLM: Video Overviews and an upgraded Studio" — Google blog](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-video-overviews-studio-upgrades/). Source for Studio four-tile redesign and Audio Overview interactive voice mode.

[^gem7]: ["NotebookLM in 2026: What Changed and What Matters" — Jeff Su](https://www.jeffsu.org/notebooklm-changed-completely-heres-what-matters-in-2026/). Independent 2026 walkthrough of the three-column layout and Studio tier ordering.

[^gem8]: ["Configure personalization and memory" — Gemini Enterprise docs](https://docs.cloud.google.com/gemini/enterprise/docs/configure-personalization). Documents the user-profile + custom-instructions + saved-memories + connected-data-sources personalization model on the Enterprise side.

### Perplexity

[^pplx1]: ["Introducing Internal Knowledge Search and Spaces" — Perplexity Blog (official launch post)](https://www.perplexity.ai/hub/blog/introducing-internal-knowledge-search-and-spaces). Canonical definition of a Space as a collaborative hub with custom instructions, file uploads, per-Space model selection, invite collaborators, and Enterprise training-opt-out by default.

[^pplx2]: ["A student's guide to using Perplexity Spaces" — Perplexity Blog (official walkthrough)](https://www.perplexity.ai/hub/blog/a-student-s-guide-to-using-perplexity-spaces). Confirms UI flow verbatim: left-rail "Spaces" menu > Add Sources on the right side of the screen > "Add Instructions" just above the sources panel.

[^pplx3]: ["How does file upload work" — Perplexity Help Center FAQ](https://www.perplexity.ai/hub/faq/how-does-file-upload-work). Authoritative source for file size + count limits and supported file types per tier. (Direct WebFetch returned 403 during research; referenced by multiple secondary sources and Perplexity's own pricing page.)

[^pplx4]: ["Perplexity Changelog — April 17, 2026 (Computer in Spaces)"](https://www.perplexity.ai/changelog/personal-computer-on-mac-launch-and-computer-updates---april-17-2026). Confirms current-as-of-2026 feature: Computer-in-Spaces gives every Space an evolving context layer with persisted docs/slides/sheets.

[^pplx5]: ["Perplexity AI Spaces: The Ultimate Guide for Teams (April 2026)" — perplexityaimagazine.com](https://perplexityaimagazine.com/perplexity-hub/perplexity-ai-spaces-guide-2026/). 2026 third-party review with the explicit Threads-vs-Spaces comparison table and the 50/500-file Pro vs Enterprise cap.

[^pplx6]: ["Perplexity Enterprise Pro: Complete Guide for Teams 2026" — godofprompt.ai](https://godofprompt.ai/blog/perplexity-enterprise-pro/). Confirms Enterprise org-level layer above Spaces: SSO, SCIM, role-based access, audit logging, unlimited teammate collaboration in private Spaces.

[^pplx7]: ["What are Threads" — Perplexity Help Center FAQ](https://www.perplexity.ai/hub/faq/what-are-threads). Official definition of Threads as the per-conversation unit, with Spaces as the parent organizing folder.

### ChatGPT (OpenAI)

[^cgpt1]: ["Projects in ChatGPT" — OpenAI Help Center](https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt). Canonical doc. Defines Projects, the three-dot > Project settings UI path for instructions, project-only vs default memory, plans-and-limits table (Free 5 / Go+Plus 25 / Edu+Pro+Business+Enterprise 40 files), shared projects with Edit/Chat roles, branched chats. Updated ~12 days before scrape (mid-May 2026).

[^cgpt2]: ["ChatGPT Custom Instructions" — OpenAI Help Center](https://help.openai.com/en/articles/8096356-chatgpt-custom-instructions). Defines the two global Custom Instructions fields, the 1,500-character per-field limit, the Settings > Personalization > Custom Instructions UI path, and the "Enable customization" toggle.

[^cgpt3]: ["Memory FAQ" — OpenAI Help Center](https://help.openai.com/en/articles/8590148-memory-faq). Authoritative on the two memory layers (Saved Memories + Reference Chat History), the Settings > Personalization > Memory UI path, the Manage memories panel, Memory Sources (May 2026), automatic memory management for Plus/Pro, and how Memory interacts with Custom Instructions and Projects.

[^cgpt4]: ["File Uploads FAQ" — OpenAI Help Center](https://help.openai.com/en/articles/8555545-file-uploads-faq). Source of the 512 MB / 2M tokens / 20 MB image / 50 MB CSV / 80-uploads-per-3-hours / 25 GB user / 100 GB org limits, plus the per-project caps (Plus 20, Pro/Team/Edu/Business 40).

[^cgpt5]: ["ChatGPT in 2026: Pricing, Models and Features That Actually Matter" — gend.co](https://www.gend.co/blog/chatgpt-2026-latest-features). 2026 third-party recap confirming the May-2026 Projects file-cap raise to 40, the Library redesign (April 2026), Memory Sources rollout, and project sharing on all consumer plans.

[^cgpt6]: ["ChatGPT Release Notes" — OpenAI Help Center](https://help.openai.com/en/articles/6825453-chatgpt-release-notes). Official rolling changelog. Cross-reference for dating Memory Sources (May 2026) and Library tab (April 2026) features.

---

## When to re-research

Re-do this research when any of the following triggers fire:

1. **Major workspace redesign at any of the four apps.** Specifically: Claude announces a successor to Projects, ChatGPT replaces Projects with a new primitive, Gemini collapses Gems and NotebookLM, or Perplexity restructures Spaces.
2. **A new flagship player emerges** with material chat-app share (e.g. xAI Grok, Mistral Le Chat, Meta AI, Apple Intelligence) that has a differentiated workspace model worth studying.
3. **Sully ships any of the changes in the recommendations table** — confirm the borrowed pattern still matches the source after implementation.
4. **Six months pass** without any of the above (i.e. by December 2026 at the latest) — flagship apps iterate fast and this doc will silently go stale.
5. **The operator explicitly asks for a refresh.** "What does ChatGPT do now?" is a valid prompt to revisit.

When refreshing, prioritize re-verifying the citation URLs above (links rot at OpenAI/Anthropic/Google support centers when articles get renumbered), the per-tier file caps (these change quarterly), and the UI screenshots/locations (settings menus get reorganized).
