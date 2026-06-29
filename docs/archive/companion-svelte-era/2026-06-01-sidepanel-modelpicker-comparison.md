# Sully vs flagship AI apps — side panel + model picker comparison

**Date:** 2026-06-01
**Source:** `docs/design/ref_material/` — operator-captured iPhone screenshots of Claude, Gemini, Perplexity, ChatGPT, and Sully (current state) side panels and model pickers.

This is a synthesis doc, not a proposal. The job here is to read each comp honestly, name what Sully is doing well, and surface the specific patterns worth borrowing.

---

## Model picker comparison

| App                 | Pattern                      | List length                                              | Trigger                   |
| ------------------- | ---------------------------- | -------------------------------------------------------- | ------------------------- |
| Claude              | Bottom sheet, ~65% of screen | 3 primary + "Effort" sub-menu + "More models" disclosure | top-bar tap on model name |
| Gemini              | Anchored popover top-left    | 3 models + "Thinking level" sub-menu                     | top-left menu tap         |
| Perplexity          | Bottom sheet, ~75% of screen | 8 models, brand icons, "max" badge on Pro tiers          | model-name chip at top    |
| ChatGPT             | Tiny popover top-left        | 2 modes ("Instant" / "Thinking") + "Configure"           | top-bar tap               |
| **Sully (current)** | Anchored popover top-right   | 9 models with sublabels + "Edit Sully's context" footer  | model chip top-right      |

**Captain's observation holds:** Claude and Perplexity use bottom sheets because they have meaningful options. Sully has 9 models (closer to Perplexity's 8 than to ChatGPT's 2) — and the anchored dropdown is fighting that volume. **Bottom sheet wins for Sully on mobile.**

### What a Sully bottom sheet would unlock

- Drag-to-dismiss instead of "find the X" — the iOS-native affordance
- Frees the chip to be smaller / less prominent in the header chrome (which fixes operator note: "the picker button could use some work" partially)
- Vertical space stops competing with the chat — picker can be 60–70% of screen height with breathing room per row
- Standard pattern users already understand from every other AI app

### What to keep from Sully's current picker

- The current-model **callout** at top (Perplexity does this same elevated treatment for the active model) — looks correct and informative
- The **"Edit Sully's context"** footer with the subtitle we just added — none of the comps offer per-workspace context editing this directly, that's a Sully differentiator
- The **tier emoji per row** + sublabel pattern — gives more semantic info than Perplexity's brand-icon-only rows
- **brand-pink Auto highlight** — clean

### What Perplexity does that we should borrow

- **"max" badge** for premium tiers — a small teal pill next to Claude Opus 4.8 + GPT-5.5. Tells the user "this is the heavy/expensive option" at a glance. Cleaner than relying on the sublabel alone. Could map to Sully's "deep" / "big reasoning" tier sublabels as inline badges.
- **Brand icons** next to model names — Sonar 2, GPT-5.4, Gemini 3.1 Pro all have their parent brand mark. Right now Sully uses the tier emoji (`🪶`, `🤖`) — which is _tier_ not _provider_. A small provider mark + the tier emoji together would be richer.

### What Claude does that we should borrow

- **"Effort" as a separate sub-menu row** — High / Medium / Low for reasoning effort. Sully's tiers (chat / planning / deep) overlap with this idea but it's baked into the model name. A separate effort dial would let the operator pick Sonnet + Deep, which the current picker doesn't expose cleanly.

### What NOT to borrow

- ChatGPT's 2-mode abstraction — Sully's value is the operator picking specific models. Hiding that behind "Instant/Thinking" would erase the differentiator.
- Gemini's tiny popover — same problem as Sully today: cramped for a long list.

---

## Side panel comparison

| App                 | Top section                              | Grouping                                                                                   | Bottom                                                 | Empty action                                       |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------- |
| Gemini              | Wordmark + X                             | New chat (pill), Search, Daily brief, Images, Videos, Library                              | Account chip with name/tier + settings                 | New chat row at top                                |
| Perplexity          | Settings + username + expand             | Spaces, Artifacts, Connectors → History with filter chips                                  | Search bar + floating teal "+ New"                     | "+ New" floating pill                              |
| ChatGPT             | Wordmark + search + profile              | Projects/Images/Codex/More → Pinned → Recents                                              | (none specific)                                        | Floating purple "Chat / +" pills                   |
| Claude              | Wordmark + profile + close               | Project pills (NAS, Miru) → Recents → "All chats"                                          | (none specific)                                        | Floating white "+ New chat" pill                   |
| **Sully (current)** | Sully mark + wordmark + explore icon + X | "SHOW ARCHIVED" / "CLEAR ALL" toolbar → The Den (highlighted pink card) → flat thread list | `CORE: Sully` / `HOST: 127.0.0.1:18080` devtool footer | (none — operator hits + only in the chat composer) |

### What Sully does well

- **The Den as a pink-highlighted hero row** with count badge is genuinely premium — none of the comps treat their "home" space as visually distinct. This is Sully's identity moment in the sidebar; keep it.
- **Glass-coherent chrome** after this evening's polish — the toolbar, the popover, the row hover all use the same white-alpha tokens. Comparable to Claude's premium sparseness.
- **The Sully wordmark + mark** at top now matches the chat-header sizing (this evening's parity fix).

### Issues Sully's sidebar has that the comps don't

1. **Thread rows show raw IDs** — `chat-s17rnxwp`, `chat-r78kunin`, `chat-n72y4df0`, `chat-frglr` are not human-readable names. Every other comp shows the chat's first-message snippet (Perplexity: "I am considering having Hermes 3 as the student model…", Claude: "Companion app architecture and…"). Sully has the data (the first operator message) — the renderer is just showing the slug instead. **Highest-leverage fix in the sidebar.**

2. **No primary nav above the thread list** — Gemini has 6 nav rows (New chat, Search, Daily brief, Images, Videos, Library); ChatGPT has 4 (Projects, Images, Codex, More). Sully jumps from the wordmark straight into archive controls and the thread list. The toolbar at the top (`SHOW ARCHIVED` / `CLEAR ALL`) is _management chrome_, not nav — those belong in a kebab menu, not the top of the sidebar.

3. **No "+ New chat" CTA** — every comp has a prominent new-chat action. Sully relies on the operator going to the empty thread state via tapping the Sully mark/home. Should be explicit.

4. **"CORE: Sully / HOST: 127.0.0.1:18080" devtool footer** — operator's own 2026-06-01 audit doc flagged this as devtool chrome on a premium surface and it's still there. Replace with operator identity chip (matches Gemini's "Andrew Garcia / Pro" footer or Claude's profile letter).

5. **No section grouping** — flat thread list with The Den at the top. Could group as **"The Den"** (already there, hero card) → **"Pinned"** (operator can pin threads) → **"Recents"** (chronological). Matches the ChatGPT/Claude pattern.

6. **No relative timestamps on thread rows** — Perplexity shows "9 hr. ago", "1 day ago", "2 days ago"; the others imply ordering by recency. Sully shows message count which is useful for "this is a big conversation" but doesn't help with "this is the one I had this afternoon."

7. **No search** — Perplexity and ChatGPT both expose search. With 26 messages on The Den + 10+ other threads visible, search becomes useful.

### Patterns ranked by impact-for-effort

| #   | Change                                                                          | Effort                                                                     | Visible impact               | Notes                                                                              |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| 1   | **Human-readable thread titles** instead of `chat-xxxxx` IDs                    | Low — server side already has first-message text; renderer needs to use it | High                         | Auto-title from first operator message, fall back to ID only if no messages yet    |
| 2   | **Bottom-sheet model picker on mobile** (keep anchored dropdown on `lg:`)       | Medium — new component, transition swap, keyboard-open guard               | High                         | Operator already flagged this directly                                             |
| 3   | **Replace `CORE/HOST` footer with operator identity chip**                      | Low                                                                        | Medium — premium signal      | Could just be the operator name + tier ("Captain — Local + Cloud")                 |
| 4   | **Move toolbar to a kebab menu** + add **"+ New chat"** as a primary top action | Low                                                                        | Medium                       | "Show archived" + "Clear all" are management, not navigation                       |
| 5   | **Add provider/tier mini-badges** to picker rows ("max", "cloud", "local")      | Low                                                                        | Medium                       | Perplexity pattern; informs the choice                                             |
| 6   | **Relative timestamps on thread rows**                                          | Low                                                                        | Low–Medium                   | "9h ago" / "yesterday" / "3 days ago" beside the message count                     |
| 7   | **Search input** in sidebar                                                     | Medium                                                                     | Low until thread count grows | Defer until threads >20 or operator complains about finding                        |
| 8   | **Group threads** by Pinned / Recents under The Den                             | Medium — needs pin column in DB + UI                                       | Medium                       | Worth doing as part of the larger sidebar revamp the operator's audit doc outlined |

---

## What I'd recommend tackling next, in priority order

1. **Human-readable thread titles** — the single biggest visible-impact change. The current `chat-s17rnxwp` reading is the loudest devtool-chrome moment in the whole app right now.
2. **Bottom-sheet model picker on mobile** — direct operator ask, makes sense given list length, matches Claude + Perplexity precedent.
3. **Replace `CORE/HOST` footer** — quick win, removes the last obvious devtool fingerprint from the chrome.
4. **Move "Show archived / Clear all" to a kebab** + **add explicit "+ New chat" CTA at top** — completes the sidebar's primary-nav story.

Items 5–8 belong to the full sidebar revamp from the operator's own 2026-06-01 audit doc §6 (Active Tasks section, collapsible Spaces, Cmd-K command surface) — that one needs a design conversation before code.

Reference screenshots in `docs/design/ref_material/` (committed evidence).
