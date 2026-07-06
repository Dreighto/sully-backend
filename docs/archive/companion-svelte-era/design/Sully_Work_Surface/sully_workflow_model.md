# Behavioral Specification: Sully Operating System & Work Surface

This document establishes the behavioral specification and architectural model for the **Sully Operating System** and its user interface component, the **Work Surface**.

The Work Surface UI prototype is designed to support and visualize this model. This model serves as the source of truth for the system's runtime execution, lifecycle triggers, and operator safety protocols.

---

## 1. Purpose

### What Sully Is

Sully is a **cognitive operating system surface** that acts as a collaborative bridge between a human operator and a network of specialized worker agents. It coordinates task execution, routes payloads between agents, verifies outputs against safety/correctness frameworks, and translates complex engineering pipelines into simple, real-time visual progress updates.

### What Sully Is Not

- **Sully is not a mascot character.** It is an operating system utility, not a decorative chatbot.
- **Sully is not a black-box autonomous executor.** It never runs destructive or high-risk tasks invisibly without human-in-the-loop validation.
- **Sully is not a raw log dump.** It is designed to abstract away terminal outputs in primary views, presenting clean, actionable updates to the operator.
- **Sully is not vendor-locked.** The underlying worker engines can be swapped without altering the user-facing operating model.

---

## 2. Sully Responsibilities

The Sully operating system is responsible for orchestrating the lifecycle of every request:

1. **Understand Requests**: Parse user intent, establish the target workspace, and flag potential safety hazards or destructive actions.
2. **Create Plans**: Formulate a structured route through standard execution phases.
3. **Assemble Teams**: Determine which worker roles are required for the task, assigning specialized agents dynamically.
4. **Track Work**: Monitor active agent status, capture progress events, and update the Work Surface in real time.
5. **Verify Outcomes**: Run automated tests, linters, and verification suites to calculate confidence levels.
6. **Present Results**: Synthesize worker logs into plain-English summaries and present clean, verified deliverables.

---

## 3. Worker Model

Workers are categorized into **Roles** (stable architectural interfaces) and **Worker Identities** (swappable model/agent implementations).

```
   [ Role Interface ]  ──────────>  [ Worker Identity (Implementation) ]
      Research                       Claude Code, Perplexity Ask
      Build                          Antigravity, Local Git, Shell Runner
      Review                         Codex, Vitest Sandbox, ESLint
      Memory                         Notion, Pinecone Vector DB, Local Context Index
```

### Core Worker Roles

- **Research**: Auditing, code comprehension, searching indices, and gathering domain specifications.
- **Build**: Code generation, file editing, structural creation, and deployment.
- **Review**: Linting, running test suites, validation checks, and safety scans.
- **Memory**: Fetching context logs, retrieving vector embeddings, and indexing task history.
- **Vision**: Simulating UI snapshots, screenshot comparisons, and layout verification.
- **Voice**: Speech synthesis, transcription, and acoustic input processing.

---

## 4. Work Surface Philosophy

The Work Surface is built on four core guidelines:

1. **Show the Work**: Visualize the active state of worker agents. If a worker is running, show it; if a worker is idle, make it secondary.
2. **Show Where Work is Going**: Clearly illustrate payload routing (e.g. using animated packet motion between worker nodes and the core task).
3. **Show What Happens Next**: Answer the operator's forward-looking questions at a glance (e.g. next steps, pending approvals).
4. **Hide Unnecessary Implementation Details**: Shield the operator from cognitive overload. Do not display detailed debug logs, vendor details, or terminal output in the default compact view.

---

## 5. Standard Workflow

Every task follows a predictable 6-stage linear pipeline:

$$\text{Read} \longrightarrow \text{Research} \longrightarrow \text{Build} \longrightarrow \text{Check} \longrightarrow \text{Approve} \longrightarrow \text{Reply}$$

1. **Read**: Sully parses the user request, extracts intent, and maps files.
2. **Research**: Workers gather context, search repositories, and fetch history.
3. **Build**: Workers execute changes, write code, or construct assets.
4. **Check**: Workers run verification checks (compilation tests, test suites, linters).
5. **Approve**: The system pauses for human operator confirmation on critical tasks.
6. **Reply**: Sully presents the final verified result to the user.

---

## 6. Task States

At any point, a task resides in one of the following states:

- **Reading**: Parsing intent, checking permissions, mapping target files.
- **Planning**: Setting up workspace environments, launching initial roles.
- **Working**: Build and Research agents are actively running tools.
- **Reviewing**: Review agents are running automated test suites or linters.
- **Waiting**: Task is blocked, waiting for operator input or approval.
- **Delivering**: Generating final response artifacts, closing sandbox environments.
- **Complete**: Task is finished; deliverables are verified and ready.
- **Stopped**: Halted by user command. No processes are running.

---

## 7. Mobile Interaction Rules

To avoid dashboards being shrunken down to mobile screens, the Work Surface is designed mobile-first with three distinct UI footprints:

### I. Collapsed State (Pill)

- **Goal**: Provide low-profile ambient status monitoring.
- **Structure**: A single-line status bar capsule (e.g. `● Sully working · Researching`).
- **Visuals**: Slow pulsing indicator dot reflecting current status color.

### II. Compact State (Card)

- **Goal**: Answer key questions in under two seconds in chat streams.
- **Visual Hierarchy**:
  1. _What is Sully doing now?_ (Prominent header action text).
  2. _How close are we to a reply?_ (Horizontal visual progress timeline: `Read → Research → ...`).
  3. _What is Sully waiting on / What happens next?_ (Contextual status banners).
  4. _Graph Motion_: Subtle dynamic node graph with dimmed node labels showing routing paths.
- **Controls**: Renders actions (Approve / Stop Task) **only** when in the `Waiting` state to minimize height overhead during active execution.

### III. Expanded State (Diagnostics)

- **Goal**: Provide deep pipeline visibility and audit controls.
- **Content**:
  - Full-size node graph showing all active roles.
  - Vertical route checklist with phase times and checkmarks.
  - Active worker registry (showing both **Role** and **Worker Identity** details, e.g. `AGY (Antigravity Agent) · Executing`).
  - Automated test reports, proof scores, and console feedback.
  - Diagnostics action buttons (`Stop Task`, `View Result`, `Start Over`).

---

## 8. Approval & Safety Rules

Human agency is the absolute guardrail of the Sully OS:

### I. Double-Confirmation for Destructive Actions

Any action flagged as destructive (e.g. file deletions, force pushes, production deployment writes) requires a **two-step confirmation flow**:

1. First Tap: Clicking **Approve** changes the button style to warning red/amber and updates label text to a specific confirmation request (e.g., `Confirm deletion?`).
2. Second Tap: Clicking the hazard button executes the action.
3. _Vague approval prompts (e.g. "Yes", "OK") are strictly prohibited for destructive actions._

### II. Running Task Cancellation Safety

Tapping **Stop Task** on an actively running workspace (e.g. while agents are compiling code or executing migrations) triggers an inline warning: `Confirm stopping active task?`. This prevents accidental pipeline corruption.

### III. Unambiguous Block Reasons

The Work Surface must **never hide why it is blocked**. If the task is waiting on the operator, the banner must display the specific block reason (e.g., `Waiting for your approval to delete production backups`).

---

## 9. Worker Visibility Rules

To prevent cognitive overload while maintaining diagnostic transparency, worker details are exposed progressively:

| View              | Worker Label                 | Registry Detail                            | Visibility Rule                                            |
| :---------------- | :--------------------------- | :----------------------------------------- | :--------------------------------------------------------- |
| **Compact Card**  | Dimmed short codes (CC, AGY) | None                                       | Hides vendor identities, keeping focus on operator phases. |
| **Expanded Card** | Clear short codes            | Role + Identity (e.g. `AGY (Antigravity)`) | Exposes specialized vendor info for engineering audits.    |

---

## 10. Future Expansion

- **Stable Roles, Fluid Vendors**: As the ecosystem evolves, new worker models (e.g. OpenAI GPT-x, Claude x.x) can be integrated as implementations of the `Build` or `Research` roles. The UI coordinates and graph structures remain unchanged.
- **Dynamic Symmetrical Graphing**: The SVG graphing engine must compute coordinates programmatically based on the count of active workers (1, 2, 3, or 4), ensuring layouts look balanced and intentional regardless of team size.
