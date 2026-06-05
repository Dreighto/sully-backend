# Sully QOL + Notifications + SDK + Artifacts — Prioritized Research Report

Date: 2026-06-04
Author: CC (VP Ops)
Repo: LogueOS-Companion
Scope: four investigations folded into one prioritized plan — (1) the notification deep-link bug, (2) chat-app QOL borrows, (3) artifact preview/download, (4) Vercel AI SDK borrows.

---

## Plain English (read this first)

**The notification bug — found it, it's a small fix.** When a task finishes and you get a "task done" buzz, tapping it dumps you into a brand-new empty chat instead of the conversation with your result. Reason: the notification carries a generic link (`/companion/chat`) with no thread attached, and the app — by design — opens a fresh thread when no thread is named. The synthesis message is sitting in the right thread; the notification just never tells the app which one. The whole "open the right thread" machinery already exists and works; it's simply never handed the thread id. Fix is two one-line changes at the two places that build the notification — stick the thread id into the link. I verified all the file/line claims against the live code; they're correct. This is a quick, high-value win.

**Top QOL wins (cheapest, highest daily value):**

1. Deep-linked "task done" notification that opens the exact conversation (the fix above).
2. A "needs a decision" notification (not just "done") so you can approve a blocked dispatch from your phone — like Claude Code mobile does.
3. Approve / Not-now (and a quick text reply) buttons right on the lock-screen notification — approve a dispatch without opening the app.
4. Pin + rename + search your threads, plus reopening a thread lands you where you left off (scroll position / last unread).
5. A clearable badge on the app icon = "how many finished tasks are waiting for you."

**Artifacts (when a worker builds you a file/dashboard):** yes, a Claude-Artifacts-style "preview + download" panel is very buildable on your stack. Ship a small slice first — a side panel (full-screen sheet on the phone) that shows images, formatted markdown, and code-with-a-copy-button, plus single-file download. The one decision that matters for safety: when you later want to _run_ generated web pages live, serve them from a separate web address (e.g. `artifacts.<your-tailnet>`) so untrusted code can't touch Sully. Copy-to-clipboard works everywhere and should be the default button.

**Vercel AI SDK borrows (the toolkit your chat already uses):** three things map straight onto problems you have. (a) "Custom data parts" let the server stream a live Task card / artifact preview into a message that updates in place — this kills the stuck-timer / raw-event-leak bug class. (b) One trivial setting (`experimental_throttle`) makes streaming smoother and easier on the phone's battery. (c) "Resumable streams" fix the "reload drops my in-progress reply" problem — but that one needs a new piece of infrastructure (Redis) so it's later, not now.

**Recommended order:** do the notification fix first (hours, big felt improvement), then the cheap QOL batch (pin/rename/search, scroll-restore, badge, grouping), then fold artifact preview + the SDK data-parts work into Phase 5 (workspace + write-tool). Save resumable streams and live-HTML artifact execution for last — they carry real new infrastructure cost.

---

## 1. The notification deep-link bug

### Root cause (verified against live code 2026-06-04)

The completion push payload never carries the thread id, so a tap always opens the generic landing — which by design mints a brand-new thread.

**Send site A — `src/lib/server/completionClose.ts:131-136`:**

```ts
const pushPayload = {
	title: outcome === 'done' ? 'Sully — task done' : 'Sully — task needs you',
	body: outcome === 'done' ? 'Your task finished. Tap to see the result.' : 'A task hit a snag.',
	url: appIdentity.pushDefaultUrl // <-- static '/companion/chat', no thread
};
```

`appIdentity.pushDefaultUrl` is the constant `'/companion/chat'` (`src/lib/server/config.ts:213`). The originating thread is in scope the whole time — `const threadId = resolveCompletionThread(job?.thread_id)` at `completionClose.ts:40`, the same `threadId` the synthesis message is posted into — but it's never put in the URL.

**Send site B — `src/lib/server/completion_poller.ts:58-62`:** identical defect. The entry's `thread_id` is null-checked at line 54 (`if (!entry.thread_id) continue;`) and is in scope, but line 61 still sends `url: appIdentity.pushDefaultUrl`.

**Why a tap lands on a NEW thread (the receiving half) — `src/routes/chat/+page.server.ts:90-93`:**

```ts
const queryThread = url.searchParams.get('thread')?.trim();
const thread = queryThread || freshThreadId();
const messages = getChatMessages(100, thread);
```

The app fully supports `?thread=<id>` deep links and reads them on cold load. The comment at lines 77-81 documents that a bare open with no `?thread=` _deliberately_ mints a fresh thread (ChatGPT-style). The native tap navigates to `/companion/chat` with no query string → `queryThread` empty → `freshThreadId()` → new thread. The deep-link plumbing is present and working; it's just never handed a thread id.

**The tap handlers are correct — they read and route a `url`, they're just fed a thread-less one:**

- Native (Capacitor): `src/lib/native/push.ts:58-67` reads `action.notification.data.url` and `window.location.assign(url)`. On iOS the Capacitor push plugin copies the APNs `userInfo` keys into `notification.data`, so the root-level `url` set in `apns.ts:140` does reach `data.url`. Wiring sound; value is just `/companion/chat`.
- Web push SW: `src/service-worker.ts:82-85` `notificationclick` reads `event.notification.data.url` and `clients.openWindow(...)`.

### The fix (proposal — do not implement here)

The chain already round-trips a `url`; it just needs to carry the thread. Two coordinated one-line changes plus a sanity check:

1. **`completionClose.ts:135`** — change `url: appIdentity.pushDefaultUrl` to a thread deep link from the in-scope `threadId`:
   `url: `${appIdentity.pushDefaultUrl}?thread=${encodeURIComponent(threadId)}``For the`'default'`fallback (The Den) this still lands correctly —`resolveCompletionThread`returns`'default'`when`job.thread_id` is empty (`completionClose.ts:19-21`), and `+page.server.ts`honors`?thread=default`.
2. **`completion_poller.ts:61`** — same, using `entry.thread_id` (already null-checked at line 54):
   `url: `${appIdentity.pushDefaultUrl}?thread=${encodeURIComponent(entry.thread_id)}``
3. **No change to senders or load logic.** `apns.ts:138-141` already forwards `url` at root (Capacitor maps it into `notification.data.url`); `web_push.ts:140` already nests it as `data.url`; `+page.server.ts:91` already reads `?thread=`. They transparently carry the new query-string URL. Quick sanity check that `?thread=` survives APNs JSON intact (it will — plain string value).

### Caveats / related gaps (from the investigation, worth knowing)

- **Deep links are query-based, not path-based.** There is no `/companion/thread/<id>` route; selection is purely `?thread=<id>` on `/companion/chat`. The fix must use the query form to match `+page.server.ts:91`.
- **Two URL forms coexist (both fine for their context):** `syncUrlThread` (`+page.svelte:68-74`) writes the URL via `replaceState(resolve('/chat') + '?thread=...')` using base-relative `/chat`, while the push uses absolute `/companion/chat` (needed by `window.location.assign` / `openWindow`).
- **Native warm-start edge case:** `push.ts:58-67` uses `window.location.assign(url)` — a full document navigation. If the app is already foregrounded this hard-reloads rather than client-side `goto()`. Acceptable for the fix (the operator's reported symptom is the cold-launch path, which the server load fully handles). Follow-up could switch to SvelteKit `goto()` when already booted.

---

## 2. QOL improvements — prioritized

Difficulty: **S** = config/UI on existing infra · **M** = new server + client glue · **L** = native iOS work.

| Pattern                                                 | What it does                                                                                            | Why it helps a daily-driver companion                                                                 | Difficulty                                                                                   | Borrow                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------- |
| Deep-linked "task done" push → exact thread             | Tap opens the finished task's conversation, not a fresh chat                                            | Eliminates the "where's my result" hunt that makes async dispatch feel broken                         | S–M (this is the §1 fix)                                                                     | **Now**                             |
| "Needs a decision" push (not just "done")               | Push when a worker blocks on approval, deep-linked to the decision                                      | Unblocks long dispatches without babysitting tmux — mirrors Claude Code mobile                        | S–M (decide() Talk/Ask/Dispatch + Run/Not-now already exist; wire blocked-state → push)      | **Now/soon**                        |
| Lock-screen Approve / Not-now (+ text reply)            | `UNNotificationAction` buttons + `UNTextInputNotificationAction`; read `actionIdentifier`/`userText`    | Approve a dispatch from the phone without opening the app — biggest hands-off win for a solo operator | M–L (native: register category, payload category-id, handle response, round-trip to gateway) | **Soon**                            |
| Pin + rename + search threads                           | Pin live lane, rename on value, full-history search                                                     | Solo operator returns to recurring lanes constantly                                                   | S (DB columns + sidebar UI; `chat_thread_meta` already exists)                               | **Now**                             |
| Scroll-restore / last-unread on reopen                  | Persist scroll + last-read per thread                                                                   | Resume mid-thought instead of re-orienting                                                            | S (persist per thread; turn_replay anchors it)                                               | **Now**                             |
| Badge = unseen finished tasks, tied to in-app inbox     | APNs badge field; clears on view                                                                        | At-a-glance "is anything waiting on me" without noise                                                 | S–M (APNs badge + a Tasks inbox view; keep low/clearable)                                    | **Now/soon**                        |
| Notification grouping by thread (`thread-id`)           | Five worker pings collapse into one stack                                                               | Less buzz, clearer signal                                                                             | S (set thread-id on APNs payload)                                                            | **Now/soon**                        |
| Pulse-style "since you were away" cards                 | Finite (5–10) swipeable digest of overnight worker output, with a deliberate "that's it for today" stop | Perfect fit for an overnight-dispatching companion; matches the propose→confirm→card→synthesis loop   | M (synthesis job + card UI; Haiku synth already in stack)                                    | **Later (standout differentiator)** |
| Edit-forks-thread + regenerate + branch toggle          | Explore alternatives without trashing the original                                                      | Iterate safely                                                                                        | M (branch data model + arrow nav)                                                            | **Later**                           |
| Rewind / checkpoint (conversation and/or worker-action) | Undo a bad turn or worker edit cleanly                                                                  | Recover from mistakes                                                                                 | M–L (build on turn_replay forensics)                                                         | **Later**                           |
| Resumable streaming (leapfrog)                          | Persist last-received token; replay + resume on reconnect                                               | A flaky-phone companion feels markedly more solid — the big three do NOT solve this                   | M–L                                                                                          | **Later**                           |

**Architecture flag (read before building any notification work):** Sully ships **both** a SvelteKit PWA and a Capacitor iOS shell, and they have opposite notification realities.

- **Web Push does NOT work inside the Capacitor/WKWebView shell** (no Service Worker / Push API). The reliable on-phone channel is **native APNs**, which is already shipped (memory `project_sully_apns_push`, build 15). Treat PWA Web Push as the desktop-browser / installed-PWA fallback only — do NOT harden it for the on-phone experience.
- iOS PWA Web Push is fragile even where it works: home-screen-installed only (iOS 16.4+, non-EU), needs `event.waitUntil()` wrapping or iOS kills the sub after ~3 pushes, subs expire in 1–2 weeks. Safari 18.4 added Declarative Web Push (simpler, more reliable) but it does not widen reach. These match existing canon (`ios_webpush_gotchas`, `pwa-push-dispatcher`); this research confirms them as current 2026 truth.

Sources: deep links — [customer.io](https://docs.customer.io/integrations/sdk/ios/push/deep-links/), [Braze](https://www.braze.com/docs/developer_guide/push_notifications/deep_linking). Actionable notifications — [Apple UNTextInputNotificationAction](https://developer.apple.com/documentation/usernotifications/untextinputnotificationaction), [Hacking with Swift](https://www.hackingwithswift.com/read/21/3/acting-on-responses). Decision-push analog — [Joe Njenga / Claude Code mobile](https://medium.com/@joe.njenga/how-im-using-new-claude-code-mobile-push-notifications-for-hands-off-coding-79fa924709ae). Pulse — [OpenAI Introducing Pulse](https://openai.com/index/introducing-chatgpt-pulse/). Threads — [Gemini Apps Help](https://support.google.com/gemini/answer/13666746), [NexaSphere 2026](https://nexasphere.io/blog/organize-ai-conversations-chatgpt-claude-gemini-2026). Badges/grouping — [Apple HIG Notifications](https://developer.apple.com/design/human-interface-guidelines/notifications), [WillowTree badge best practices](https://www.willowtreeapps.com/craft/best-practices-for-driving-engagement-with-ios-app-notification-badges). PWA-in-Capacitor limits — [magicbell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide), [webscraft 2026](https://webscraft.org/blog/pwa-pushspovischennya-na-ios-u-2026-scho-realno-pratsyuye?lang=en).

---

## 3. Artifact preview + download (for this stack)

**Stack:** SvelteKit adapter-node + Svelte 5 PWA + Capacitor iOS shell. A "preview + download" workspace panel is very buildable here.

### Recommended approach (one line)

SvelteKit `+server.ts` rest-param endpoint with `resolve → boundary → realpath` path-confinement and streamed responses; brand-matched side-panel-becomes-sheet UI rendering by content-type; **copy-to-clipboard as the universal default**; native `@capacitor/file-transfer` + Share in the shell, an out-of-`scope` subdomain URL for the PWA; and reserve untrusted live-HTML preview for a **separate `artifacts.` origin** in a `sandbox="allow-scripts"` iframe in phase 2.

### Layout pattern

- **Side panel on desktop / full-screen sheet on phone** — beats modal (blocks chat) and inline (clutters transcript). Render by type. Match brand tokens (#ec2d78, rounded-full pills, DispatchChips/WorkingBubble) — do NOT ship generic zinc cards (per memory `feedback_ui_match_app_brand_components`).
- Claude Artifacts = right side panel (the iterate-loop people praise most). ChatGPT Canvas = dedicated takeover pane. Gemini Canvas = morphing window, differentiator is export-out.

### MVP slice (ship first — ~1 focused dispatch, difficulty LOW–MEDIUM)

- One endpoint `GET /api/workspace/[project]/files/[...path]/+server.ts`: confined path, mime content-type, **streamed** (`fs.createReadStream` → web `ReadableStream` body), `?download=1` toggles `Content-Disposition: attachment`, `?raw=1` for inline preview.
- Panel renders **image inline + markdown formatted (marked + DOMPurify) + code with copy button**. **Skip live HTML execution at first** — show HTML source + a download so it's safe-by-default.
- Download = single file via `Content-Disposition`; copy-to-clipboard for text. Branch by iOS runtime (see below).

### Full-featured (later, difficulty MEDIUM)

- Live interactive HTML preview via **separate-origin iframe** (the "Claude Artifacts wow") — the only genuinely fiddly part (DNS/subdomain on the tailnet + Funnel + CSP).
- Zip-a-folder via streaming `archiver` (`GET /api/workspace/[project]/download-zip`) — pipes directly into the response, no full-archive buffering. (`jszip`/`adm-zip` buffer in memory — avoid for big sets.)
- Version history per artifact (each worker write = a version — NOT MVP).
- "Open full-screen," Gemini-style export-out.

### Security notes (load-bearing)

- **Path-traversal confinement is the critical piece.** `path.resolve()` alone does NOT protect you. Layer: (1) URL-decode in a loop to catch double-encoding (`%252e`); (2) reject null bytes + absolute/Windows-drive/UNC inputs; (3) `path.resolve(WORKSPACE_ROOT, project, userPath)`; (4) boundary check `resolved.startsWith(root + path.sep)` (resolve the root too); (5) `fs.realpath()` then re-check the boundary to defeat worker-created symlinks pointing outside the workspace.
- **Untrusted generated HTML:** NEVER use `sandbox="allow-scripts allow-same-origin"` together — that combo enables sandbox breakout. **Serve preview HTML from a separate origin** (e.g. `artifacts.<tailnet-host>`) so even with scripts it's cross-origin and can't touch Sully; combine with `<iframe sandbox="allow-scripts">` (omit `allow-same-origin`) + strict CSP. Fallback if no subdomain: `sandbox` with `allow-scripts` only, accepting some same-origin dashboards won't run.
- **Auth fit:** the separate `artifacts.` subdomain fits the existing "Tailscale is the boundary, no app-level cookie auth" model (`reference_ios_pwa_funnel_auth`) — gate it behind the Funnel-Request header check like other routes, no cookie auth.

### iOS download caveats — TWO runtimes, two behaviors

- **Installed PWA (standalone):** the `download` attribute and `blob:` anchors are unreliable — taps commonly open a stuck iOS preview/share screen with no way back into the app (confirmed live as of May 2026). `target="_blank"` does NOT escape to real Safari from standalone. **Workaround:** detect standalone (`navigator.standalone` / `matchMedia('(display-mode: standalone)')`) and route downloads to a URL **outside the manifest `scope`** (the `artifacts.` subdomain) so iOS hands it to Safari/the share sheet. For images, long-press-to-save is the reliable fallback.
- **Capacitor shell (WKWebView):** also no `blob:` href downloads (longstanding WebKit bug). **Do it natively:** `@capacitor/file-transfer` (current plugin; `Filesystem.downloadFile` deprecated as of 7.1.0) fetches the URL straight to disk, then present via Capacitor Share or FileOpener. For artifacts to land in the iOS Files app, set `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` in `Info.plist`.
- **Recommendation:** branch on runtime — Capacitor → native file-transfer + Share; PWA standalone → out-of-scope subdomain URL; desktop → plain `Content-Disposition` link. **Copy-to-clipboard works everywhere** and sidesteps the whole mess for code/markdown — make it the default action.

Sources: layout — [XDA Gemini/ChatGPT/Claude canvas](https://www.xda-developers.com/gemini-canvas-chatgpt-canvas-claude-interactive-visuals-for-studying/), [Unmarkdown](https://unmarkdown.com/blog/claude-artifacts-vs-chatgpt-canvas). Path traversal — [Node.js Path Traversal Guide](https://nodejsdesignpatterns.com/blog/nodejs-path-traversal-security/), [nodejs-security](https://www.nodejs-security.com/blog/secure-coding-practices-nodejs-path-traversal-vulnerabilities), [StackHawk](https://www.stackhawk.com/blog/node-js-path-traversal-guide-examples-and-prevention/). iframe sandbox — [MDN srcdoc](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc), [Mozilla Discourse on allow-scripts+allow-same-origin](https://discourse.mozilla.org/t/can-someone-explain-the-issue-behind-the-rule-sandboxed-iframes-with-attributes-allow-scripts-and-allow-same-origin-are-not-allowed-for-security-reasons/110651). Zip — [archiver](https://www.npmjs.com/package/archiver). iOS downloads — [Capawesome File Handling Guide](https://capawesome.io/blog/the-file-handling-guide-for-capacitor/), [WebKit bug 216918](https://bugs.webkit.org/show_bug.cgi?id=216918), [WordPress.org PWA stuck-preview 2026-05](https://wordpress.org/support/topic/iphone-pwa-image-download-opens-stuck-preview-screen/).

---

## 4. Vercel AI SDK borrows

Current usage (from brief): server uses `streamText` + `toUIMessageStreamResponse()` / `createUIMessageStream`; Svelte frontend uses the `Chat` class + `DefaultChatTransport`, and **resets its SDK chat on each send** (root cause behind several gaps below). AI SDK 6 is GA (codemod `npx @ai-sdk/codemod v6`); v5 stays stable. Everything below is in v5; v6 sweetens where noted.

| Feature                                                             | Maps to our current usage                                                | The win                                                                                                                                                                                                                                                       | Difficulty                                                                                                                                                                                                                                              | Adopt                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Custom data parts (`data-*`) + reconcile-by-`id`                    | Today Sully streams text and renders task/tool state via own plumbing    | Server pushes a `data-taskCard` (status/title/deep-link URL) + `data-artifact` (preview) that render inline as real brand components and update in place (`loading→success`). **Kills the raw-event-leak / stuck-timer bug class** — the part IS the UI state | Low–Med (server `writer.write` + a generic UIMessage type + a Svelte branch on `part.type`; no infra)                                                                                                                                                   | **Now**                                                                                                                                                                                                  |
| Transient data parts + `onData` hook                                | Autodispatch chain emits status updates                                  | Ephemeral "Dispatching…/Worker picked it up" delivered during streaming but NOT persisted — durable card via `data-taskCard`, chatter via `transient: true` + `onData`. No transcript clutter                                                                 | Low                                                                                                                                                                                                                                                     | **Now**                                                                                                                                                                                                  |
| `experimental_throttle`                                             | Renders Markdown on an iPhone viewport; default = every chunk re-renders | One prop (~50ms) → smoother streaming, lower CPU/battery, fewer reactive-loop hazards in the Svelte 5 runes surface. **Verify exact prop name in installed `@ai-sdk/svelte`**                                                                                 | Trivial                                                                                                                                                                                                                                                 | **Now**                                                                                                                                                                                                  |
| Message metadata (`messageMetadata` + `onFinish`)                   | Already track per-turn forensic journals                                 | Stamp `traceId`/model/token-usage on `message.metadata` (type-safe, no side channel); `onFinish` gives the complete `UIMessage[]` as the clean persist hook → jump from a message to `turn_replay.ts replayTurn()`                                            | Low                                                                                                                                                                                                                                                     | **Now/soon**                                                                                                                                                                                             |
| `status` + `stop()` + `regenerate()` + `setMessages()`              | Composer/affordances likely hand-rolled                                  | Drive composer enable/disable off `status`; wire Stop + Regenerate; optimistic insert via `setMessages`. Removes the "stuck timer" failure mode                                                                                                               | Low (caveat: with resumable streams, `stop()` alone won't cancel server work — pair with a stop endpoint)                                                                                                                                               | **Soon**                                                                                                                                                                                                 |
| File / attachment parts (`type: 'file'`) + `convertToModelMessages` | If Sully should accept screenshots/files                                 | Multimodal input + inline attachment previews for free                                                                                                                                                                                                        | Low–Med (data-URLs simplest but bloat transcript; object storage + URL parts for large files)                                                                                                                                                           | **Later (when multimodal needed)**                                                                                                                                                                       |
| Server persistence (stable IDs + `onFinish`)                        | Already persist threads in `logueos_memory.db`                           | Align schema to SDK message IDs → makes resume + regenerate "just work"; prerequisite for `activeStreamId`                                                                                                                                                    | Low–Med                                                                                                                                                                                                                                                 | **Soon (groundwork for resume)**                                                                                                                                                                         |
| Resumable / reconnectable streams (`resume`)                        | **Direct fix for "resets SDK chat each send / reconnect-after-reload"**  | Long replies + long dispatches survive a phone reload / backgrounding — big iOS-PWA reliability win                                                                                                                                                           | Med–High (**requires Redis on ROOM** + `resumable-stream` pkg + per-chat `activeStreamId`; caveat: client `stop()` only closes HTTP, doesn't cancel server work — needs a dedicated stop endpoint that persists the partial + clears the active stream) | **Later (after persistence groundwork)**                                                                                                                                                                 |
| Typed tool UI parts + tool approval (v6)                            | Dispatch UX is propose→confirm→card→synthesis; Phase 5 write-tool        | The "confirm" step IS the tool-approval pattern: `needsApproval: true` + `addToolApprovalResponse({approved})` as the canonical fail-closed gate for the write-tool; streaming tool inputs populate the Task card live                                        | Med (requires v6 upgrade; GA + codemod, but a version bump to validate against `@ai-sdk/svelte`)                                                                                                                                                        | **Later (Phase 5)**                                                                                                                                                                                      |
| WebSocket transport instead of SSE                                  | —                                                                        | —                                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                                                       | **Never** — SDK is SSE-first; resumable streams are built around SSE; canon already says "no custom SSE/polling" (`project_sdk_foundation_with_logueos_spin`); throws away resume support for no benefit |

Priority for the three flagged needs: **(a) inline artifact preview** → #1 custom data parts (+#2 transient for progress); **(b) task-done/deep-link** → #1 `data-taskCard` with reconcilable `id` (+ metadata for traceId, + tool approval for the confirm step); **(c) reconnect-after-reload** → resumable streams, but only after the persistence + stable-IDs groundwork, and mind the Redis dependency + `stop()` caveat.

Sources: [Streaming Custom Data](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data) · [Resume Streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams) · [vercel/resumable-stream](https://github.com/vercel/resumable-stream) · [Message Metadata](https://ai-sdk.dev/docs/ai-sdk-ui/message-metadata) · [useChat reference](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) · [Message Persistence](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence) · [Multi-Modal Chatbot](https://ai-sdk.dev/cookbook/guides/multi-modal-chatbot) · [AI SDK 5 blog](https://vercel.com/blog/ai-sdk-5) · [AI SDK 6 blog](https://vercel.com/blog/ai-sdk-6).

---

## 5. Recommended sequencing

**Step 1 — Notification deep-link fix (do first; hours, biggest felt improvement).**
Two one-line changes (`completionClose.ts:135`, `completion_poller.ts:61`) to put the in-scope thread id into the push URL. No sender/load changes. Verify `?thread=` survives APNs JSON (it will). All file/line claims verified against live code 2026-06-04. This is the cheapest high-value win in the whole report and directly fixes the operator's reported symptom.

**Step 2 — Cheap QOL batch (config/UI on existing infra).**
Pin/rename/search threads (`chat_thread_meta` exists), scroll-restore/last-unread on reopen, clearable task-inbox badge (APNs badge field), notification grouping by `thread-id`. Each is S-difficulty and compounds the task-first loop.

**Step 3 — Decision-push + lock-screen actions.**
Wire the existing blocked-state (decide() Talk/Ask/Dispatch + Run/Not-now) to a "needs a decision" APNs push, then add `UNNotificationAction` Approve/Not-now + `UNTextInputNotificationAction` reply (native work — the L item). Biggest hands-off win for a solo operator.

**Step 4 — Fold into Phase 5 (workspace + write-tool + artifact preview/download).**
This is where the SDK data-parts work and the artifact panel converge:

- Adopt SDK **custom data parts** (#1) + **transient parts** (#2) + **`experimental_throttle`** (trivial, do anytime) — these turn the Task card / artifact preview into first-class reconcilable UI and kill the stuck-timer/raw-event-leak class.
- Build the **artifact preview/download MVP slice** (confined `+server.ts` endpoint + side-panel/sheet rendering image/markdown/code-with-copy + single-file download + iOS runtime branch). Copy-to-clipboard as the default.
- Gate the **Phase 5 write-tool** behind v6 **tool approval** (`needsApproval`) — the SDK-native version of the propose→confirm step, aligned with the fail-closed posture.
- Land **persistence + stable message IDs** (#8) here as groundwork.

**Step 5 — Later / higher-cost (sequence deliberately, don't rush).**

- **Resumable streams** (reconnect-after-reload) — only after the persistence groundwork; introduces a Redis dependency on ROOM and the `stop()`-endpoint caveat. Don't half-adopt.
- **Live interactive HTML artifact preview** — requires the separate `artifacts.` origin (DNS/subdomain on the tailnet + Funnel + CSP). The genuinely fiddly piece.
- **Pulse-style overnight catch-up cards** — the standout differentiator worth a dedicated build once the loop above is solid.

**Research quality note:** all four investigations were substantial and well-sourced; none came back thin. The notification investigation's file/line claims were independently verified against the live code in this session and are accurate.
