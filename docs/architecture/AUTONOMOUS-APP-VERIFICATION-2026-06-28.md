# Autonomous Pre-Ship Verification Pipeline — Research (2026-06-28)

> How autonomous agents verify the Sully app surfaces before shipping a build. PLAN — not yet implemented.
> apple-node confirmed ready: Xcode 26.5, iOS 26.5 runtime, an iPhone 17 Pro sim already BOOTED, active GUI console session.

## SYNTHESIS — the pipeline

# Sully Pre-Ship Verification Pipeline — Plan for apple-node

The throughline across all four research outputs is the same: **the iOS accessibility tree, not a vision model, is the deterministic gate.** Build the ladder on apple-node's Simulator, assert on the a11y tree (AXe/`describe-ui`), and use vision/Whisper only as advisory judges for the orb and spoken audio. Only green-on-all promotes to `~/sully-ota/ship-build.sh`.

The single biggest enabler, named independently by R1, R2, and R3: **add `.accessibilityIdentifier(...)` to the SwiftUI surfaces** (ComposerView TextField + send button, MessageFeedView rows, voice-orb container). Without IDs every assertion is brittle coordinate-chasing. This is prerequisite work in our repo, not a tool install.

---

## 1. THE PIPELINE — the verification ladder (cheapest + highest-leverage first)

Each layer runs on apple-node via `xcodebuild`/`simctl`/`AXe`. Ordered so a fast failure kills the build before expensive layers run.

**Layer 0 — Build + launch-without-crash (seconds, free).** `xcodebuild build` then `simctl boot/install/launch`. Catches: compile breaks, crash-on-launch, missing assets. Setup: zero (already on apple-node). _Real history:_ would have caught any build-time regression in the b97→b109 churn before it ever shipped.

**Layer 1 — Logic/unit tests (ms, free).** Swift Testing + your existing ComposerViewTests/ChatCoordinatorTests via `xcodebuild test`. Optionally ViewInspector for "Send button wired to wrong action / composer binds wrong @State" (R2 layer 1). Catches: wiring bugs, coordinator state machine errors. _Real history:_ the **ack/result overlap** bug is a ChatCoordinator state-ordering bug — exactly a Swift Testing/ViewInspector assertion on coordinator output, catchable here with no rendering. (R2)

**Layer 2 — Preview + snapshot tests (seconds, cheap — HIGHEST visual leverage).** swift-snapshot-testing (pointfreeco) pixel-diffs MessageFeedView/ComposerView against committed PNG references; Prefire/SnapshotPreviews auto-snapshots every existing `#Preview` block for free (R2 layers 2-3, R4). Catches: shifted bubbles, clipped orb, wrong color, broken Dynamic-Type layout — "the exact 'looks wrong' class the operator currently screen-records" (R2). _Real history:_ the **composer-blank scroll bug** is a layout regression — a committed snapshot of ComposerView with keyboard up would have diffed red. **Pin one sim** (iPhone 16 Pro / iOS 26.5) and record references on apple-node so they match (R2 caveat: snapshots are device/OS/scale-sensitive). Agent reads the failure-diff PNG with the vision model.

**Layer 3 — XCUITest flow smoke (tens of seconds).** One thin `xcodebuild test` flow: launch → type into composer → tap Send (by accessibilityIdentifier) → assert new bubble row exists in MessageFeedView → open voice mode → assert orb container present (R2 layer 4, R4). Catches: navigation/flow breaks, "tapping Send does nothing," empty-state branch errors. _Real history:_ **composer-blank** also catchable here — bring up keyboard, assert composer field still hit-testable. **Gotcha (R4):** if a hardware keyboard is "connected" the sim hides the software keyboard and the test silently passes — force software keyboard via `simctl`/Toggle.

**Layer 4 — AXe-driven scripted flow + a11y assert (tens of seconds — the deterministic agent gate).** `axe describe-ui --udid <UDID>` returns the full a11y tree as JSON; agent asserts "send button enabled," "MessageFeedView has N rows," "orb present" with no vision (R1, R3 item 1). This is the layer the _agent_ drives ad-hoc (vs. checked-in XCUITest). Catches: the same flow bugs, but authorable on the fly by CC over ssh without recompiling a test target.

**Layer 5 — Screenshot → vision rubric (advisory only).** `simctl io booted screenshot` → ask vision model a structured-JSON rubric ("blank? overlapping? orb visible? text legible? {pass:bool, issues:[]}") (R3 item 2). Catches: aesthetic drift, blank/broken/overlapping states the tree can't express. **Advisory, never the hard gate** — practitioners report ~1-in-10 vision-judge calls is garbage, with order/position bias. Mitigate: feed a known-good baseline for diff-style judging, run 2-3x for self-consistency. **Do NOT use raw pixel-diff** — sim anti-aliasing floods false positives (R3).

**Layer 6 — recordVideo → claude-video-vision + Whisper (animation + spoken output).** `simctl io booted recordVideo orb.mp4` → your existing claude-video-vision plugin extracts frames + Whisper transcript. Xcode 15+ recordVideo captures sim audio by default (R3 item 3). Catches: orb animation state, **does the spoken reply actually play and say roughly X** — directly addresses read-aloud/voice-truncate regressions. _Real history:_ the **WAV crash / decodeWAV** path — a crash here surfaces as a launch/playback failure in the recording; the _perf_ aspect (main-thread stall) does NOT (see Limits).

| Layer              | Catches                    | Our real bug                 | Cost   |
| ------------------ | -------------------------- | ---------------------------- | ------ |
| 0 Build+launch     | crashes, asset breaks      | any b97-b109 build break     | free   |
| 1 Logic/unit       | wiring, coordinator state  | **ack/result overlap**       | free   |
| 2 Snapshot/Preview | layout/visual/color        | **composer-blank**           | cheap  |
| 3 XCUITest flow    | flow/nav breaks            | composer-blank (interaction) | medium |
| 4 AXe a11y assert  | agent-authored flow        | ad-hoc flow checks           | medium |
| 5 Vision rubric    | aesthetic/blank (advisory) | composer-blank visual        | medium |
| 6 Video+Whisper    | animation, spoken output   | **WAV crash** (crash only)   | higher |

---

## 2. WHAT TO SET UP FIRST — single highest-ROI this week

**Install AXe on apple-node and wire Layer 0+4 into one driveable script.** AXe is the raw primitive XcodeBuildMCP wraps, so over plain ssh you get the same power with no MCP daemon/plumbing (R1 ranks it #1; R3's MCPs need idb's fragile companion, which breaks on Xcode 26 — AXe has no daemon). It's purpose-built for AI agents and ships a Claude Code skill.

```bash
# on apple-node, one-time:
ssh apple-node 'brew install cameroncooke/axe/axe'   # or download release binary
ssh apple-node 'axe --version'

# the loop CC drives over ssh:
ssh apple-node 'xcrun simctl boot "iPhone 16 Pro"; \
  xcrun simctl install booted ~/build/Sully.app; \
  xcrun simctl launch booted com.logueos.Sully; \
  axe describe-ui --udid booted > /tmp/sully-tree.json; \
  xcrun simctl io booted screenshot /tmp/sully.png'
# then scp the JSON+PNG back; assert on tree, vision on PNG
```

Why AXe over the snapshot suite first, even though snapshot is the highest _visual_ leverage: AXe needs **zero in-repo code** to start returning value (it reads the live a11y tree of the app as-is), whereas snapshot tests require writing/recording references first. AXe gets the autonomous loop _running end-to-end this week_; snapshot tests are the parallel in-repo workstream (week 2).

**Blocker requiring operator (R4): apple-node must be auto-logged-in + caffeinated + have a display.** Apple-silicon Mac minis won't initialize a framebuffer headless — the Simulator renders wrong or `simctl boot` fails from a bare ssh shell. Fixes: enable auto-login for the build user, attach a **dummy HDMI plug** (or headless display adapter), keep a console session alive, and launch tests into the GUI domain (`launchctl asuser <uid>`) not the ssh session. This is a one-time operator setup and is the gate on everything else.

---

## 3. THE AGENT LOOP — concrete, before ship-build.sh

How CC (or a dispatched worker) runs it end-to-end on apple-node:

```
1. BUILD     ssh apple-node 'xcodebuild -scheme Sully -destination \
               "platform=iOS Simulator,name=iPhone 16 Pro,OS=26.5" build'
             → FAIL → stop, report, no ship.

2. TEST      ssh apple-node 'xcodebuild test -scheme Sully -destination ...'
             (Layers 1-3: unit + snapshot + XCUITest smoke)
             → any red → scp failure-diff PNGs back, vision-read them, report, no ship.

3. BOOT+INSTALL+LAUNCH   simctl boot / install / launch (Layer 0)
             → crash → stop.

4. DRIVE FLOW   axe tap --label "composer" ; axe type "hello" ;
                axe tap --label "send" (Layer 4)

5. ASSERT (HARD GATE)   axe describe-ui > tree.json
             → assert send-enabled, MessageFeedView row count grew, orb present.
             → fail → no ship.

6. VISION (ADVISORY)    simctl io booted screenshot → vision rubric JSON
             → issues[] non-empty → flag to operator, downgrade to "review", no auto-ship.

7. VOICE/ANIM (when touched)  simctl io recordVideo → claude-video-vision + Whisper
             → assert spoken reply played & transcript ~matches.

8. GATE      green on 1-5 (and 7 if voice) → ssh apple-node '~/sully-ota/ship-build.sh'
             else → Telegram the operator the failure + the diff PNG, hold the build.
```

This is the wrapper that goes _in front of_ `ship-build.sh`. The backend half is already covered — we routinely curl/SSE :18779, so STT/transport logic asserts there (R2, R3).

---

## 4. HONEST LIMITS — what STILL needs the operator's physical iPhone

The Simulator mic is the Mac's mic; the sim runs on fast Mac CPU/SSD; the sim has no haptics and Apple explicitly states it "does not simulate audio session behavior." So these are **irreducible** (R3, R4):

1. **Voice mode end-to-end** — AVAudioEngine/AVAudioSession activation timing, TTFA, route changes, interruptions (call/Bluetooth), echo/garble. The **voice main-thread hang** lives here. _Partial mitigation (R3):_ set BlackHole as a virtual **input** device on apple-node, play a known WAV in, assert the :18779 SSE transcript — this exercises the STT/backend path but NOT the real iPhone audio session.
2. **Real perf / hang behavior on A-series silicon** — the **NNN-ms HUD hang, decodeWAV disk roundtrip timing, thermals, frame drops.** The sim's fast SSD hides exactly these. The WAV _crash_ is catchable (Layer 6); the WAV _stall_ is not.
3. **Haptics** firing correctly — sim produces none.
4. **Push / badge / background** with a real APNs token (we have this disabled anyway per the killswitch).
5. **Camera/mic real capture quality.**
6. **Physical keyboard interplay, Dynamic Island, edge-swipe gestures** on real hardware.
7. **Final subjective "does it feel right" sign-off.**

Net: the pipeline pre-screens **layout/visual/logic/flow/crash + spoken-output + animation** — the majority of chat-surface regressions and the composer-blank/ack-overlap/WAV-crash class. It shrinks, does not eliminate, operator-on-device testing down to **genuine audio-runtime, perf, and hardware-sensory** behavior — i.e. the voice main-thread hang stays an operator smoke-pass.

---

## 5. RECOMMENDATIONS — ranked, shippable

1. **[NEEDS OPERATOR] Make apple-node a headless test host.** Auto-login for the build user, attach a dummy HDMI/display adapter, `caffeinate`, confirm `simctl boot` works from ssh into the GUI domain. One-time; gates everything. (R4) — _This is the only hard operator dependency; flag it first._
2. **[CC, this week] Install AXe + stand up the build→boot→a11y-assert→screenshot loop** as a single ssh-driven script in sully-backend's repo tooling (or a new `~/sully-ota/preflight.sh` on apple-node, sibling to ship-build.sh). Driveable by CC and dispatched workers. (R1, R3)
3. **[CC, repo work, parallel] Add `.accessibilityIdentifier(...)` to ComposerView (field + send), MessageFeedView rows, and the voice-orb container.** Prerequisite for reliable AXe/XCUITest assertions — without it every layer is brittle. (R1/R2/R3 unanimous)
4. **[CC, week 2] Add swift-snapshot-testing + Prefire**, pin iPhone 16 Pro/iOS 26.5, record references on apple-node, run as a required `xcodebuild test` gate. Highest _visual_ leverage; would have caught composer-blank. (R2, R4)
5. **[CC, defer] Wrap ship-build.sh with the PASS/FAIL gate** so a red preflight Telegrams the operator the diff PNG and _holds_ the build instead of shipping. The actual bottleneck-breaker — only build after layers 2-4 exist. Optional later: XcodeBuildMCP as MCP tools if we want LLM-native ergonomics, but AXe-over-ssh is lower-friction and avoids idb's Xcode-26 fragility. (R1, R3)

Skip: idb/ios-simulator-mcp (idb companion breaks on Xcode 26 — R1/R3), raw pixel-diff (sim AA false positives — R3), Appium/cloud device farms (single-target, our operator's phone is the device-farm-of-one — R1/R4), vision-as-primary-gate (~1-in-10 unreliable — R3).

Relevant paths: `~/sully-ota/ship-build.sh` (existing, on apple-node — wrap it), proposed `~/sully-ota/preflight.sh` (new gate), sully-backend `:18779` (existing backend assertion surface, already curl/SSE-tested).

---

## Appendix: raw research

### Sim automation

# iOS Simulator Automation for an Autonomous Agent (Sully on apple-node)

**Bottom line:** the modern stack is **AXe (raw CLI) + simctl** as the ssh-drivable primitive, optionally wrapped by **XcodeBuildMCP** when you want LLM-native tools. idb still works but Meta has deprioritized it and its companion daemon is fragile on Xcode 26. All of these run on the simulator on apple-node; no physical device needed.

## Ranked by fit for an agent driving `ssh apple-node`

### 1. AXe (cameroncooke/AXe) — best raw primitive ⭐

Standalone single binary, **no daemon, no client/server**, uses Apple's private accessibility APIs. This is exactly what XcodeBuildMCP wraps, so over plain ssh you get the same power without MCP plumbing.

- `axe describe-ui --udid <UDID>` → JSON accessibility tree (labels + frames) — your "DOM" for assertions without vision.
- `axe tap --label "Send"` / `axe tap -x 200 -y 640`, `axe type "hello"`, `axe swipe`, `axe screenshot out.png`, batch-chaining for multi-step flows.
- Ships an agent skill: `axe init` installs a Claude Code skill. Setup: one `brew`/release download on the Mac mini. Active (2025-2026), purpose-built for AI agents. Simulator-only.

### 2. xcrun simctl — the boot/install/launch backbone (always needed)

Built into Xcode, zero setup. Does lifecycle + capture but **cannot tap/gesture or dump the a11y tree**.

- `xcrun simctl boot "iPhone 16 Pro"` · `xcrun simctl install booted Sully.app` · `xcrun simctl launch booted com.logueos.Sully`
- `xcrun simctl io booted screenshot out.png` · `xcrun simctl io booted recordVideo out.mp4` (feed to your claude-video-vision plugin)
- `xcrun simctl ui booted appearance dark` for light/dark + dynamic-type runs. Pair with AXe/idb for input.

### 3. XcodeBuildMCP (now under getsentry, formerly cameroncooke) — richest LLM ergonomics

Single package, MCP server + CLI. Exposes discover/build/install/launch, `screenshot`, `describe_ui` (a11y tree JSON), and `tap/swipe/type/gesture/key` (via bundled AXe). Best if you run it **on apple-node** and connect over an MCP stdio transport, or use its CLI mode. Sentry-backed = the most actively maintained option. `npx -y xcodebuildmcp`. Simulator + device.

### 4. ios-simulator-mcp (joshuayoes) — lighter MCP, but needs idb

MCP wrapper exposing tap/swipe/type/screenshot/record + `ui_describe_all`. Thin layer over **idb**, so it inherits idb's companion install. `npx ios-simulator-mcp`. Use only if you've standardized on idb; otherwise XcodeBuildMCP/AXe is less brittle. Simulator-focused.

### 5. idb / fb-idb (facebook/idb) — mature but waning

Python client `pip install fb-idb` + `idb_companion` daemon (`brew install idb-companion`). Real gesture/text/key support and `idb ui describe-all` / `describe-point` (a11y tree). Daemon mode (`idb_companion --udid …`) is genuinely agent-drivable over ssh. **Caveat:** Meta has deprioritized it; open issues pile up and companion compilation breaks on newer Xcode/macOS. Works on simulator and device. Treat as fallback, not foundation.

### 6. Maestro (mobile-dev-inc) — best for saved regression flows

Declarative YAML (`launchApp`, `tapOn`, `assertVisible`), auto-detects the booted sim (no driver server to start), single-binary install, and an **official MCP server** for agents. Agent writes/edits flows, then `maestro test sully_chat.yaml` over ssh. Uses WebDriverAgent/XCUITest underneath. Ideal for a checked-in suite that gates a build before OTA. Sim + device.

### 7. Appium + WebDriverAgent — heaviest, last resort

Full WebDriver/XCUITest, maximal flexibility, but a server + WDA build + capabilities config. Overkill versus AXe/Maestro for your headless-verify goal. Sim + device.

## The accessibility tree as the agent's DOM

`axe describe-ui` (or `idb ui describe-all`) returns every element with `AXLabel`/identifier + frame as JSON — assert "Send button visible," "message row contains X," "voice orb present" **without a vision model**. To make this reliable, add `.accessibilityIdentifier(...)` to your SwiftUI surfaces (ComposerView TextField + send button, MessageFeedView rows, the voice-orb container). Then the agent taps by label/id, not brittle coordinates. Use screenshots/video + vision only for the orb's visual/animation state, where the tree can't help.

## Recommended setup for Sully

On apple-node: `xcrun simctl` (have it) + **AXe** (one install) as the core; layer **Maestro** for a checked-in pre-ship regression suite; reach for **XcodeBuildMCP** if you want it as MCP tools. Loop: `simctl boot/install/launch` → `axe describe-ui`/`tap`/`type` to exercise chat + voice → `simctl io … screenshot`/`recordVideo` → assert on tree, vision only for the orb — all before the OTA build hits the operator's iPhone.

Sources:

- [cameroncooke/AXe](https://github.com/cameroncooke/AXe) · [axe-cli.com](https://www.axe-cli.com/) · [AXe AGENTS.md](https://github.com/cameroncooke/AXe/blob/main/AGENTS.md)
- [getsentry/XcodeBuildMCP](https://github.com/cameroncooke/XcodeBuildMCP) · [xcodebuildmcp.com](https://www.xcodebuildmcp.com/)
- [joshuayoes/ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp) · [setup guide 2026](https://mcp.directory/blog/ios-simulator-mcp-complete-guide-2026)
- [facebook/idb](https://github.com/facebook/idb) · [fbidb.io](https://fbidb.io/) · [fb-idb on PyPI](https://pypi.org/project/fb-idb/)
- [mobile-dev-inc/Maestro](https://github.com/mobile-dev-inc/maestro) · [maestro.dev](https://maestro.dev/)
- [vermont42/ios-build-verify (AXe+xcodebuild reference rig)](https://github.com/vermont42/ios-build-verify)

### SwiftUI test frameworks

# SwiftUI Test Frameworks That Catch Regressions Headlessly (apple-node)

All of these run on the iOS Simulator via `xcodebuild test` on apple-node — no physical iPhone. An agent can author and run them over `ssh apple-node`. Map each layer to the bug class it catches.

## The layers, by bug class

**1. ViewInspector (logic / wiring bugs) — unit speed, no rendering.**
Uses Swift reflection to traverse the SwiftUI struct hierarchy at runtime: read a `Text`'s string/font, find a view by accessibility ID, trigger a button's action or a row's `onAppear`, and reach into your view model. Catches "the Send button is wired to the wrong action," "composer binds the wrong @State," "empty-feed branch renders the wrong subtree." Cannot verify pixels, layout geometry, or anything async-rendered. Caveat: Swift 6 / Xcode 16 inserts implicit `AnyView`, which shifted some hierarchies — inspection paths can break on toolchain bumps. ([nalexn/ViewInspector](https://github.com/nalexn/ViewInspector), [nalexn.github.io](https://nalexn.github.io/swiftui-unit-testing/))

**2. swift-snapshot-testing / pointfreeco (visual + layout regressions) — deterministic image diff.**
Renders a SwiftUI view to a PNG and compares to a committed reference; on mismatch the test fails and attaches the diff as an XCTest attachment. `record` mode (or `isRecording`) regenerates references. This is your highest-value layer for MessageFeedView/ComposerView: it catches a shifted bubble, a clipped orb, a wrong color, a broken Dynamic-Type layout — the exact "looks wrong" class the operator currently screen-records. Honest caveats: snapshots are **device/OS/scale-sensitive** — pin one simulator (e.g. iPhone 15, iOS 26.5) and record on apple-node so references match CI; font/AA rendering drift across Xcode versions causes false failures. ([pointfreeco/swift-snapshot-testing](https://github.com/pointfreeco/swift-snapshot-testing), [here-be-dragons](https://davidbrunow.github.io/brunow.org/documentation/brunow/10-21-here-be-dragons-snapshot-testing-edition/))

**3. Preview-driven snapshots — SnapshotPreviews (EmergeTools/Sentry) + Prefire (free smoke coverage of every `#Preview`).**
These auto-generate snapshots from your existing `#Preview` blocks via an XCTest, writing PNGs to `TEST_RUNNER_SNAPSHOTS_EXPORT_DIR`, and run accessibility audits — no per-view test code. Prefire shares config between Preview and the snapshot test. Cheapest path given you already have `#Preview` blocks: every preview becomes a "does it crash / did it visually change" gate. `PreviewLayoutTest` validates previews don't crash without even emitting PNGs (fast). ([EmergeTools/SnapshotPreviews](https://github.com/EmergeTools/SnapshotPreviews), [BarredEwe/Prefire](https://github.com/BarredEwe/Prefire), [emergetools.com](https://www.emergetools.com/blog/posts/unit-test-xcode-previews))

**4. XCUITest (flow / interaction bugs) — full app on the simulator.**
Launches the app and drives it by accessibility identifier: type into the composer, tap Send, assert the new bubble exists, open voice mode, assert the orb view appears. Catches navigation/flow breaks and "tapping X does nothing." It's the only headless layer that exercises the real app process. Slower and flakier; needs explicit waits. This is XCTest-only and stays so — see below. Your existing ComposerViewTests/ChatCoordinatorTests live here. ([Apple XCTest](https://developer.apple.com/documentation/xctest))

**5. Swift Testing vs XCTest — framework choice, not a new capability.**
Swift Testing (bundled Xcode 16+, Swift 6) is the modern default for **unit/integration** logic tests (`@Test`, `#expect`, parametrized). But it explicitly does **not** cover UI automation or `measure{}` performance — **XCUITest stays in XCTest indefinitely**, and both coexist in one target. So: author logic tests in Swift Testing, keep flow tests in XCUITest. ([blakecrosley](https://blakecrosley.com/blog/swift-testing-vs-xctest), [micoach](https://blog.micoach.itj.com/swift-testing-vs-xctest))

**Accessibility identifiers are the enabler.** XCUITest queries and ViewInspector lookups both resolve by `.accessibilityIdentifier(...)`. Without disciplined IDs on composer field, send button, message rows, and the orb, every flow/logic assertion becomes brittle index-chasing. Add IDs first; it also feeds the free accessibility audits in layer 3.

## What this stack MISSES (the bugs you actually hit b97→b109)

The simulator does not reproduce: **real on-device keyboard** behavior (frame, autocorrect, safe-area shove), **momentum scroll / scroll-position** bugs, haptics, and — critically for Sully — **AVAudioEngine, mic capture, and the WebSocket STT round-trip**. Voice-mode TTFA timing, audio glitches, the particle orb's real-time animation under load, and "she cuts me off mid-sentence" are **out of scope** for all five layers — those need a real device or a backend-level harness (you already curl/SSE the :18779 backend, which is the right place to assert STT/transport logic). Net: this stack pre-screens layout/visual/logic/flow regressions before OTA, shrinking — not eliminating — operator-on-device verification to genuine audio/hardware behavior.

**Recommended on apple-node:** snapshot-testing (layer 2) + Preview auto-snapshots (layer 3) as the visual gate, ViewInspector/Swift Testing for logic, a thin XCUITest send-message smoke for flow — all via `xcodebuild test -destination 'platform=iOS Simulator,name=iPhone 15,OS=26.5'`. Agents read the failure-diff PNGs with the vision model.

Sources: [pointfreeco/swift-snapshot-testing](https://github.com/pointfreeco/swift-snapshot-testing), [nalexn/ViewInspector](https://github.com/nalexn/ViewInspector), [EmergeTools/SnapshotPreviews](https://github.com/EmergeTools/SnapshotPreviews), [BarredEwe/Prefire](https://github.com/BarredEwe/Prefire), [Swift Testing vs XCTest (Crosley)](https://blakecrosley.com/blog/swift-testing-vs-xctest), [Apple XCTest docs](https://developer.apple.com/documentation/xctest).

### Vision/agent verification

STACK-GROUNDED RESEARCH: Autonomous UI verification for Sully before OTA-shipping to the operator's iPhone.

Bottom line: build the loop on apple-node's Simulator with an accessibility-tree-first MCP as the deterministic gate, and use the vision model only as a secondary "does it look right" judge. Do NOT make a vision model the primary pass/fail — it's ~1-in-10 unreliable.

RANKED BY FIT FOR YOUR "ssh apple-node + vision model" SETUP

1. ios-simulator-mcp / mobile-mcp on apple-node (BEST FIT). Both are real, maintained stdio MCP servers that drive a booted Simulator: tap/swipe/type, screenshot, record, and crucially read the iOS accessibility tree (via idb). [joshuayoes/ios-simulator-mcp](https://www.npmjs.com/package/ios-simulator-mcp), [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp). Run one on apple-node; Claude Code reaches it over SSH (or as a remote MCP). The accessibility snapshot is the win: assert "ComposerView text field present", "send button enabled", "MessageFeedView has N rows" deterministically — no vision, no hallucination. mobile-mcp explicitly falls back to screenshot-coordinates only when a11y labels are missing. This is the playwright-mcp equivalent for iOS and is your highest-confidence layer. Pair with `conorluddy/ios-simulator-skill` (21 xcodebuild/launch/log scripts) so the agent can build → boot → launch autonomously. [littlemight write-up](https://www.littlemight.com/claude-code-ios-simulator-testing/).

2. Scripted flow → simctl screenshots → vision-as-judge (your verification gate). Drive a fixed flow (open chat, send "hello", wait for stream) via the MCP or an existing XCUITest, capture `xcrun simctl io booted screenshot`, then ask Claude/GPT-4o vision a RUBRIC question with a structured-JSON verdict ("blank? overlapping? orb visible? text legible? {pass:bool, issues:[]}"). Vision is genuinely good at catching blank/broken/overlapping/cut-off states and aesthetic drift that assertions miss ([Drizz 2026](https://www.drizz.dev/post/mobile-visual-regression-testing-in-2026-why-vision-ai-catches-what-script-based-tools-miss), [Grizzly Peak](https://www.grizzlypeaksoftware.com/articles/p/multimodal-ai-wins-using-vision-models-to-debug-ui-screenshots-automatically-Xvk1dF)). It is unreliable at exact pixel/spacing/color claims (hallucinates values, position bias). Honest numbers: practitioners report ~1 in 10 judge calls is "garbage," and LLM-judges show order/position bias ([Monte Carlo](https://montecarlo.ai/blog-llm-as-judge/), [Confident AI](https://www.confident-ai.com/blog/llm-evaluation-metrics-everything-you-need-for-llm-evaluation)). Mitigate: (a) keep a11y assertions as the hard gate, vision only as advisory/aesthetic; (b) self-consistency — run the judge 2-3x or swap baseline/candidate order and require agreement; (c) feed a known-good baseline screenshot for diff-style judging, not absolute judging. Pixel-diff tools (no LLM) are NOT recommended here — anti-aliasing/font-smoothing on Simulator floods false positives.

3. claude-video-vision on `simctl io booted recordVideo` (for animation + voice output). You already have this. Record the orb/particle animation and spoken-reply playback, extract frames + Whisper transcript. Xcode 15+ `recordVideo` captures Simulator audio by default ([Screenify](https://www.screenify.studio/blog/2026-04-19-record-xcode-simulator)); pre-15 needs BlackHole loopback. So the agent CAN verify "spoken reply audio actually played and said roughly X" by Whisper-transcribing the recording — directly addresses your read-aloud/voice-truncate regressions.

4. Computer-use / CUA GUI agents (Claude computer-use, OpenAI CUA, Mobile-Agent/AppAgent) — LOWEST fit for verification. They're exploratory screenshot-coordinate drivers, slower and flakier than a scripted flow + a11y assertions. Use them only for unscripted "poke around and find anything broken" passes, never as the ship gate.

THE HARD ONE — VOICE/STT INPUT (be honest)

- Output (does audio play / what did it say): SOLVABLE on Simulator — recordVideo audio → Whisper. Good confidence.
- Input (does AVAudioEngine→WebSocket STT actually work): the Simulator mic is the Mac's mic. To inject a known WAV you must set a virtual input device (BlackHole as INPUT) on apple-node and play the clip into it, then assert the backend's :18779 SSE/transcript. Fiddly but agent-scriptable. CAVEAT: this exercises your STT/backend path, NOT real iPhone audio-session/route/interruption behavior. True end-to-end voice confidence (AVAudioSession category switches, talkback echo, real-mic VAD) still needs a real device — keep one operator smoke-pass for voice-mode only, but chat/layout/animation/read-aloud can all gate autonomously on apple-node.

RECOMMENDED BUILD: apple-node runs Simulator + ios-simulator-mcp; CC over SSH does build→boot→launch→a11y-assert (hard gate)→screenshot+vision-rubric (advisory)→recordVideo+Whisper (voice/animation). Only green-on-all promotes to `ship-build.sh`.

Sources inline above.

### CI limits / real teams

How real teams do autonomous/CI iOS UI verification — grounded in your stack (apple-node M1 sim host, Sully SwiftUI, sully-backend).

## The standard pattern: the iOS test pyramid in CI

Real teams gate every build with a layered suite run via `xcodebuild test` (or Fastlane `scan`, a 100%-xcodebuild wrapper) on a simulator, on a macOS runner — GitHub Actions `macos-latest`, Xcode Cloud, or a self-hosted Mac (your apple-node) ([Fastlane scan](https://docs.fastlane.tools/actions/scan/); [Bright Inventions 2025](https://brightinventions.pl/blog/ios-build-run-tests-github-actions/); [Quality Coding](https://qualitycoding.org/github-actions-ci-xcode/)). Layers, cheapest→costliest:

1. **Unit tests** (your ComposerViewTests, ChatCoordinatorTests) — pure logic, milliseconds.
2. **Snapshot tests** — pointfreeco/swift-snapshot-testing renders a view and pixel-diffs against a committed reference; the dominant way teams catch layout regressions without a human, run as a required CI gate ([swift-snapshot-testing](https://github.com/pointfreeco/swift-snapshot-testing); [Bitrise](https://bitrise.io/blog/post/snapshot-testing-in-ios-testing-the-ui-and-beyond)).
3. **XCUITest** — drives the real app on a booted sim (tap composer, type, send, assert the row lands in MessageFeedView), captures screenshots (Fastlane `snapshot`) ([WillowTree](https://willowtree.engineering/2023/02/14/how-to-use-swift-snapshot-testing-for-xcuitest/)).
4. **Manual / real-device** — the top, smallest, irreducible layer.

Your agent extension: after XCUITest, pipe `xcrun simctl io screenshot` + the accessibility tree into your vision model to read each screen for regressions ("composer empty?", "orb visible?") — this is the autonomous pre-ship check you want, and it runs entirely on apple-node with no operator.

## Headless-over-SSH gotchas (apple-node M1)

Simulators need a **logged-in Aqua/window-server session** — `simctl boot` + UI tests fail from a bare SSH shell. Fixes real teams use: enable **auto-login** for the build user, keep a console session alive, and launch tests into the GUI domain (`launchctl asuser <uid>` / load into `gui/<UID>`) rather than the SSH session ([Jeff Geerling](https://www.jeffgeerling.com/blog/2020/setting-mac-mini-macstadium-headless-ci/); [Apple Forums 765060](https://developer.apple.com/forums/thread/765060)). Apple-silicon Mac minis **won't initialize a framebuffer without a display** — attach a dummy HDMI plug or headless GPU emulates won't render correctly ([Apple Forums 737381](https://developer.apple.com/forums/thread/737381)). Keychain/codesign also need that login session ([VPSMAC 2026](https://vpsmac.com/en/blog/mac-cloud-ios-ci-signing-keychain-headless-xcodebuild-2026.html)). Net: get apple-node auto-logged-in + caffeinated once, then everything is `ssh`-drivable.

## What the simulator CANNOT reproduce — mapped to YOUR bugs

- **Composer-blank (keyboard + safeAreaInset/scroll): WOULD likely be caught.** The sim renders the software keyboard and SwiftUI keyboard avoidance, so an XCUITest that brings up the keyboard and snapshots the composer reproduces safe-area/scroll layout. **Gotcha:** if a hardware keyboard is "connected," the sim hides the software keyboard — your test must force it (`simctl`/Toggle Software Keyboard) or it silently passes.
- **Voice hang (AVAudioEngine + AVAudioSession activation timing): WOULD NOT be caught.** Apple states the Simulator "does not simulate session behavior… to test your audio session code, run on a device," and can't reproduce route changes, interruptions, or mixing ([Apple Audio Session Guide](https://developer.apple.com/library/archive/documentation/Audio/Conceptual/AudioSessionProgrammingGuide/OptimizingForDeviceHardware/OptimizingForDeviceHardware.html)). Activation-timing/CoreAudio-HAL bugs are real-device-only.
- **The "NNN ms HUD" hang / decodeWAV disk roundtrip: WOULD NOT be reliably caught.** The sim runs on the Mac's fast CPU/SSD, so main-thread stalls, thermals, and A-series perf hangs hide. Real-device only.
- **Haptics, push tokens, camera/mic capture: real device.** Sim produces no haptics; remote-push is partially simulatable (Xcode 14+ `simctl push`) but tokens/background behavior need a device ([SwiftLee](https://www.avanderlee.com/workflow/testing-push-notifications-ios-simulator/)).

Cloud farms (BrowserStack/Sauce/AWS Device Farm) give real devices but solve the _fleet/OS-matrix_ problem — irrelevant to you (single iOS 26.5 target, one operator iPhone). Your operator's phone IS your device-farm-of-one.

## Realistic division of labor

**Agents verify autonomously on apple-node (pre-ship gate):** build success; unit + snapshot + XCUITest; screenshot→vision review of chat surface and orb static states; navigation/empty-state/crash-on-launch; accessibility assertions; backend SSE (already curl-tested). This catches the _majority_ of your chat-surface regressions before any OTA.
**Operator's device remains required for:** anything audio-runtime, perf, or hardware-sensory.

## Irreducible "still needs the operator's device" list

1. Voice mode end-to-end: AVAudioEngine/AVAudioSession activation timing, TTFA, route changes, interruptions (call/Bluetooth), echo/garble.
2. Real performance/hang behavior on A-series silicon (the NNN-ms HUD, thermals, frame drops, decode roundtrips).
3. Haptics firing correctly.
4. Push notification delivery + background/badge behavior (real APNs token).
5. Camera/microphone real capture quality.
6. Physical on-screen-keyboard interplay edge cases, Dynamic Island/gesture/edge-swipe on real hardware.
7. Final subjective "does it feel right" UX sign-off.

Everything else is automatable on apple-node today.
