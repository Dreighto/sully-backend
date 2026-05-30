# Sully iOS — Codemagic TestFlight Runbook

How to get Sully onto your iPhone via TestFlight. Build 1 = a thin native shell
(loads the live web app over Tailscale) + microphone. Push is Build 2.

## What's in the repo (branch `feat/ios-capacitor-shell`)
- `capacitor.config.ts` — appId `com.dreighto.sully`, loads `https://room.taila28611.ts.net:8444/companion` (tailnet-only).
- `codemagic.yaml` — the CI workflow (`ios-testflight`), automatic signing, TestFlight publish.
- `scripts/ci-ios-patch.sh` — sets the mic permission string, export-compliance flag, iOS-15 floor.
- `@capacitor/*` deps in `package.json` + `package-lock.json` (committed so `npm ci` works in CI).
- `ios/` and `www/` are **gitignored** — both are generated fresh in CI.

## One-time setup (you, in the browser)

1. **App Store Connect — app record.** appstoreconnect.apple.com → Apps → ➕ → New App.
   Platform iOS, Name `Sully`, Bundle ID `com.dreighto.sully` (already registered), SKU `sully`.
2. **Grab the numeric Apple ID.** Apps → Sully → General → App Information → **Apple ID** (a number).
   In `codemagic.yaml` set `environment.vars.APP_APPLE_ID` to it (replace `0000000000`), commit, push.
   *(Optional for the very first build — the `$BUILD_NUMBER` fallback covers it — but set it before Build 2.)*
3. **Internal TestFlight tester = you.** App Store Connect → Users and Access → add/confirm your Apple ID,
   then TestFlight → Internal Testing → add yourself. Internal builds are testable right after processing,
   **no Beta App Review**.
4. **Codemagic app + integration.** codemagic.io → Add application → connect GitHub `Dreighto/LogueOS-Companion`
   → use `codemagic.yaml`. In **Team settings → Integrations → App Store Connect**, confirm the API key
   (ID `R8SY4X6JM4`) integration is named exactly **`codemagic`** (matches the `integrations:` block). If it's
   named differently, rename it or change the name in `codemagic.yaml`.
5. **Install Tailscale on the iPhone** and sign in to the tailnet — required, or the shell loads a blank page
   (the app's URL is tailnet-only `:8444`).

## Trigger the build (manual — protects your 500 min/mo)
Codemagic → **Start new build** → Branch `feat/ios-capacitor-shell` → Workflow **Sully iOS -> TestFlight** → Start.
Watch the log: the patch step prints the mic key + encryption flag; signing prints the fetched profile; the
upload finishes in post-processing. A clean Capacitor archive is ~8–15 min.

## On-device test (Build 1 success criteria)
Install from TestFlight on your iPhone (Tailscale connected), then confirm:
- [ ] App launches and **loads Sully** (not a blank/placeholder page).
- [ ] The **microphone prompt** fires when you start voice; voice capture works.
- [ ] Haptics / keyboard / status-bar feel native.

If it loads blank: check Tailscale is connected on the phone, and that `room.taila28611.ts.net:8444/companion`
responds from the phone's browser.

## Build 2 — add push (next iteration)
Push was deferred from Build 1 on purpose. To add it:
1. `npm i --save-exact @capacitor/push-notifications@8.1.1` (commit package.json + lock).
2. Re-add the `plugins.PushNotifications` block to `capacitor.config.ts`.
3. In `scripts/ci-ios-patch.sh`, write `ios/App/App/App.entitlements` with `aps-environment = production`
   and wire `CODE_SIGN_ENTITLEMENTS` into `project.pbxproj` (prefer the `xcode-project`/xcodeproj tooling over
   regex). The App ID already has the Push capability enabled, so the auto-fetched profile carries it.
4. In the **remote web app** (`src/`): import `@capacitor/push-notifications`, and guarded by
   `Capacitor.isNativePlatform()`, call `PushNotifications.requestPermissions()` → `register()` and add a
   `registration` listener that POSTs the device token to the server's push store.
5. Wire the **APNs `.p8` send-key** into the server's push dispatcher (this is the *sender* side — separate
   from the build).

## Notes / known caveats
- `xcode: latest` is used for first-build safety (resolves to 26.4). Pin `26.4` once confirmed on the free tier.
- Tailnet-only `server.url` is correct for **internal** TestFlight (your device). **External** testers / App
  Review can't reach a `*.ts.net` host — revisit before any external distribution (also Apple guideline 4.2
  scrutinizes pure remote-WebView shells; native mic/haptics help that case).
- The remote app's service worker stays **inert** in the shell (iOS won't run WKWebView SWs without the
  app-bound-domains opt-in, which is off), so no SW gating is needed for Build 1.
