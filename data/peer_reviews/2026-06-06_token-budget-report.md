# Token / Budget Report — Work Surface session (2026-06-06)

**Purpose:** bucket spend by model so we can see where tokens/$ went + map the budget.
**TL;DR:** Real **dollar** spend this session ≈ **$0.05** (all of it Gemini API via GMI). Everything else runs on **flat-rate subs already paid**. The real story is **token VOLUME + a measurement blind spot**, not dollar overspend.

---

## 1. The headline finding (must fix): we can't meter the roster

The kernel's `usage_capture.js` only reads **native claude-cli / gemini-cli** session logs. It captures **nothing** for:

- **aider workers (GMI, DPSK)** — they write their own logs; tokens only appear in the dispatch stdout `Tokens:` line.
- **AGY (Antigravity)** — explicitly unsupported in `usage_capture.js`.

**Every roster receipt this session recorded `usage: 0`.** So per-dispatch cost for the roster is invisible to our own tooling — you literally cannot budget-map the workers from kernel data today. **This is the #1 thing to fix before trusting any budget numbers.** (Fix: parse aider's `Tokens:`/`Cost:` stdout line into the receipt telemetry; add an AGY/antigravity usage reader or accept it's unmetered.)

---

## 2. Spend by model (this session)

| Model / worker                          | Billing                             | Measured this session                                                                                         | $ impact                                                                                    |
| --------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Claude — CC (me, main loop)**         | Claude Max $200/mo (flat, quota)    | **Uninstrumented** — largest single consumer (whole-session reasoning + large tool outputs + big context)     | $0 marginal (flat); **quota pressure: HIGH**                                                |
| **Claude — Workflows (Opus subagents)** | Claude Max (flat, quota)            | **~1,020,000 tokens** across 11 subagents (polish-research 746,788 / 7 agents · lift-plan 273,466 / 4 agents) | $0 marginal; **quota pressure: HIGH** — this is the biggest discrete token chunk we can see |
| **Gemini — GMI (aider, API key)**       | Pay-per-token (~$73 prepaid credit) | ~5 dispatches; `Tokens:` lines sum ~$0.05 (e.g. seed = 26k→10k = $0.03)                                       | **~$0.05 — the ONLY real $ spend.** Credit barely touched. Flash is very cheap.             |
| **Gemini — AGY (Antigravity)**          | Google AI Pro $20/mo (flat, quota)  | 8 dispatches, **tokens uncaptured**; 1,284s wall-clock (incl. 2 timeouts = 612s wasted)                       | $0 marginal; see §3                                                                         |
| **DeepSeek — DPSK (aider, Ollama)**     | Ollama Pro $20/mo (flat)            | 3 reviews ≈ **160k sent / ~3k recv**; no per-token cost (Ollama flat)                                         | $0 marginal                                                                                 |
| **Codex — CDX (ChatGPT Plus)**          | ChatGPT Plus $20/mo (flat)          | minimal (early smoke tests)                                                                                   | $0 marginal                                                                                 |
| **gpt-oss:120b (web-fact model)**       | Ollama (flat)                       | minimal (web-search fix testing)                                                                              | $0 marginal                                                                                 |

---

## 3. AGY — operator confirmed 100% availability → it's a SERVICE issue, not quota

You checked: **AGY usage is at 100% availability** (quota NOT exhausted). Yet both lift dispatches died identically at ~5 min with `Error: timed out waiting for response` (304s, 308s), zero output. The earlier AGY dispatches (polish/icons) succeeded in 38–205s.

→ This is **not quota** and **not task size** (the small chunk-1 retry timed out identically). It's an **AGY/Antigravity service or connectivity problem** that surfaces on longer generations. **Flagged for investigation.** For now AGY is a dead worker — I've routed around it to GMI per your fallback chain.

---

## 4. Roster performance signal (you wanted "which worker actually delivers")

| Worker                       | Verdict this session                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **CC**                       | Everything — orchestration, verification, the precision work. Reliable.                                                       |
| **GMI** (gemini-flash/aider) | ✅ Delivered the seed in 63s for $0.03. Viable + cheap for **focused, single-file** tasks. Weak at huge multi-file scaffolds. |
| **DPSK** (deepseek/aider)    | ✅ 3 solid code reviews (caught 1 real bug, 2 false positives I dismissed). Good reviewer; flat-rate.                         |
| **AGY** (antigravity)        | ⚠️ Did the polish/icon edits well, then **failed hard on the big build** (service timeout). Currently unusable.               |
| **CDX**                      | Barely exercised this session.                                                                                                |

---

## 5. Where the spend / risk actually is

1. **Dollars: ~$0.05.** No overspend. The metered worker (GMI/Gemini API) is trivially cheap; the $73 credit is intact.
2. **Token volume → Claude Max quota.** CC main loop + ~1M workflow tokens is by far the heaviest draw. If anything pressures the budget, it's **Claude Max quota**, not dollars. The two planning/research **workflows alone = ~1M tokens** — the obvious lever if you want to economize (run fewer/smaller fan-outs).
3. **Wasted wall-clock on AGY:** ~612s on two failed lift attempts + heavy reliance on a worker that's now down.
4. **Blind spot (§1):** until aider/AGY usage is captured, these numbers lean on stdout scraping + estimates, not real telemetry.

---

## 6. Recommendations for budget mapping

- **Instrument first:** parse aider `Tokens:`/`Cost:` into receipt telemetry; decide if AGY is meterable. Without this, budget mapping is guesswork.
- **Treat Claude Max quota as the real constraint** (not $). Reserve big multi-agent workflows for when they earn it; the lift-plan workflow (273k) paid off, the polish-research (747k) was larger — judge ROI per fan-out.
- **GMI is your cheap metered escape hatch** — fine to lean on for focused work; the credit is safe.
- **Fix or retire AGY** — it's the least reliable link right now despite full quota.

> Caveats: CC main-loop + AGY token counts are **not instrumented** — figures are measured where the tooling allows (aider stdout, workflow telemetry) and flagged as estimates otherwise.
