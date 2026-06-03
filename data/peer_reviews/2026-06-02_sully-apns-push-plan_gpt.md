# Sully — Native APNs Push Notifications: Implementation Plan

**Date:** 2026-06-02
**Project:** LogueOS-Companion (Sully) — native iOS app via Capacitor 8 + Codemagic + TestFlight
**Author:** main CC (Claude Opus 4.8 via Claude Code)
**For:** operator + ChatGPT review
**Goal:** When a Sully task finishes (or a worker reports done/failed), the operator gets a real push notification on his iPhone lock screen — inside the native TestFlight app, not just the PWA.

---

## Why native APNs (not Web Push)

The companion app's service worker is intentionally run **inert** inside the Capacitor WebView (`capacitor.config.ts` BUILD-1 note). Web Push only works in a Safari-installed home-screen PWA, NOT inside the native app. So for the real app the operator uses, notifications must go through **APNs** (Apple Push Notification service) via `@capacitor/push-notifications`.

The server-side trigger is ALREADY wired: `closeOutTask()` in `activity/+server.ts` fires on task completion (commit e1ce1c5). Today it calls `sendPushToAll` (Web Push, self-gated off). This plan adds an APNs sender alongside it.

## What's already in place (de-risks a lot)

- **Apple Developer:** enrolled, Team ID `G3KJW4VXM9`.
- **Bundle ID** `com.dreighto.sully` — Explicit, **Push Notifications capability already enabled** in the portal.
- **APNs Auth Key (.p8):** created (Production), downloaded by the operator. Has a Key ID (10 chars). NOT yet on the server.
- **App Store Connect API key** `R8SY4X6JM4` — already in Codemagic for signing.
- **Codemagic auto-signing** via the App Store Connect integration (codemagic.yaml).
- **CI patch script** `scripts/ci-ios-patch.sh` — PlistBuddy-based, idempotent, re-applied every build (ios/ is regenerated fresh + uncommitted).
- **Task system (Phase 1):** completion hook `closeOutTask` is the single place that fires when a task ends.

## The five pieces

### 1. App: install + configure the plugin (CC — done in this branch)

- `npm i @capacitor/push-notifications`
- `capacitor.config.ts` → add `plugins.PushNotifications.presentationOptions: ['badge','sound','alert']`

### 2. App: client registration code (CC)

A small module that runs on app start (native only):

- `PushNotifications.requestPermissions()` → if granted, `PushNotifications.register()`
- On `registration` event → get the APNs device token → `POST /api/chat/push/apns-register {token, device_id}`
- On `pushNotificationActionPerformed` → navigate to the task/thread the push points at
- Guard with `Capacitor.isNativePlatform()` so it's a no-op on web/PWA

### 3. Server: APNs token storage + sender (CC — the testable core)

- New table `chat_apns_tokens (device_id PK, token, updated_at)` (additive, in bootstrap)
- New route `POST /api/chat/push/apns-register` (tailnet-gated like the other push routes) → upsert token
- New `src/lib/server/apns.ts`:
  - Builds the APNs JWT (ES256, signed with the .p8 key) — header `{alg:ES256, kid:<KEY_ID>}`, claims `{iss:<TEAM_ID>, iat}`. Token cached + refreshed hourly (APNs requires < 1h old).
  - `sendApns({title, body, threadUrl})` → HTTP/2 POST to `https://api.push.apple.com/3/device/<token>` with `apns-topic: com.dreighto.sully`, `authorization: bearer <jwt>`, body `{aps:{alert:{title,body}, sound:'default'}, url}`.
  - 410 response → token is dead → delete it (mirror the Web Push dead-sub reaper).
- Config: `APNS_KEY_ID`, `APNS_TEAM_ID` (G3KJW4VXM9), `APNS_BUNDLE_ID` (com.dreighto.sully), `APNS_KEY_PATH` (path to the .p8), `APNS_PRODUCTION` (true for TestFlight). All in `.env` (gitignored).

### 4. Wire the completion hook (CC)

- In `closeOutTask`, alongside `sendPushToAll`, call `sendApnsToAll({title, body, url})` (self-gated on APNS config presence → no-op until configured).

### 5. CI: entitlement (CC writes the patch; operator triggers the build)

- `scripts/ci-ios-patch.sh` gains: write `ios/App/App/App.entitlements` with `aps-environment = production`, and wire `CODE_SIGN_ENTITLEMENTS = App/App.entitlements` into the target's build settings.
- The pbxproj edit is the fragile part. Cleanest approach: use Apple's `plutil` for the entitlements file (safe) + set CODE_SIGN_ENTITLEMENTS via `xcode-project` / a targeted `sed` (the script already does perl edits on the Podfile). Will verify on a real build.

---

## What the OPERATOR must do (the non-CC parts)

These need Apple credentials / a real build and can't be done from the dev box:

1. **Get the APNs key details to the server.** From the .p8 file you downloaded:
   - The **Key ID** (10 chars, in the filename `AuthKey_XXXXXXXXXX.p8` and in the portal).
   - Drop the `.p8` somewhere on the room box (e.g. `~/dev/secrets/AuthKey_XXXX.p8`, NOT in the repo) and tell me the path + Key ID. I'll add `APNS_*` to the companion `.env`.
2. **Confirm the APNs key is enabled for the bundle** (it's account-wide, so likely fine).
3. **Trigger a Codemagic build** once the entitlement patch is in, so the signed TestFlight build carries the `aps-environment` entitlement. (CC can't trigger/sign builds.)
4. **On the new TestFlight build:** open Sully, accept the notification permission prompt. That registers your device token with the server.
5. Then any task completion → real lock-screen push.

---

## Testing strategy (honest)

- **Server APNs sender:** unit-testable in isolation (JWT shape, payload shape, dead-token reaping) with a mocked HTTP/2 client. CC does this now.
- **End-to-end:** NOT testable from the dev box — needs a real signed build + a real device token. This is a build-iterate-on-Codemagic loop. Expect 2-3 build cycles to shake out signing/entitlement/topic mismatches (the usual APNs gotchas: wrong `apns-topic`, sandbox-vs-production endpoint mismatch, expired JWT).

## Risks

- **Sandbox vs Production APNs.** TestFlight builds use the **production** APNs endpoint (`api.push.apple.com`) with `aps-environment: production` entitlement. A mismatch = silent 400 `BadDeviceToken`. The plan uses production; if a dev build is ever used, it needs the sandbox endpoint.
- **pbxproj CODE_SIGN_ENTITLEMENTS edit** is the fragile CI step (the reason BUILD-1 deferred it). May need a couple of build iterations to get the string-edit robust across Capacitor's generated project.
- **JWT freshness:** APNs rejects JWTs older than 1h; the sender caches + refreshes. Don't sign per-request (APNs rate-limits new tokens).
- **One operator, fan-out:** like the Web Push path, APNs sends to ALL registered device tokens. Fine for a single operator.
- **The .p8 is a secret** — never in the repo, never logged. Lives outside git, referenced by path in `.env`.

## After this lands → Dynamic Island

This APNs foundation is the prerequisite for the Dynamic Island Live Activity (the operator's longer-term want). Live Activities update via APNs push to a Widget Extension. Once APNs push works, the Island is: a Swift Widget Extension target + ActivityAttributes struct + the `capacitor-live-activity` plugin + a CI script to re-inject the widget target each build. That's a separate Large build — but it reuses everything here.

---

## Questions for the reviewer

1. **Entitlement CI approach:** is there a more robust way to set `CODE_SIGN_ENTITLEMENTS` on a Capacitor-generated Xcode project than a pbxproj sed/perl edit? (e.g. an xcconfig override, or `xcodebuild` build-setting flag at archive time.) This is the fragile bit.
2. **APNs library:** Node's built-in `http2` + a hand-rolled ES256 JWT (via `jsonwebtoken` or `jose`) is dependency-light. Worth pulling a maintained APNs lib (`@parse/node-apn` is stale; `apns2` is lighter) instead? Leaning hand-rolled with `jose` for control + fewer deps.
3. **Token targeting:** for a single operator, send-to-all is fine. Worth storing a per-device "last seen" so we reap stale tokens proactively, or just rely on the 410 reaper? Leaning 410-reaper only (simpler).

---

_Plan only — server foundation being built now; Apple-signing + build-trigger steps are the operator's. The completion trigger (closeOutTask) already exists; this adds the APNs delivery leg._
