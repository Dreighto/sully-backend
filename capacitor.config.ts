import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Sully — thin Capacitor 8 iOS shell (BUILD 1: shell + microphone).
 *
 * At runtime the WebView loads the REMOTE SvelteKit (adapter-node) server via
 * `server.url`; nothing is bundled. The Capacitor native bridge (haptics,
 * keyboard, status-bar, app, share, preferences) is injected into the loaded
 * remote origin, so the SvelteKit app at /companion can call window.Capacitor
 * as long as it stays on that origin.
 *
 * ios/ is generated fresh in Codemagic CI (`npx cap add ios --packagemanager
 * CocoaPods`) and is NOT committed. This file is the single committed source of
 * Capacitor config.
 *
 * BUILD 2 will add @capacitor/push-notifications + an aps-environment
 * entitlement + a `plugins.PushNotifications` block here, plus register/listener
 * code in the remote web app. Intentionally omitted now to keep the first build
 * free of any push-signing risk.
 */
const config: CapacitorConfig = {
  appId: 'com.dreighto.sully',
  appName: 'Sully',

  // webDir MUST exist with an index.html for `cap add ios` / `cap sync` to run,
  // even though we load remote content. The Codemagic "placeholder webDir" step
  // writes www/index.html in CI (www/ is gitignored). Its contents never render
  // — server.url overrides them at runtime.
  webDir: 'www',

  server: {
    // RECOMMENDED: tailnet-only origin, valid *.ts.net (Let's Encrypt) TLS.
    // Non-standard port 8444 is fine for WKWebView and irrelevant to ATS.
    // Requires the Tailscale iOS app installed + connected on the phone.
    url: 'https://room.taila28611.ts.net:8444/companion',

    // Public Funnel alternative (currently ungated — prefer the tailnet :8444 URL):
    // url: 'https://room.taila28611.ts.net/companion',

    // Pure HTTPS — do NOT enable cleartext.
    cleartext: false,

    // Keep same-host navigation INSIDE the WebView so the Capacitor bridge stays
    // attached. If the page navigated off this host to Safari, getPlatform()
    // would flip to 'web' and native plugin calls would become no-ops.
    allowNavigation: ['room.taila28611.ts.net']
  },

  ios: {
    // 'never': the web app owns safe areas via env(safe-area-inset-*) + viewport-fit=cover.
    // 'always' made Capacitor ALSO inset the content -> double-handled -> composer cut off the bottom.
    contentInset: 'never',
    // Leave OFF. With Capacitor 8, turning this on requires a WKAppBoundDomains
    // array and makes bridge injection fragile. A side effect (relied on for
    // Build 1): iOS does NOT run the remote app's service worker in the WebView
    // without the app-bound-domains opt-in, so the existing PWA SW stays inert
    // here and cannot interfere with the shell.
    limitsNavigationsToAppBoundDomains: false
  }
};

export default config;
