# Sully — Locked Design Spec (v1.0 FINAL)

*Locked by Captain · 2026-06-10 · verified and merged by CH*
*Palette: **Indigo** · Type: **Blend Mk II** (Fraunces / Bricolage Grotesque / JetBrains Mono) · Magenta: retired*
*Audience: CC. This supersedes all palette/type sections of the earlier design spec. Component and motion behavior specs from the v1 document still apply — they now consume these tokens.*

-----

## 1. What changed vs. the v1 spec (read first)

1. **Magenta is retired everywhere**, including the orb. The orb gradient is now the Indigo family (`--orb-grad` below).
1. **Ash discipline is canonical**: `--ui` (quiet gray) for chrome — selected states, badges, secondary borders. `--live` (indigo) only when something is actually happening — active run dots, streaming cursor, listening rings, escalation chips, primary actions. If an element is not live and not a primary action, it does not get accent color.
1. **Captain’s extension block is merged**, with one conflict resolved: the extension redefined `--ease-standard`, `--ease-exit`, `--dur-fast`, `--dur-slow` and omitted `--dur-instant`, `--dur-base`, `--dur-long`, `--ease-enter`, `--ease-spring`, `--ease-sheet`, which the v1 component animations reference. The merged motion set below is now the single source of truth — Captain’s values win where names overlapped; the v1-referenced tokens survive with their original values. Do not keep two motion blocks anywhere in the codebase.
1. **Fonts are self-hosted** (Section 4). No Google Fonts `@import` may remain in the shipped app.

-----

## 2. Canonical tokens — the complete `:root`

This is the entire token surface. Drop in as-is.

```css
:root {
  /* ============ PALETTE — INDIGO ============ */
  --bg0: #0b0c10;  --bg1: #0f1015;  --bg2: #14161c;
  --bg3: #1b1d25;  --bg4: #242730;

  --line:  rgba(200, 210, 255, .07);
  --line2: rgba(200, 210, 255, .11);
  --line3: rgba(200, 210, 255, .18);

  --t1: #f3f4f8;  --t2: #b6b9c7;  --t3: #7f8394;  --t4: #545866;

  --accent:      #7c84e8;
  --accent-dim:  #5e6ad2;
  --accent-glow: rgba(124, 132, 232, .26);
  --on-accent:   #ffffff;          /* text on accent-filled buttons */
  --grad: linear-gradient(90deg, #5e6ad2, #7c84e8);

  --ui:   #8b8e9e;   /* quiet chrome — selected states, badges, secondary borders */
  --live: #7c84e8;   /* live-state only — pulses, cursors, rings, escalations */

  --green: #4ade80;  --amber: #fbbf24;
  --red:   #f87171;  --blue:  #60a5fa;

  --glass-bg:     rgba(20, 22, 28, .74);
  --glass-border: rgba(200, 210, 255, .10);

  --orb-grad: radial-gradient(circle at 32% 28%,
    #c3c8ff 0%, #7c84e8 40%, #5e6ad2 72%, #363f99 100%);

  /* ============ TYPE — BLEND MK II ============ */
  /* Family names assume Fontsource variable packages (Section 4, Option A). */
  --font-display: 'Fraunces Variable', Georgia, serif;
  --font-body:    'Bricolage Grotesque Variable', -apple-system, system-ui, sans-serif;
  --font-mono:    'JetBrains Mono Variable', ui-monospace, 'SF Mono', monospace;

  --weight-regular: 400;  --weight-medium: 500;
  --weight-semibold: 600; --weight-bold: 700;
  --disp-weight: 600;     --disp-track: -0.008em;

  --text-xs:   0.75rem;    --leading-xs:   1.35;
  --text-sm:   0.8125rem;  --leading-sm:   1.45;
  --text-base: 0.9375rem;  --leading-base: 1.55;
  --text-lg:   1.0625rem;  --leading-lg:   1.5;
  --text-xl:   1.25rem;    --leading-xl:   1.3;
  --text-2xl:  1.625rem;   --leading-2xl:  1.2;
  --text-3xl:  2.125rem;   --leading-3xl:  1.1;
  --text-4xl:  2.875rem;   --leading-4xl:  1.04;

  /* ============ MOTION — MERGED (single source of truth) ============ */
  --ease-standard:   cubic-bezier(.2, .8, .2, 1);    /* Captain */
  --ease-emphasized: cubic-bezier(.16, 1, .3, 1);    /* Captain */
  --ease-enter:      cubic-bezier(.05, .7, .1, 1);   /* v1 — message/card entries */
  --ease-exit:       cubic-bezier(.4, 0, 1, 1);      /* Captain */
  --ease-spring:     cubic-bezier(.34, 1.56, .64, 1);/* v1 — orb, dots */
  --ease-sheet:      cubic-bezier(.32, .72, 0, 1);   /* v1 — iOS sheets ONLY */

  --dur-instant: 80ms;   /* touch acknowledgment */
  --dur-fast:    120ms;  /* Captain */
  --dur-med:     180ms;  /* Captain */
  --dur-base:    220ms;  /* v1 — message land, card enter */
  --dur-slow:    280ms;  /* Captain */
  --dur-panel:   360ms;  /* Captain — panels/sheets */
  --dur-long:    480ms;  /* v1 — sheet enter, ambient */

  /* ============ RADIUS (Captain) ============ */
  --r-xs: 6px;  --r-sm: 10px;  --r-md: 14px;
  --r-lg: 18px; --r-xl: 24px;  --r-pill: 999px;

  /* ============ ELEVATION (Captain) ============ */
  --shadow-soft:  0 10px 30px rgba(0, 0, 0, .28);
  --shadow-card:  0 16px 48px rgba(0, 0, 0, .36);
  --shadow-float: 0 24px 80px rgba(0, 0, 0, .46);
  --shadow-accent: 0 0 0 1px rgba(124,132,232,.18), 0 14px 44px rgba(124,132,232,.14);

  /* ============ FOCUS (Captain) ============ */
  --focus:        0 0 0 2px rgba(124,132,232,.45);
  --focus-strong: 0 0 0 3px rgba(124,132,232,.62);

  /* ============ STATUS SURFACES (Captain) ============ */
  /* Derived from --live and semantic colors at fixed alphas. */
  --live-bg:   rgba(124,132,232,.12);  --live-line:  rgba(124,132,232,.28);
  --green-bg:  rgba(74,222,128,.10);   --green-line: rgba(74,222,128,.24);
  --amber-bg:  rgba(251,191,36,.10);   --amber-line: rgba(251,191,36,.26);
  --red-bg:    rgba(248,113,113,.10);  --red-line:   rgba(248,113,113,.28);
  --blue-bg:   rgba(96,165,250,.10);   --blue-line:  rgba(96,165,250,.25);

  /* ============ APP SURFACES (Captain) ============ */
  --surface-chat:    rgba(15,16,21,.96);   /* = bg1 family */
  --surface-card:    rgba(20,22,28,.88);   /* = bg2 family */
  --surface-raised:  rgba(27,29,37,.94);   /* = bg3 family */
  --surface-overlay: rgba(11,12,16,.76);   /* scrims */

  /* ============ WORK OBJECTS (Captain) ============ */
  --thread-pill-bg:     rgba(20,22,28,.82);
  --thread-pill-border: rgba(200,210,255,.10);
  --artifact-bg:        rgba(20,22,28,.90);
  --artifact-border:    rgba(124,132,232,.18);
  --worker-bg:          rgba(124,132,232,.10);
  --worker-border:      rgba(124,132,232,.22);

  /* ============ COMPOSER (Captain) ============ */
  --composer-bg:            rgba(20,22,28,.92);
  --composer-border:        rgba(200,210,255,.12);
  --composer-border-active: rgba(124,132,232,.42);
}
```

**Maintenance note:** every hard-coded `124,132,232` above is `--accent` (#7c84e8) and every `200,210,255` is the Indigo line tint. If the accent ever changes, these blocks change with it — they are one decision, not many.

-----

## 3. Smoothness defaults (Captain’s block, with two adjustments)

Adjustments, both performance-driven for the Capacitor iOS WebView:

1. **The decorative radial washes moved off `body` onto a fixed, paint-isolated shell layer.** On `body`, iOS repaints the full-height gradient during scroll; on a fixed layer it paints once.
1. `.sully-smooth` keeps Captain’s property list, with a rule: **never apply it to full-width panels or sheets** — transitioning `box-shadow`/`background-color` on large surfaces costs frames. Panels use transform/opacity animations only (v1 motion spec).

```css
* { box-sizing: border-box; }

html {
  background: var(--bg0);
  color: var(--t1);
  font-family: var(--font-body);
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}

body { margin: 0; background: var(--bg0); color: var(--t1); }

/* Ambient washes — fixed shell layer, paints once, never rescrolls */
.app-bg {
  position: fixed; inset: 0; z-index: 0; pointer-events: none;
  background:
    radial-gradient(circle at 20% 0%,  rgba(124,132,232,.10), transparent 34%),
    radial-gradient(circle at 80% 10%, rgba(96,165,250,.07),  transparent 28%);
  contain: strict;
}
/* All app content renders above it: */
.app-root { position: relative; z-index: 1; }

button, input, textarea, select { font: inherit; }
button { -webkit-tap-highlight-color: transparent; }

/* Small interactive elements only — never panels/sheets */
.sully-smooth {
  transition:
    transform        var(--dur-med) var(--ease-standard),
    opacity          var(--dur-med) var(--ease-standard),
    background-color var(--dur-med) var(--ease-standard),
    border-color     var(--dur-med) var(--ease-standard),
    box-shadow       var(--dur-med) var(--ease-standard);
}

.sully-panel-enter {
  animation: sully-panel-in var(--dur-panel) var(--ease-emphasized) both;
}
@keyframes sully-panel-in {
  from { opacity: 0; transform: translateY(10px) scale(.985); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 1ms !important;
  }
}
```

-----

## 4. Self-hosted fonts (no Google Fonts at runtime)

All three faces are open-source (SIL OFL). They ship inside the IPA, so Sully renders identically offline on Tailscale, with zero third-party requests and no font-swap flash.

### Option A — Fontsource (recommended for SvelteKit)

```bash
npm install @fontsource-variable/fraunces \
            @fontsource-variable/bricolage-grotesque \
            @fontsource-variable/jetbrains-mono
```

```js
// src/routes/+layout.svelte (top of <script>)
import '@fontsource-variable/fraunces';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/jetbrains-mono';
```

Vite bundles the woff2 files into the build; Capacitor packages them into the app. **Important:** Fontsource registers variable families with a `Variable` suffix — the token stacks in Section 2 already use `'Fraunces Variable'`, `'Bricolage Grotesque Variable'`, `'JetBrains Mono Variable'`. If Option B is used instead, drop the suffix in the tokens.

### Option B — Manual `@font-face` (fallback / full control)

Pull variable woff2 files from the official repos (Fraunces: `undercasetype/Fraunces`; Bricolage: `ateliertriay/bricolage`; JetBrains Mono: `JetBrains/JetBrainsMono` — convert TTF→WOFF2 with `woff2_compress` where only TTF is published). Place in `/static/fonts/`.

```css
@font-face {
  font-family: 'Fraunces';
  src: url('/fonts/fraunces-var.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Bricolage Grotesque';
  src: url('/fonts/bricolage-var.woff2') format('woff2-variations');
  font-weight: 200 800;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'JetBrains Mono';
  src: url('/fonts/jetbrainsmono-var.woff2') format('woff2-variations');
  font-weight: 100 800;
  font-style: normal;
  font-display: swap;
}
```

### Verification gate (STANDARD VERIFY addition)

A run claiming font self-hosting is complete must show: (1) zero requests to `fonts.googleapis.com` / `fonts.gstatic.com` in the network log on device, (2) the three font files present in the built app bundle, (3) a device screenshot rendering display/body/mono correctly with WiFi off.

-----

## 5. Usage rules (the taste, encoded)

- **Display face (Fraunces, 600, −0.008em):** only at `--text-2xl` and above — greetings, voice transcript, empty states, sheet titles, digest headers. Never for buttons, labels, or body.
- **Body face (Bricolage):** everything readable. 400 default, 500 for titles/emphasis.
- **Mono (JetBrains):** trace IDs, ports, timestamps, route chips, gate badges, versions, all tabular data (`font-variant-numeric: tabular-nums`).
- **Accent budget:** on any one screen, `--live` should appear in at most ~3 places. The home screen reference: worker-pill active dot, orb, nothing else. Primary action buttons use `--grad` + `--on-accent`.
- **Status surfaces:** `--*-bg` + `--*-line` pairs are the only way to tint a container by state. Never tint with raw accent/semantic colors at ad-hoc alphas.
- **Assistant messages remain bubble-less** (open type on `--surface-chat`); user bubbles use `--bg3` + `--r-lg` with the tucked corner.
- **The orb** keeps the full v1 state machine (idle breathe / listening rings / thinking sheen / speaking amplitude / muted gray) — only its gradient changed to `--orb-grad`.

-----

## 6. Hand-off checklist for CC

1. Add Section 2 `:root` and Section 3 defaults to the Companion’s global stylesheet; **delete** all previous palette/type/motion token blocks (one source of truth).
1. Install fonts per Section 4 Option A; remove every Google Fonts `@import`/`<link>`.
1. Sweep for hard-coded magenta (`#f25fab`, `#c2247e`, `#ff9ed0`, `#8e1560`, `242, 95, 171`) — replace with tokens; the orb component takes `--orb-grad`.
1. Sweep for hard-coded radii/shadows/durations — replace with `--r-*`, `--shadow-*`, `--dur-*`.
1. Run STANDARD VERIFY + the font verification gate (Section 4) on device.