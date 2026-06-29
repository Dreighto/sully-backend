# Flagship Visual Mockups

**Purpose:** Interactive HTML prototypes + screenshots showing how Sully should look after the CUR visual pass. Use while waiting for in-flight tickets (LOS-193, LOS-205, primitives stage 3) to land.

**Operator decision:** CUR (Cursor) is the assigned **frontend visual worker** for implementation. These mockups are the target reference — not production code.

**Implementation plan:** `docs/2026-06-11-flagship-visual-pass-plan.md`

---

## Quick start

### On this machine (loopback)

```bash
http://127.0.0.1:8765/
```

### On your phone via Tailscale (recommended)

With Tailscale connected on the iPhone:

| URL | Notes |
|-----|-------|
| `http://room.taila28611.ts.net:8765/` | MagicDNS — easiest to remember |
| `http://100.106.246.89:8765/` | Raw tailnet IP (fallback) |

**Start here:** `http://room.taila28611.ts.net:8765/05-compare-before-after.html`

### Persistent service (survives reboot)

```bash
sudo cp /home/dreighto/dev/LogueOS-Companion/linux/systemd/logueos-companion-mockups.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now logueos-companion-mockups.service
systemctl is-active logueos-companion-mockups.service   # expect: active
```

Stop when done reviewing:

```bash
sudo systemctl stop logueos-companion-mockups.service
```

### AGY comparison pack (port 8766)

Parallel mockups from AGY live under `agy/`. Brief: `AGY-MOCKUP-CHALLENGE.md`.

| URL | Notes |
|-----|-------|
| `http://room.taila28611.ts.net:8766/` | AGY pack (Tailscale) |
| `http://127.0.0.1:8766/` | Loopback |

```bash
sudo cp /home/dreighto/dev/LogueOS-Companion/linux/systemd/logueos-companion-mockups-agy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now logueos-companion-mockups-agy.service
```

### Ad-hoc (no systemd)

```bash
cd /home/dreighto/dev/LogueOS-Companion/docs/flagship-visual-mockups
python3 -m http.server 8765 --bind 0.0.0.0
```

`--bind 0.0.0.0` is required for Tailscale access (not `127.0.0.1` only).

---

## Mockup pages

| File | Shows |
|------|--------|
| `index.html` | Hub — links to all mockups |
| `05-compare-before-after.html` | **Start here** — side-by-side today vs target |
| `01-chat-quiet.html` | Quiet thread, glass bubbles, header model chip |
| `02-empty-state.html` | Greeting + suggested prompt chips (Gemini borrow) |
| `03-sidebar-clean.html` | Consumer sidebar, Active Tasks, no dev footer |
| `04-message-sheet.html` | Long-press action sheet |
| `06-chat-with-worker.html` | Worker pill + quiet replies (keep differentiator) |

Shared styles: `shared.css` (Indigo locked tokens subset)

---

## Screenshots

| Folder | Contents |
|--------|----------|
| `screenshots/baseline/` | Production Sully + Gemini reference (2026-06-11) |
| `screenshots/mockups/` | PNG captures of HTML mockups (auto-generated) |

### Refresh mockup screenshots

```bash
cd /home/dreighto/dev/LogueOS-Companion/docs/flagship-visual-mockups
python3 -m http.server 8765 &
# Then run Playwright captures at 393×852 for each page
```

---

## What changed vs today (summary)

1. **Message actions** — hidden until focus / long-press (not always-on Copy/Regen/Play row)
2. **User bubbles** — glass material matching composer (not opaque zinc cards)
3. **Model picker** — `Auto ▾` in header (not inside composer pill)
4. **Composer** — text + attach + voice/send only
5. **Sidebar** — human titles, Active Tasks, settings chip (no `HOST: 127.0.0.1`)
6. **Empty state** — tappable prompt chips
7. **Header** — borderless blur bar, less vertical chrome
8. **Keep** — WorkerPill, voice FAB, thinking states, flat assistant text

---

## CUR worktree (for implementation later)

```
/home/dreighto/dev/worktrees/LogueOS-Companion/cur
branch: feat/cur-flagship-visual-pass
```

Rebase onto `main` after in-flight work merges, then implement Phase A using these mockups as the visual spec.
