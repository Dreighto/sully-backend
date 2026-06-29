# Sully — Brand & Icon Brief

A self-contained brief for generating Sully's app icon and brand mark. Paste this whole doc to any image-gen tool (GPT/DALL·E, Midjourney, etc.) and use the prompt blocks at the bottom.

---

## What Sully is

Sully is a personal AI companion that runs on the operator's own hardware (Linux box with a 5060 Ti). She's not a corporate AI product — she's a private companion fine-tuned on the operator's own voice and chat history. Local model (Qwen 14B QLoRA-tuned) by default, cloud models (Claude / Gemini) on tap.

She's used through:

- A SvelteKit PWA + Capacitor iOS app (chat + voice mode, accessed via Tailscale)
- Voice (local STT + TTS) for hands-free interaction
- Text chat with a model picker (Auto / Claude / Gemini / Local)

The operator ("Captain") is not a developer. Sully's job is to be a warm, direct, plain-English-first partner — never a corporate assistant.

## Brand personality

- **Warm, not corporate.** Friend, not product.
- **Calm, not energetic.** No exclamation marks, ever. No "Hi!! ✨". She's the always-present companion, not a hype machine.
- **Confident, not cute.** Distinctive and grown-up. Not a mascot.
- **Direct.** Plain English first. Short replies unless depth is asked for.
- **Femme-leaning.** Named Sully (operator chose it). Warm but not soft. No literal feminine imagery — the warmth comes through palette and form, not from gender signals.

## Visual context

- **Brand color:** hot pink `#ec2d78`, with a softer accent `#ff7eb3`.
- **Surface:** deep charcoal `#0b0b0d` / `#0d1117`, dark theme only.
- **Typography:** Inter / system sans. Tight letter-spacing (`-0.01em`), no all-caps for body.
- **Recently rejected:** a glossy 3D magenta orb. Too corporate-AI-product. The new mark should NOT be a glowing orb / sphere / blob.

## Where the icon is used

The same mark needs to read at every one of these sizes:

| Surface                                        | Size                                                 |
| ---------------------------------------------- | ---------------------------------------------------- |
| iOS / PWA app icon                             | 1024×1024, 180, 152, 120, 87, 80, 76, 60, 40, 29, 20 |
| Home-screen tile                               | 64×64                                                |
| Header mark (in-app, next to "Sully" wordmark) | 32×32                                                |
| Sidebar avatar                                 | 24×24                                                |
| Message-feed avatar                            | 20-24×24                                             |
| **Picker chip (hardest test)**                 | **14×14**                                            |
| Favicon                                        | 32×32                                                |

The picker chip is the hardest test. A mark that survives there survives everywhere.

## Hard constraints

- **Square 1024×1024 output.**
- **NO outer border / outer frame.** iOS rounds the corners; the artwork should bleed to the edges. The model often wants to add a white rounded-square frame around the icon — explicitly forbid this in the prompt.
- **NO text, no letters spelled out, no signatures.** A letterform is fine as a _shape_ (e.g. an abstract S), but not as typography.
- **Single subject.** No clutter. No surrounding sparkles, particles, planets, stars.
- **Centered with breathing room.** ~10-15% padding from the edges so the mark isn't crushed when iOS rounds corners.
- **Dark background.** Either solid `#0b0b0d` charcoal, or fully transparent if the tool supports it.
- **Warm palette.** Hot pink `#ec2d78` as the brand accent, cream/off-white `#f5ead8` for contrast, deep charcoal for the surface. No teal, no purple, no cyan, no green.
- **Readable at 14px.** If you blur the 1024 down to 14, the silhouette should still be distinctive.

## What we've tried (so we don't loop)

| Direction                               | Verdict                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------- |
| Glossy magenta orb (current production) | Rejected — too corporate-AI, generic                                        |
| Folded paper ribbon shaped into an "S"  | **Strongest direction so far.** Tight, geometric folds, cream-pink palette. |
| Bold glowing crescent                   | Atmospheric but less distinctive at small sizes                             |
| Brushstroke "S"                         | Personal/hand-felt feel, but loses legibility small                         |
| Conversation-bloom blobs                | Didn't land — too organic, no clear read                                    |

If you go a new direction, avoid: orbs, blobs, glowing spheres, generic AI-product gradients, robot/eye motifs, speech-bubble outlines, sparkle/stars.

## What we want now

3-4 fresh app-icon candidates from a different image-gen tool. Push different directions — not all variants of the same idea. Aim for marks that feel like flagship app icons (think Linear, Notion, Things, Arc, Raycast) but with Sully's warm personality.

---

## Image-gen prompts (paste-ready)

Each block is one prompt. Run them separately for variety. Adjust the bracketed direction note `[…]` to push different shapes.

### Prompt 1 — Letterform direction

```
A premium iOS app icon, square 1024x1024 pixels. An abstract "S" mark formed by a single tight folded paper ribbon — crisp angular folds, compact, taller than wide, centered with ~12% padding on all sides. The S is a sealed continuous form. Warm cream-white ribbon (#f5ead8) with hot-pink (#ec2d78) gradient bleeding through the inner folds. Deep charcoal background (#0b0b0d) that fills the entire frame to the edges — NO white border, NO outer frame, NO rounded-square outline. Subtle realistic shadows for depth. Single subject. No text, no typography, no surrounding particles or decoration. Flagship app icon quality — sits naturally next to Linear, Notion, or Things on a home screen.
```

### Prompt 2 — Geometric direction (no letterform)

```
A premium iOS app icon, square 1024x1024 pixels. An abstract geometric mark — two soft overlapping rounded shapes interlocking cleanly to suggest companionship and conversation without being literal. Rendered in warm cream-white (#f5ead8) with hot-pink (#ec2d78) gradient at the overlap. Deep charcoal background (#0b0b0d) extending to the edges — NO outer border, NO white frame, NO rounded outline. Subtle inner shading for depth. Centered with ~12% padding. Single subject, distinctive silhouette readable at 14px. No text, no letters, no faces, no sparkles, no speech-bubble outlines. Flagship app icon quality.
```

### Prompt 3 — Soft glyph direction

```
A premium iOS app icon, square 1024x1024 pixels. A single confident brushstroke gesture in cream-white (#f5ead8) with hot-pink (#ec2d78) bleed at the stroke ends, suggesting an abstract "S" curve without spelling it out. Deep charcoal background (#0b0b0d) filling the entire frame — NO border, NO outer frame, NO white outline. Centered with breathing room (~12% padding). The stroke is bold enough to read at 14px. Photographic ink-on-paper texture, subtle realism. Single subject. No text, no signature, no surrounding particles. Personal and hand-felt but still iconic.
```

### Prompt 4 — Mood / atmosphere direction

```
A premium iOS app icon, square 1024x1024 pixels. A bold glowing crescent shape in vivid hot-pink (#ec2d78) with a soft cream-white (#f5ead8) inner highlight along the inner curve, filling most of the frame with ~10% padding. Deep charcoal background (#0b0b0d) that fills the entire frame edge to edge — NO border, NO outer frame, NO rounded outline. The crescent reads instantly at 14px. Flat with subtle gradient and rim-light. Single subject, no extra elements, no stars, no sparkles, no smaller moons. Flagship app icon quality.
```

---

## How to evaluate the output

1. **Squint test.** Mentally blur the 1024 down to 14px. Is the silhouette still recognizable?
2. **Home-screen test.** Imagine the icon next to other iOS apps (Linear, Things, Notion). Does it look like it belongs in that company, or like an AI-product stock asset?
3. **Frame test.** Is the artwork bleeding to the edges, or did the model add an outer rounded-square frame? (The latter is wrong — iOS handles rounding.)
4. **Palette test.** Is it the cream + hot-pink + charcoal we asked for, or did the model drift to purple / teal / pastels?
5. **Personality test.** Does it feel like a calm warm companion, or a corporate AI assistant?

Drop the winners back here as `concept-X-name.png` and the brief will be marked done.

## Reference files

- Current production mark (the orb we're replacing): `static/sully-mark.png`
- Live concept review (tailnet only): `https://room.taila28611.ts.net/companion/brand-mockup.html`
- Concept PNGs we've already generated: `docs/design/brand-concepts/`
