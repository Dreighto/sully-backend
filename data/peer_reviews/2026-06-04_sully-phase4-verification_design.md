# Sully — Phase 4: Verification ("never tell me anything unconfirmed") — design for review

**Date:** 2026-06-04 · **From:** the Captain (via CC) · **For:** GPT, to pressure-test before we build
**Ask of you, GPT:** This is the design for making Sully _verify_ before she reports. Below is the goal, the current state, three candidate approaches, my engineer's adversarial verdict, the decisions I need to make, and open questions. **Tell me which approach you'd back, where the verdict is wrong, and take a swing at the open questions.** Plain language — I'm not a developer.

---

## What Phase 4 is (plain English)

Sully manages workers (CC, AGY) for me. Today, when a worker says _"done — tests pass, PR merged, app healthy,"_ Sully just **repeats that to me without checking it's true.** And separately, her chat reply can **contradict** the work — we literally saw her say _"I couldn't find the companion folder"_ while CC was successfully auditing that exact folder.

My goal, in one line: **she should never tell me anything she hasn't confirmed.** Two failures to kill:

- **(A) Blind trust** — she forwards a worker's claim without checking.
- **(B) Contradiction** — her own chat answer says something the work disproves.

---

## Current state (what already exists vs. what's missing)

- The **verification machinery is built but dead**: a `markVerified()` function exists with **zero callers**, the database columns for it are empty, and the task lifecycle even has a `done → verified → reported` path that nothing uses. So the skeleton is there; nothing runs it.
- **Good news for cost:** the box can already _prove_ things cheaply with no AI — it can ask GitHub if a PR really merged, check if a file exists, and curl a service to see if it's really up. (gh is logged in, the repos are on disk.)
- **The hard truth about the contradiction (B):** on Sully's _default_ path, her reply is **streamed to your phone word-by-word** and the dispatch decision happens _after_ it's already on screen. **You can't un-say something you already watched her say.** That makes (B) genuinely harder than it looks — more on this below.

---

## Three approaches we explored

### Approach 1 — Deterministic checks only (no extra AI)

Sully reads the worker's result, picks out the **checkable** claims (PR #N, a file path, "service up"), and **proves each one with a plain command** — ask GitHub, check the disk, curl the service. Anything not mechanically checkable is honestly flagged "couldn't confirm." **Zero AI cost, fast, can't itself hallucinate.** Weakness: it can only check things a one-liner can prove (it can't verify a vague "the app is healthy"), and its fix for the contradiction is just a soft instruction.

### Approach 2 — A cheap AI verifier

A small Haiku AI reads the result, decides what to check, runs read-only tools, and returns a verdict. **More flexible** for messy claims. But: it adds an AI call per task (**quota cost** on your fixed plan), and — critically — **an AI verifier can be wrong the same way the worker was wrong.** It could say _"I checked and confirmed it"_ when it didn't — which turns today's honest "CC says X" into Sully's own confident lie. That's _worse_ than where we are.

### Approach 3 — Make the worker "show its work" (a structured claims list)

Change what workers send back so each claim is a typed, checkable item, then verify each deterministically. **Cleanest long-term**, and it introduces the best honesty signal: a **"contradicted"** state where Sully actively warns _"CC said tests passed, but I'm seeing failures."_ Flaw: it asks the _same_ freeform AI worker to also emit the structured list — **an AI that hallucinates "tests pass" will just as happily hallucinate "{passed: 167}"** and make the lie look audited. Only the independent re-check actually verifies (and at that point you could've skipped the envelope).

---

## The verdict (my engineer's adversarial review)

| Rank | Approach                      | Score | One-line read                                                                                   |
| ---- | ----------------------------- | ----- | ----------------------------------------------------------------------------------------------- |
| 🥇   | **Deterministic checks only** | 8/10  | Quota-safe, can't hallucinate, slots cleanly into the real code. Weak contradiction fix.        |
| 🥈   | **Claims envelope**           | 5/10  | Best honesty signal ("contradicted"), but the worker self-reports the claims = false structure. |
| 🥉   | **AI verifier**               | 4/10  | Most flexible + best contradiction fix, but adds quota AND can lie with Sully's authority.      |

**Recommended: a hybrid** — and this is the important part:

1. **Verification = deterministic only.** Use plain commands to confirm/refute the cheap facts (PR merged? file exists? service 200?). **No AI in the verdict** — so the checker itself can never hallucinate a false "confirmed." (An AI is used _only_ to phrase the result in Sully's voice, never to decide if it's true.)
2. **Add the "contradicted" warning** (borrowed from Approach 3). When a check _actively disproves_ a worker's claim — GitHub says the PR isn't merged, the file isn't there — Sully **warns you** instead of forwarding the lie. _This is the real teeth of "never tell me anything unconfirmed."_
3. **Drop re-running the tests.** Re-running the suite can **disagree with the worker's own run** (the code changed since, flaky tests, it ran a subset) → Sully cries wolf on good work. And re-running the _companion's own_ 45-file suite from inside the live server risks bogging it down. Instead: **trust the worker's reported test result, verify the cheap facts around it.**
4. **The contradiction fix is split, and honest about its limit:**
   - On the **Sonnet/Opus path**, we _can_ hold Sully's reply back and open with _"On it — I'll report back"_ instead of a wrong claim. Clean fix.
   - On the **default path**, the reply already streamed — so the only _real_ fix is a **pipeline reorder** (decide whether it's work _before_ she starts talking). That's filed as the proper long-term fix; short-term we soften it with a prompt rule + a folder-exists correction.
5. **Three states only** (a non-coder needs few): **Confirmed** / **Couldn't double-check** / **⚠ Heads up — this looks wrong.**

---

## What you'd actually see (Sully's voice)

- **Confirmed:** _"I had CC run the tests — green — and I confirmed the PR is merged on GitHub. You're good."_
- **Couldn't double-check:** _"CC says everything's done. I couldn't independently confirm that part on my end, so worth a glance if it matters."_
- **⚠ Heads up:** _"CC said the PR was merged, but I checked and GitHub still shows it open — you may want to look at this one."_

---

## The hard truths GPT should weigh (the critique's best catches)

- **A verifier that can be wrong is worse than no verifier** — it launders a guess into a confident confirmation _with Sully's name on it._ This is the strongest argument for deterministic-only.
- **You can't un-stream a reply.** On the default path the contradiction can't be fixed after the fact — it needs the reorder.
- **Re-running tests can disagree with the worker** → false alarms. Trust the reported result; verify around it.
- **"Confirmed" must not be silent** — if a clean check shows _no_ badge AND "I couldn't check" also shows little, then absence-of-flag dangerously means _both_ "verified" and "not checked." The states have to be unambiguous.
- **A flaky verifier poisons future training** — if we mislabel a result "confirmed," that wrong label feeds Sully's next fine-tune. So only a _deterministic_ confirm counts as a training-positive.

---

## Decisions I need to make (my leanings in **bold**)

1. **When she can't confirm:** report it but **flag it honestly** (never withhold a real result). — _leaning yes; this was the question I bumped to this doc._
2. **Deterministic-only, or allow an AI verifier?** — **leaning deterministic-only** (no quota, can't lie). Accept that vague prose claims just get an honest hedge.
3. **Re-run tests, or trust the worker's reported result?** — **leaning trust + verify the cheap facts** (avoid false alarms).
4. **"Confirmed" badge visible, or silent on the happy path?** — leaning **visible**, so absence-of-flag isn't ambiguous.
5. **The default-path contradiction:** accept that the _real_ fix is the pipeline reorder (decide-before-she-talks), done as its own step? — leaning **yes**.

---

## Open questions for you, GPT

1. On the default path Sully's reply **streams to my phone before she decides to dispatch**, so she can say a wrong thing I watch appear. Is the right fix to **reorder** — decide "is this work?" _before_ the first word streams, so a work turn opens with "On it, handing to CC"? What's the latency cost of making the first word wait on that decision?
2. Deterministic checks can only prove what a one-liner can prove — they **can't** verify the most common real result ("fixed the stuck timer," "app healthy," "16 commits behind"). For those Sully falls back to "CC says X, couldn't double-check." Is **honest-hedge-on-the-majority** acceptable, or does "never tell me anything unconfirmed" actually _require_ an AI verifier for prose claims (accepting it can be wrong + costs quota)?
3. Re-running the test suite can **diverge** from the worker's run and make Sully cry wolf. Given the worker already reports its result, is re-running worth the false-alarm risk, or trust-the-report + verify PR/files/service only?
4. Do you agree the verifier **must be deterministic-only** (no AI in the verdict), reserving AI strictly for phrasing — never for deciding if something's true?
5. I'm on a **fixed** Claude Max plan I'm already rationing for the product. Is **any** per-task extra AI call acceptable for verification, or is **zero-extra-AI a hard line**?
6. For me as a non-coder: should the **loud** signal be the positive ("I confirmed it") or the negative ("⚠ this looks wrong")? Which do I actually need shouted?

---

_Generated from a 3-approach parallel exploration + adversarial critique (which independently re-verified the code: the dead `markVerified`, the can't-un-stream streaming order, gh authed, the self-referential test hazard). Once you weigh in, I'll lock the design and my engineer will build it — deterministic verification + the "heads up" warning first, the pipeline reorder as its own step._

---

---

# ✅ UPDATE (2026-06-04) — adopting the Captain's "Go / No-Go poll" idea

**The Captain proposed reframing verification as an Apollo mission-control GO / NO-GO poll.** We explored it (architect + adversary + engineer). **Verdict: it's genuinely a better model than a generic "verification pass" — adopt it — with two non-negotiable hardening rules.** This section supersedes the "recommended hybrid" above; everything else (deterministic-only, never-block, the contradiction caveat) still holds and is _strengthened_ by this.

## The idea, in one line

Before Sully states a worker's claim as fact, a **poll** runs — each evidence channel votes **GO** (proved true), **NO-GO** (proved false), or **UNKNOWN** (no evidence to check). **A fact requires GO. Unknowns stay unknown. A NO-GO surfaces a warning.** Most of the time the Captain just sees "✓ Verified"; the full matrix lives in the forensic journal.

## How the crux is solved (the make-or-break)

The hard problem was: _how does the system know which channel backs a freeform claim like "tests passed," without an AI reading the prose?_ **Answer — your Apollo instinct taken literally: "show me the telemetry."**

The worker stops handing back a _conclusion_ and instead deposits a typed **evidence envelope** of _pointers_ — a git SHA, a PR number, a file path, a service URL, a test exit code — in its completion callback:

```json
{
	"result_ref": "All 167 tests passed",
	"evidence": {
		"fs_paths": ["src/…"],
		"git_ref": "a3f9c12",
		"pr_number": 5,
		"repo": "LogueOS-Companion",
		"health_url": "http://127.0.0.1:18769/companion/chat",
		"test_exit_code": 0
	}
}
```

A channel **only votes if its pointer is present** — and Sully **re-derives the truth herself** from that pointer (asks GitHub about PR #5, runs `git cat-file` on the SHA, `fs.exists` on the path, `curl`s the URL). No AI anywhere in the verdict. A claim of "tests passed" with **no** test pointer → that channel is UNKNOWN → **she cannot state it as fact.** This _inverts_ the trust model: the worker must leave proof, not just assert.

## Two non-negotiable hardening rules (the adversary's core findings)

The model is only real verification — not "trust with extra steps" — if we hold these:

1. **A channel may say GO only when the box re-derived truth from a pointer the worker cannot also fake as the answer.** A git SHA, a PR number, a file path, a live URL all pass this — the box independently resolves them. **A bare `test_exit_code: 0` does NOT** — it's just an integer the worker types; a worker that lies "tests passed" will type `0` just as easily. So: the **test channel can't buy the silent "confirmed" posture** off a typed integer. We either (a) capture the real exit code _out-of-band_ (the dispatch listener runs/wraps the test command and records the OS exit code where the worker can't write it), or (b) parse a real test-report artifact (and require `tests > 0`, to catch "ran nothing, exited 0"), or (c) leave tests at **hedge** ("CC says tests passed; I don't have a receipt"). **For v1 we defer the test channel and let test claims honestly hedge.**
2. **Evidence is bound to _this_ task's frame — captured by the infrastructure, not the worker.** A `{target_repo, branch, dispatch-start-time}` frame is stamped at dispatch. A GO requires the pointer to resolve _inside that frame_ (SHA newer than start + in the right repo; file under the repo root with mtime after start; PR in the right repo). Otherwise you get a **false GO against the wrong object** — "PR #5 merged" confirmed against a _stale_ PR #5 from last week.

## The big unlock (worth its own line)

**The infrastructure can auto-fill most pointers itself.** The dispatch listener already knows the repo + start time — after the worker exits it can capture the new git SHA, the changed files, and the CI state _without the worker's cooperation_. That (a) makes those channels re-derived-by-default (immune to a lying worker) and (b) kills "UNKNOWN-fatigue" (see below). The worker's envelope becomes _enrichment_, not the sole source.

## Honest limits (so we don't oversell it)

- **"All GO" ≠ "it works."** Existence/health checks prove _"no detectable contradiction,"_ not _"the change is correct / did what you wanted."_ A service can return 200 while the new behavior is broken. So an all-green poll must **never** read to you as "everything's good" — Sully leads with what she _couldn't_ check, not just what she could.
- **UNKNOWN-fatigue is the likeliest early failure.** If workers don't leave pointers, everything hedges, and you learn to ignore the hedge — then miss the rare real warning. Mitigations: infra auto-fills pointers (above); UNKNOWN shows as a _quiet, distinct_ mark (not a paragraph); reserve prose for the loud NO-GO warning; track "% of claims with receipts" climbing over time.
- **This does NOT fix the chat contradiction (B).** The poll runs at _completion_; the "couldn't find the folder" bug happens at _chat/dispatch_ time, before any worker finishes — and on the default path her reply already streamed. That stays a separate fix (the **pipeline reorder** — decide "is this work?" before she speaks). The poll is the completion-time version of your own standing rule _"check before asserting"_; B is the chat-time version, still open.

## What you'd see (unchanged — three postures, deterministic now)

✓ **Confirmed** (silent) · _"couldn't double-check that part"_ (hedge) · ⚠ **"Heads up — this looks wrong"** (a check actively refuted the claim).

## Minimal v1 (one focused build)

- **Channels:** the two free ones (worker-finished, task-state — read from existing records) **+ Git-SHA + PR/CI + File-exists + Service-up** — all _pointer-resolved_ (real verification, no AI, ~no quota).
- **Defer:** the **test channel** (weak until we capture the exit code out-of-band) and the **database channel**.
- **Reuses the dead scaffolding:** `markVerified()` finally gets its first caller; one new column (`verification_evidence`) holds the matrix for the journal/training signal.
- **Carried over from above:** deterministic-only, never-block-a-result, the 3 postures, and (B) handled separately.

## Refined questions for GPT

1. **The test channel is the one that matters most and is hardest to make real** (a worker-typed exit code isn't proof). Is it worth wiring the **dispatch listener to capture the true exit code out-of-band** (so "tests passed" can be a real GO), or is honest _hedging_ on tests acceptable for now?
2. Should the infrastructure **auto-capture pointers** (git SHA, changed files, CI state) so verification doesn't depend on workers remembering to leave receipts — and is that the right place to invest first?
3. Given "all-GO ≠ it works," how hard should Sully lean on **what she couldn't verify** vs. what she could, so an all-green poll doesn't lull you into "it's done"?
4. Is **three states** (confirmed / hedge / ⚠warn) the right vocabulary for you, or do you want the matrix surfaced more often than "only when you ask"?
5. Do you agree the **evidence-envelope + per-channel GO/NO-GO + posture-driven wording** is the substance, and "Apollo poll" is the mnemonic — i.e. we're building exactly your idea, just naming the parts?

_Verdict from the exploration: **adopt Go/No-Go.** It's better than a generic pass specifically because UNKNOWN becomes a loud first-class state, each channel is individually attributable, and the output is a *posture for Sully* (how to talk to you) rather than a number — provided we keep the two hardening rules. Build order: schema column → the pure poll engine (TDD) → wire completion → posture-driven wording → worker-prompt evidence spec → journal/replay surface._
