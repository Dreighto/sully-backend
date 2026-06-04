# Sully — "Hand-off to CC" UI redesign (for GPT review)

**Date:** 2026-06-03 · **From:** the Captain (via CC) · **For:** GPT, to react to / push further
**Ask of you, GPT:** I'm redesigning one piece of my AI app's chat UI. Below is the current broken
state, three candidate designs (with phone mockups), my engineer's verdict, and open questions.
**Tell me which direction feels best to you, what you'd change, and take a swing at the open
questions at the bottom.** Plain language please — I'm not a developer.

---

## What Sully is (context)

Sully is a mobile chat app (dark theme, pink/fuchsia accent, iPhone). She's my AI companion.
When I ask her to do a _coding_ task, she hands it off to a background coding worker called
**CC** and reports back when it's done. The whole point: I should never have to think like a
developer. I just talk to Sully; she handles the machinery.

The machinery part is leaking through the UI and it looks broken. That's what I want to fix.

---

## The problem (what's on my screen right now)

This is a real screenshot, transcribed. I asked: _"@cc run the tests in the companion repo and
tell me how it went."_

```
┌──────────────────────────────────────┐
│  @cc run the tests in the       4:02 │
│  companion repo and tell me          │
│  how it went                   ─────▶│
│                                      │
│  ● LOGUEOS                           │
│  Sully sent this to CC on            │
│  companion. (Trace: sully-           │
│  1780527745617-5b69d371)             │
│  Copy   Regen   Play   👍       4:02 │
│                                      │
│  ╔════════════════════════════════╗  │  ← STUCK + LEAKING
│  ║ ● claude-code working · 39:53  ║  │
│  ║ synthesis_completed            ║  │
│  ║ {"outcome":"done","via":       ║  │
│  ║  "worker-result"}              ║  │
│  ╚════════════════════════════════╝  │
│                                      │
│  ● Sully                             │
│  I had CC run the tests in the       │
│  companion repo, and great news—     │
│  everything came back clean. All     │
│  167 tests passed across 33 test     │
│  files in less than two seconds…     │
└──────────────────────────────────────┘
```

The answer (Sully's bubble at the bottom) actually arrived and is great. But the middle is a mess.
**Three specific problems:**

- **P1 — Stuck timer.** The "claude-code working · 39:53" card keeps counting forever even though
  the job finished ages ago. It should stop the instant CC is actually done. (It's especially bad
  when I reload the app or scroll back through old chats — every finished job still says "working".)
- **P2 — Raw code leaking at me.** That `synthesis_completed {"outcome":"done",…}` line and the
  `Trace: sully-…` id are internal bookkeeping I should _never_ see. No JSON, no event names, no ids.
- **P3 — It's three disconnected blocks**, not one flow: a "sent to CC" notice → a stuck technical
  card → then the answer. I want it to read as **one seamless sequence**: _handed off → working
  (in friendly human words) → here's the result._

---

## Three candidate designs

My engineer generated three independent directions, then a separate critic ranked them. Here they
are with phone mockups so you can picture each. (Failure states included — CC sometimes crashes.)

---

### Direction A — "Collapse to the Result"

_While CC works, one quiet card with a human status line. The instant it finishes, the card
**disappears** and Sully's answer stands alone. On reload, finished jobs leave only a faint
"done by CC" caption under the answer._

**Working:**

```
┌────────────────────────────────────┐
│  ╭──────────────────────────────╮  │
│  │ ⠿  Running the tests…         │  │
│  │    (this might take a minute) │  │
│  ╰──────────────────────────────╯  │
└────────────────────────────────────┘
   • spinner, NOT a clock (no digits)
   • sub-line rotates: "Running the tests…"
     → "CC is checking each file…" → "Almost there…"
```

**Finished:**

```
┌────────────────────────────────────┐
│ ╭────────────────────────────────╮ │
│ │ I had CC run the tests — great │ │
│ │ news, everything came back     │ │
│ │ clean. All 167 tests passed…   │ │
│ ╰────────────────────────────────╯ │
│   done by CC · 4:06 PM  ✓          │
└────────────────────────────────────┘
   working card is GONE; just the answer
   + a faint "done by CC" whisper
```

**Failed:**

```
┌────────────────────────────────────┐
│  ╭──────────────────────────────╮  │
│  │ ✕  CC didn't finish           │  │
│  │    Something went wrong. Want │  │
│  │    me to try again?           │  │
│  │   ╔════════════════════╗      │  │
│  │   ║     Try Again      ║      │  │
│  │   ╰════════════════════╯      │  │
│  ╰──────────────────────────────╯  │
└────────────────────────────────────┘
```

**Trade-offs:** cleanest happy path, but most fragile. If Sully's answer is delayed or lands in
the wrong place, the card vanishes and you're left staring at _nothing_ — no card, no answer, no
error. Also throws away any record that CC was even involved, and loses "how long did it take".

---

### Direction B — "One Morphing Card"

_A single card lives between my message and Sully's reply, and **morphs in place** through three
states — handed off → working → done — so the whole task reads as one continuous thing._

**Working:**

```
╔══════════════════════════════════════╗
║  ● Sully sent this to CC             ║
║    Running the tests…        2:47 ●● ║
╚══════════════════════════════════════╝
   • fuchsia pulse (●●), human status line
   • elapsed time stops the moment it finishes
```

**Finished:**

```
╔══════════════════════════════════════╗
║  ✓ CC finished  ·  took 2 min        ║
╚══════════════════════════════════════╝
● Sully

I had CC run the tests — great news,
everything came back clean. All 167
tests passed in under two seconds…
```

\*The "✓ CC finished" strip sits flush above Sully's bubble — they read as ONE unit: task header

- explanation. "took 2 min" is a frozen past-tense label, never a live counter.\*

**Failed:**

```
╔══════════════════════════════════════╗
║  ✗ CC hit a snag  ·  after 4 min     ║
║                        [Try again →] ║
╚══════════════════════════════════════╝
● Sully
CC ran into a problem and stopped before
finishing. Nothing changed in the repo.
Tap "Try again" and I'll send it back.
```

_(amber border for trouble, vs fuchsia for success)_

**Trade-offs:** maps cleanly onto how the data actually works (one task = one card). Keeps a live
timer _during_ work though, which is a smaller version of the same P1 risk on reload. Discards the
detailed audit trail.

---

### Direction C — "Quiet Trace Chip"

_While CC works, a friendly live card. The moment it finishes it **collapses to a small chip** that
lives in history forever and **expands on tap** to show plain-English steps. Nothing technical
surfaces by default._

**Working:**

```
┌────────────────────────────────────┐
│  ╔══════════════════════════════╗  │
│  ║  ◉  CC is on it              ║  │
│  ║  Running the tests…          ║  │
│  ║  ──────────────────────────  ║  │
│  ║  About a minute in           ║  │
│  ╚══════════════════════════════╝  │
└────────────────────────────────────┘
   coarse time ("About a minute in"), no mm:ss
```

**Finished:**

```
┌────────────────────────────────────┐
│  ╭──────────────────────────────╮  │
│  │ ✓  CC handled this  ·  41s   │  │  ← calm chip
│  │             Tap to see steps ›│  │
│  ╰──────────────────────────────╯  │
│  ╭──────────────────────────────╮  │
│  │ Sully  4:43 PM                │  │
│  │ I had CC run the tests and    │  │
│  │ great news — everything came  │  │
│  │ back clean. 167 tests passed… │  │
│  ╰──────────────────────────────╯  │
└────────────────────────────────────┘
   "41s" is frozen — never counts up again
```

**Tap the chip → plain-English step log (bottom sheet):**

```
╔══════════════════════════════════╗
║  What CC did                 ✕   ║
║  ──────────────────────────────  ║
║  ✓  Picked up your request       ║
║     4:02 PM                      ║
║  ✓  Ran 167 tests across 33 files║
║     4:02 – 4:43 PM               ║
║  ✓  All passed · 1 minor note    ║
║  ──────────────────────────────  ║
║  Total time: 41 seconds          ║
╚══════════════════════════════════╝
```

**Failed:**

```
┌────────────────────────────────────┐
│  ╭──────────────────────────────╮  │
│  │ ✗  CC ran into a problem      │  │
│  │                    [ Retry › ]│  │
│  ╰──────────────────────────────╯  │
│  ● Sully: CC hit a snag and couldn't│
│    finish. Tap Retry above.         │
└────────────────────────────────────┘
```

**Trade-offs:** the most robust answer to the stuck-timer problem (a chip that stores the real
duration can _never_ count up), and the only one that keeps a tidy audit trail without clutter.
Costs the most to build (a chip + a live card + a bottom sheet = more moving parts).

---

## The verdict (my engineer's critic, in plain English)

| Rank     | Direction                  | Score | One-line read                                                           |
| -------- | -------------------------- | ----- | ----------------------------------------------------------------------- |
| 🥇 (tie) | **One Morphing Card**      | 8/10  | Best fit for how the app actually works; most honestly "one thing".     |
| 🥇 (tie) | **Quiet Trace Chip**       | 8/10  | Most bullet-proof against the stuck-timer bug; keeps a tidy record.     |
| 🥉       | **Collapse to the Result** | 6/10  | Prettiest happy-path, but breaks worst when the answer is slow/missing. |

**Recommended: a hybrid.** Use **One Morphing Card** as the backbone (one card per task, morphs in
place), but borrow the **Quiet Trace Chip's** discipline for the finished state:

1. **Working:** coarse, friendly time ("Started a moment ago" / "About a minute in"), a pulse, and a
   plain-English status line. _No ticking mm:ss clock_ (that's literally the bug today).
2. **Done:** the card freezes/shrinks to a compact "✓ CC handled this · took 2 min" strip flush
   above Sully's answer — with the duration calculated from the real start/end times so it's
   **identical on live, on reload, and on scrollback, and can never count up.** Keep an optional,
   off-by-default "tap to see steps" sheet (since I like being able to audit a trace) — but its
   steps are plain English, and the raw trace id only lives in there, on demand.
3. **Failed/stalled:** same card, amber for "taking longer than usual", red for "ran into a
   problem", one big Retry button. Sully writes the human sentence.

**Explicitly rejected:** fully removing the card on success (Direction A) — too easy to leave me
with a silent, blank screen if the answer is delayed.

---

## Technical reality check (so you know what's cheap vs. expensive)

(You don't need to act on these, GPT — just context for why the recommendation is shaped this way.)

- **The #1 fix, shared by all designs:** the finished/frozen state has to be drawn _on first load_
  from the server's record of the job, not after the app polls a second later. Today the card always
  starts as "working" and only corrects itself after a round-trip — that's the guaranteed "39:53"
  flash. The data to fix it already exists; it just isn't passed to the screen yet.
- **The raw-JSON leak (P2) is fixed on the server**, by only letting a short allow-list of
  human-friendly statuses reach the screen — not by trying to scrub the JSON in the UI.
- **Failure is slow to detect:** right now a crashed CC keeps showing "working" for up to ~15
  minutes before the system gives up. Any "this is taking longer than usual" message sooner than
  that is _new behavior we'd have to add_ (see Q1).
- Only the _one_ job that's actually in-flight should hold a live connection; old finished cards in
  history should be static (also part of why the timer gets stuck today).

---

## Open questions for you, GPT

1. **Soft-stall messaging.** A crashed CC currently shows "working" for ~15 min before failing.
   Should we add a _shorter_ "this is taking longer than usual" state (say after ~90s of silence)
   that does NOT yet say "failed" or offer Retry? What threshold and what wording feels right so the
   friendly status line isn't lying ("almost there!") on a dead worker?
2. **Retry safety on coding tasks.** A failed coding task might have _partly_ done its work (written
   files, made a commit). I can't inspect the repo. How should Sully word/guard "Try Again" so I'm
   not unknowingly doing something twice? Should some failures offer "Ask Sully what happened"
   instead of a blunt Retry?
3. **Coming back via a push notification.** For long tasks I leave and get a "CC is done" push. When
   I tap it and the app reopens, what's the ideal first thing I see — jump straight to the answer,
   or scroll to and briefly highlight the just-finished card, or both? How do we make "this is the
   thing your notification was about" obvious?
4. **The gap between "done" and the written answer.** If Sully's plain-English summary is a beat
   behind the "done" strip, what should the card say in that gap so I'm never left with a frozen
   "done" and no explanation? Is "CC finished — Sully's writing up what happened…" the right bridge?
5. **The audit trail.** The "tap to see steps" sheet is the one place a trace id / richer detail
   could live for the rare time I need to hand it to a developer. Should that sheet exist by default,
   hide behind a long-press or a "developer details" toggle, or should Sully just tell me the trace
   in chat when I ask? What keeps it invisible 99% of the time but findable in the 1% case?

---

_Generated from a 3-design parallel exploration + adversarial critique. Once you weigh in, I'll
finalize the direction and my engineer will build it (with the stuck-timer + raw-leak fixes first,
since those are the bugs hurting me today)._
