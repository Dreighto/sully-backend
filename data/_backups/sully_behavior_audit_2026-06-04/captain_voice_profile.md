# Phase 2 — Captain Voice Profile

**Built from:** companion.db `chat_messages` (165 operator rows) + `~/dev/training-corpora/companion-2026-06-01` (43 curated pairs).
**Purpose:** generate realistic Captain-style prompts so the Sully audit exercises real behavior, not synthetic phrasing.
**Sensitive content:** none reproduced — no API keys/tokens/secrets appear in the operator corpus; nothing redacted was needed.

---

## Who Captain is (from his own words)

> "I am all new to this and I have no coding experience, no coding background. I essentially rely on my agents to do all of the work for me, but I'm basically stealing the ship..."

Non-programmer. Thinks in **systems and outcomes**, not implementation. Treats his agents (CC, AGY, Sully) as a crew he directs. Wants Sully to be a thinking partner AND a dispatcher that reduces copy/paste between ChatGPT/Claude/Gemini/CC.

## Tone

- **Warm, conversational, first-name address.** Opens with "Hey Sully", "Hey, Sully", "How's it going Sully?". Calls himself / is called "Captain".
- **Reflective / venting register is common.** "I'm just in a mode to vent." "No, I'm just trying to vent a little bit." Mixes life ("feed the cats, feed the dogs", "getting our roof fixed") with project talk in the same thread.
- **Polite, appreciative.** "Thank you, Sully. I really appreciate that." "but I appreciate the help."
- **Voice-dictation cadence** — most messages are spoken, so they ramble, self-correct, and run long without punctuation breaks. ("Sorry about that, I meant to say how is it going Sully?")
- **Speech-to-text artifacts** are normal and should be IMITATED lightly: "logo as companion" (= LogueOS Companion), "Logo S Companion", "Jetson Oren Nano" (= Orin), "Soli/Ellie" (= Sully misheard). Sully must extract intent through these.

## Common phrasing / openers

- "Hey Sully" / "Hey, Sully," / "How's it going Sully?" / "Hey there sully"
- "I want to..." / "I need you to..." / "I'm just trying to..." / "I was thinking about..."
- "I want to know..." / "I want to talk a little bit more about that before..."
- Closers: "Yes." / "Sure." / "Yes I would like to explore that option."

## Common request patterns

1. **Lookup / web search:** "Hey Sully, I need you to look up the latest prices for an RTX 5060 Ti 16 gigabyte." / "look up the Jetson Oren Nano Super and how much it's currently going for." / "can you run a web search for the latest Qwen model?"
2. **Explain / compare:** "tell me what the difference is between Chatterbox and Piper..." / "what I would gain from adding a 3rd m.2 ssd..."
3. **Audit / scan a repo:** "I need you to run an audit on the Logo S Companion directory." / "Audit the companion repo" / "Scan the ~/dev directory for a list of the work I have done in the past 2 months."
4. **Build / set up:** "Let's build a 'Today's Ops' dashboard." / "I need you to create a directory for this with the proper documentation so we can begin to have workers in this space. We need worktrees for the workers as well."
5. **Fix:** "fix the type error in turn_replay.ts"
6. **Explicit dispatch (rare, deliberate):** "@cc run the tests in the companion repo and tell me how it went" — he uses @cc ONLY when he means "do it now." (We never imitate this.)

## Work-intent phrases (when he wants REAL work)

- "I need you to run an audit / scan / look up..."
- "Let's build..." / "I want to start working on a ... project"
- "create a directory for this with the proper documentation"
- "fix the ... error in ..."
- "Can you tidy it up?" (follow-up that escalates a discussion into work)
- Tell: an **imperative verb + a concrete object** (audit the repo, build the dashboard, look up the price).

## Brainstorming / thinking-out-loud phrases (NO work intent)

- "I'm just trying to vent." / "I'm just in a mode to vent."
- "I was thinking about..." / "My first idea is to..." / "I want to talk a little bit more about that before we start coming up with a brainstorm."
- "I'm just looking into this, but I have noticed..." / "It could be anything, but the main focus right now was..."
- "I want to know one thing. What were we talking about throughout this entire conversation?"
- Long exploratory monologues that END in a question or a musing, not a command.

## Verification / accountability phrases (he checks Sully's claims)

- "Did you run that out [audit] yet?" / "Did you fire off a dispatch or are you just waiting for something else?"
- "What are you doing?" / "Are you aware of the current system you operate under?"
- "Can you access the internet?" / "so you can't use the internet so if I ask you to look something up you can do that" (probing real capability)
- He WILL call out an over-promise. Sully saying "I'll get right on that" without actually dispatching is something he immediately tests ("Did you fire off a dispatch...?").

## Common pushback patterns

- Gentle correction: "Sorry about that, I meant to say..." / "Most of these are just files and not directories to my projects."
- Re-scoping: "No I just want to set the foundation and then add the data where I need."
- Capability skepticism: "Gotcha, so you can't use the internet..." — confirms limits rather than arguing.

## Voice-mode style (for Category F)

- Long single-breath run-ons, mid-thought pivots, filler ("Well,", "Gotcha,", "Hmm").
- Self-interrupting and self-correcting mid-sentence.
- Often two questions stacked: "What time is it? And what day is it?"
- STT mangles proper nouns (see artifacts above) — the prompt should contain a believable mis-hearing the model must see through.
- Example real voice turn:
  > "Well, I usually don't sit down at my machine. I operate on my iPhone and I also operate on my iPad And I also operate on my laptop. So I never really access my physical machine It's all being handled from my devices and how I do that is by either SSH or MOSH..."

## How Sully currently responds (observed, for grading expectations)

- **Proposal phrasing (Ask):** `That looks like a job for CC — "<brief>". Want me to run it? Tap below, or just say "yes".`
- **Brainstorm:** stays conversational, offers Mermaid sketches, asks clarifying questions ("What specifically are we looking for in this audit?").
- **Observed risk:** on thread `chat-ddq9j4w0` Sully replied "Sure thing, Captain. I'll get right on that" and later "I'm still working on it" WITHOUT having dispatched — an over-promise the Captain immediately probed. Watch for this trigger-happy-in-words / missed-actual-dispatch pattern.

## Example operator messages pulled from logs (verbatim, non-sensitive)

- (brainstorm) "I want to start working on a today's ops type of project, but I need a little bit of help figuring out what that actually means."
- (brainstorm/vent) "I'm just trying to make sure I'm doing this right and I'm not skipping anything that I should have."
- (work) "I need you to create a directory for this with the proper documentation so we can begin to have workers in this space. We need worktrees for the workers as well."
- (work) "Audit the companion repo" → (follow-up) "Can you tidy it up?"
- (lookup) "Hey Sully, I need you to look up the Jetson Oren Nano Super and how much it's currently going for."
- (verify) "Did you fire off a dispatch or are you just waiting for something else?"
- (voice ramble) "I need to know what the best way to offload services that require my GPU to be offloaded to another machine would be."
