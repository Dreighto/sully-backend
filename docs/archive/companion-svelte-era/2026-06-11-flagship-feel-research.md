# Flagship iOS Feel — Research Pass

**How the good ideas from ChatGPT / Claude / Gemini actually work, and how to make them Sully's.**

> Second-eye research by CC (VP Ops), 2026-06-11. Web-grounded (citations at the end).
> Companion to the hybrid canon (`2026-06-11-flagship-hybrid-canon.md`) — this is the **"why/how"
> layer** behind its pattern table. Owner of implementation stays as the canon assigns (CUR/AGY).
> Nothing here changes scope; it explains the mechanics so the build is informed, not guessed.

---

## The meta-insight (read this first)

A native iOS app feels premium for **one mechanical reason above all others: it animates with
spring physics, not with the fixed curves web apps default to.** Everything else (haptics, blur,
sheets) is built on top of that physical feeling. The good news: there's now a way to get true
spring motion in plain CSS, and it upgrades the _entire app at once_ without touching any component.

**The single highest-leverage move:** generate spring curves into CSS `linear()` easing tokens and
drop them into Sully's existing motion-token slots. Today `app.css` (~lines 179–198) defines motion
as `cubic-bezier()` — those can fake _one_ gentle overshoot but can't reproduce the real iOS spring
family. The `linear()` technique samples a real damped-spring equation into an easing the browser
runs natively. Same token names, one-time generation, and suddenly every transition in the app feels
physical. This is the biggest feel-per-effort win in the whole pass. [spring→linear: 6, 7]

```css
/* Today (fakes a bounce): */
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);

/* Upgrade (real spring, generated from stiffness/damping/mass, ~12 samples): */
--ease-spring: linear(0, 0.02, 0.07, 0.15, 0.26, 0.39, 0.53, 0.66, 0.78, 0.88, 0.95, 0.99, 1);
@supports not (transition-timing-function: linear(0, 1)) {
	/* keep the cubic-bezier fallback */
}
```

### What "flagship iOS" actually means (validated by the research, matches canon Part 2)

1. **Quiet by default** — chrome appears only when needed.
2. **Predictable motion** — one easing family, one set of durations, one sheet language.
3. **Physical feedback** — things spring, compress on press, have momentum and rubber-banding.
4. **Never fight the platform** — safe areas, keyboard, native scroll, 60fps on WebKit.
5. **One continuous flow** — chat ↔ voice ↔ sheet ↔ sidebar feel like one app.

Sully's job: add the dispatch/work identity **on top of** that calm, never breaking it.

---

## Pattern 1 — Physical motion everywhere (the spring system)

- **The idea:** movement that feels like it has weight — it accelerates, slightly overshoots, settles.
- **How it works:** iOS animations are a damped-harmonic-oscillator (mass + stiffness + damping).
  Web can reproduce it by sampling that equation into a CSS `linear()` easing. Different
  stiffness/damping presets become different "weights" (heavy sheet vs light button). [6, 7]
- **Flagships:** every transition rides the system spring; that consistency _is_ the premium feel.
- **Sully today:** rich token set exists but they're `cubic-bezier`; `prefers-reduced-motion` guards
  are scoped per-class (not universal — new motion isn't auto-protected).
- **The move:** generate 2–3 spring `linear()` curves (enter / exit / small-bounce), swap them into the
  existing `--ease-*` slots behind `@supports`, add ONE universal reduced-motion neutralizer.
  → Feeds canon Part 3 (Motion system). **Do this first — it multiplies every other motion item.**

## Pattern 2 — Streaming + scroll that never fights you

- **The idea:** while a reply streams, the view stays glued to the newest text — _unless_ you've
  scrolled up to read history, in which case it must NOT yank you down; it offers a "new ↓" pill instead.
- **How it works:** an `autoFollow` flag = `distanceFromBottom < threshold` (24–80px buffer, not 0 —
  exactly-at-bottom is brittle). Each streamed chunk scrolls to bottom _only if_ `autoFollow`, computed
  _after_ the DOM height settles (`requestAnimationFrame`). If not following, increment an unread count
  and show the pill. Own this in JS — CSS scroll-anchoring is unreliable for streaming. [1]
- **Flagships:** ChatGPT/Claude both do exactly this stick-or-pill split.
- **Sully today:** **already has it** — `scrollFeedToBottom` (`+page.svelte:376`) + the "{n} new messages ↓"
  pill (`:1209`). This is a flagship pattern Sully got right.
- **The move:** validate the threshold buffer (24–80px) and the `autoFollow`-disables-on-scroll-up flag;
  spring the pill's entrance (`--ease-spring`). Mostly refinement, not rebuild. → Canon Part 4B.

## Pattern 3 — Long-press message menu (the "lift")

- **The idea:** press-and-hold a message → it lifts off the surface with a haptic, an action sheet
  presents (Copy / Regenerate / Read aloud / feedback). Replaces the always-visible button row.
- **How it works:** custom recognizer on Pointer Events — start a ~500ms timer on `pointerdown`,
  cancel if the finger moves >~10px or lifts early. On fire: haptic + scale the bubble `1.03` /
  lift `translateY(-2px)` over ~150ms, then present the sheet. Critically, set
  `-webkit-touch-callout: none; user-select: none` on bubbles so iOS's native text-selection menu
  doesn't hijack the gesture. [3, 8]
- **Flagships:** iMessage/ChatGPT/Claude all use this; it's why their conversations look clean (no
  button clutter) yet every action is one press away.
- **Sully today:** always-on Copy/Regen/Play row under every message (the clutter my second-eye flagged).
- **The move:** the recognizer + lift + sheet. → Canon Part 4B + the `SullySheet` primitive (Part 6),
  reusing the existing RunSheet motion.

## Pattern 4 — Haptics (the exact map)

- **The idea:** tiny taptic feedback at the right moments makes touch feel _connected_ to the app.
- **How it works:** `@capacitor/haptics` is a thin shell over iOS `UIFeedbackGenerator`. The art is
  matching style to moment, not firing constantly (iOS throttles >~10–15/sec and it reads as noise). [4, 5]

  | Moment                                  | Call                                               | Why                                      |
  | --------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
  | Long-press menu opens                   | `impact(Medium)`                                   | primary gesture, "something substantial" |
  | Send message                            | `impact(Light)` or none                            | routine; Light at most                   |
  | Toggle / boundary snap                  | `impact(Light)`                                    | small events                             |
  | Scrub a picker / reaction row           | `selectionStart → selectionChanged → selectionEnd` | one tick per index change only           |
  | Pull-to-refresh fires                   | `impact(Light)`                                    | at the threshold lock, not during drag   |
  | Task success (PR merged, dispatch done) | `notification(Success)`                            | special, sparing                         |
  | Failure / error                         | `notification(Error)`                              | urgent multi-pulse                       |

- **Sully today:** none. **Sully-specific win:** fire `notification(Success)` when a dispatch/worker
  completes — that's the active-work identity made _physical_, something the consumer apps can't do.
- **The move:** a thin `Haptic` helper + call sites. → Canon Phase D (CC + `ship-ios`); native-only,
  guarded for unsupported devices.

## Pattern 5 — Keyboard choreography (the #1 "feels broken on a phone" fix)

- **The idea:** the composer stays pinned just above the keyboard with no gap and nothing hidden, and
  rises/falls _with_ the keyboard instead of jumping.
- **How it works — and why naive fails:** `100vh` / `window.innerHeight` do **not** track the iOS
  keyboard — that's the gap/jump everyone hits. The robust pattern is dual, because Sully ships
  **both** as a PWA and in Capacitor:
  - **PWA / Safari:** the **VisualViewport API** — on `visualViewport` resize/scroll, compute the bottom
    inset and `transform: translateY(-inset)` the composer (transform, not `bottom`, for perf). [9]
  - **Capacitor:** `@capacitor/keyboard` with **`resize: 'none'`** (stop the WebView's own jumpy resize),
    then use `keyboardWillShow.keyboardHeight` to translate the composer and pad the scroll container;
    `keyboardDidShow` → scroll to bottom. [10, 11]
  - **Plus:** input `font-size: 16px` (smaller → iOS force-zooms and breaks your math),
    `env(safe-area-inset-bottom)` for the home indicator, `viewport-fit=cover` +
    `interactive-widget=resizes-content`, and `100dvh` (fallback `100vh`).
- **Sully today:** only keyboard _key_ handlers (Escape/Enter) — **no VisualViewport/keyboard-height
  tracking found.** This is the highest-impact _correctness_ fix for phone feel.
- **The move:** the dual VisualViewport + Capacitor-keyboard pattern. → Canon Part 6 (keyboard check) +
  `ios-pwa-input-hygiene` skill; web half is PWA-independent of Capacitor.

## Pattern 6 — The living voice orb

- **The idea:** voice mode centers on an orb that's _alive_ — breathing at rest, swelling with your
  voice, morphing per phase — so it feels like Gemini Live, not a settings screen with a big button.
- **How it works:** two layers. (a) A **phase state machine** (idle / listening / thinking / speaking /
  error), each phase a preset of radius/pulse/noise/color/glow, _lerped_ between for organic transitions.
  (b) **Audio-reactive drive:** a Web Audio `AnalyserNode` on the mic (listening) and on the TTS output
  (speaking); average `getByteFrequencyData` → a 0–1 amplitude → drives scale + blob-distortion + glow,
  exponentially smoothed (~100ms). Render with **Canvas 2D** (a noise-perturbed circle with a radial
  gradient + shadow-blur) for the organic blob; WebGL only if you want it fancier; CSS scale-pulse as
  the reduced-motion / low-end fallback. Run the loop **only while voice mode is open** (battery). [12, 13, 14]
- **Flagships:** Gemini Live & ChatGPT Advanced Voice are exactly this — state machine + procedural
  animation + amplitude mapping + gradients/blur/micro-drift so it never freezes.
- **Sully today:** `SullyAvatar` PNG sprites + an orb; canon wants kinetic orb + phase rings + waveform dock.
- **Sully-specific advantage:** voice runs **on-device** (Jetson), so the amplitude can be read straight
  off the local mic/TTS audio with zero cloud round-trip — the orb can be tighter to the audio than a
  cloud app's. → Canon Part 4E / Phase C (`VoiceOrbStage`, `VoiceWaveDock`).

## Pattern 7 — "One continuous flow" (View Transitions)

- **The idea:** moving between chat ↔ a thread ↔ voice ↔ a run sheet feels like one app morphing, not
  four screens swapping.
- **How it works:** the **View Transitions API** — wrap a DOM/route change in
  `document.startViewTransition(() => updateDOM())`; the browser snapshots before/after and animates
  the difference, including **shared elements** tagged `view-transition-name` (e.g. an avatar or pill
  that "travels" between screens). Feature-detect (`'startViewTransition' in document`) and fall back to
  a manual transform/opacity transition where unsupported (Safari/WKWebView support is emerging — treat
  as progressive enhancement). [6]
- **Sully today:** thread switches and voice-mode enter are abrupt.
- **The move:** wrap thread-switch and voice-enter in View Transitions with a manual fallback; tag the
  Sully orb / worker pill as shared elements so they persist across the transition. → Canon Part 4A/4E.

## Pattern 8 — Kill the "web smells" (the cheap polish checklist)

These are the tells that scream "web app." Each has a one-line fix (all validated): [6, 7]

- **Instant state changes** → every visible change gets _some_ motion (a token transition).
- **No momentum / hard scroll stops** → prefer **native** scrolling (`overflow:auto`,
  `-webkit-overflow-scrolling:touch`); don't `preventDefault` touchmove on the root (it kills iOS
  rubber-banding for free).
- **Content popping in** → reserve space (aspect-ratio / skeletons); animate inserts from
  `scale(.97)/opacity 0`, never let layout snap.
- **Inconsistent easing** → everything uses the token set, nothing uses raw `ease`/`cubic-bezier`.
- **Animating `height`/`box-shadow`/`top` on big surfaces** → transform + opacity ONLY; add `will-change`
  only _during_ the animation and remove it after.

---

## Ranked wins (effort vs. flagship payoff)

| #   | Move                                                                 | Effort         | Payoff                         | Risk              |
| --- | -------------------------------------------------------------------- | -------------- | ------------------------------ | ----------------- |
| 1   | **Spring `linear()` motion tokens** + universal reduced-motion guard | Low (one-time) | **Huge** (whole app)           | Very low          |
| 2   | **Keyboard choreography** (VisualViewport + Capacitor)               | Med            | High (fixes "broken on phone") | Low               |
| 3   | **Long-press menu + lift** (declutter messages)                      | Med            | High (calm surface)            | Low               |
| 4   | **Message-land + tactile-press** wiring (the unused tokens)          | Low            | High                           | Very low          |
| 5   | **Living voice orb** (phase machine + amplitude)                     | High           | High (signature moment)        | Med               |
| 6   | **Haptics map** (esp. dispatch-success)                              | Low (native)   | Med, distinctive               | Low               |
| 7   | **View Transitions** for thread/voice flow                           | Med            | Med                            | Low (progressive) |

**Recommended order for whoever builds it:** #1 first (it multiplies everything), then #2 and #4
(correctness + the already-defined-but-unwired motion), then #3, then the voice orb (#5) and haptics
(#6) as the signature polish, View Transitions (#7) last.

## How this feeds the hybrid canon

| This research                                      | Canon section it informs        |
| -------------------------------------------------- | ------------------------------- |
| Spring `linear()` tokens, universal reduced-motion | Part 3 (Motion system), Part 6  |
| Stick-to-bottom math + pill threshold              | Part 4B                         |
| Long-press recognizer + lift + `SullySheet`        | Part 4B, Part 6                 |
| Haptic style→moment map                            | Phase D, Part 8                 |
| Dual keyboard pattern                              | Part 6, `ios-pwa-input-hygiene` |
| Voice orb state-machine + amplitude recipe         | Part 4E, Phase C                |
| View Transitions for "one flow"                    | Part 4A/4E, Part 2 §5           |
| "Web smells" checklist                             | Part 3 perf rules               |

---

## Sources

1. Handling scroll behavior for AI chat apps — jhakim.com · MDN Scroll Anchoring · TanStack Virtual #730
2. (scroll, cont.) jasonbyrne.net store-scroll-status (Svelte)
3. Carmen Ansio — Spring physics in CSS · 7. Josh Comeau — the `linear()` timing function
4. Radix UI primitives #930 (iOS touch-callout) · Apple HIG — Context Menus
5. Capacitor Haptics docs · 5. swmansion — designing haptic patterns
6. martijnhols.nl — detecting the iOS on-screen keyboard (VisualViewport) · 10. Ionic forum — smooth keyboard slide-ins · 11. Capacitor Keyboard docs
7. Google — Gemini Live API · 13. Gemini Live docs · 14. ChatGPT Advanced Voice (TELUS/every.to)

_(Full URLs in the session research log; ask CC to expand any citation.)_
