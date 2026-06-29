# Flagship Visual Pass — Reference Screenshots (2026-06-11)

Captured during CUR competitive critique session. Used by `docs/superpowers/plans/2026-06-11-flagship-visual-pass-plan.md`.

## sully-baseline/

Production Sully at `http://127.0.0.1:18769/companion/chat`, iPhone viewport 390×844 (Playwright).

| File | Surface |
|------|---------|
| `companion-empty-iphone.png` | Chat thread with history + composer |
| `companion-sidebar-iphone.png` | Threads drawer open |
| `companion-model-sheet-iphone.png` | Model picker bottom sheet |

## reference/

| File | Source | Status |
|------|--------|--------|
| `ref-gemini-mobile.png` | gemini.google.com (logged out) | ✓ captured |

### Still needed (operator or authenticated session)

Headless Playwright hit Cloudflare on ChatGPT and Claude. Add:

- `ref-chatgpt-empty.png` — empty / new chat
- `ref-chatgpt-thread.png` — active conversation + composer
- `ref-chatgpt-sidebar.png` — history drawer
- `ref-claude-empty.png`
- `ref-claude-thread.png`
- `ref-claude-sidebar.png`

Capture at **393×852** (iPhone 15/16 class) for parity with plan verification spec.
