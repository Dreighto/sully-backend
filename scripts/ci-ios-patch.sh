#!/usr/bin/env bash
# ci-ios-patch.sh — re-apply native iOS config after `npx cap add ios`.
#
# SHIPPED SCOPE (as of build 15): microphone + export-compliance + iOS-15 floor,
# the APNs push entitlement (aps-environment + CODE_SIGN_ENTITLEMENTS wiring),
# and the AppDelegate APNs token-forwarding methods Capacitor 8 omits. Push is
# live end-to-end — none of this is "deferred."
#
# Runs on the Codemagic Mac mini (BSD userland). ios/ is generated fresh every
# build and NOT committed, so these settings must be re-applied on EVERY build.
# Idempotent (Set first, Add on failure). Run from the repo root (CM_BUILD_DIR).
set -euo pipefail

PLIST="ios/App/App/Info.plist"
PODFILE="ios/App/Podfile"
ENTITLEMENTS="ios/App/App/App.entitlements"
PBXPROJ="ios/App/App.xcodeproj/project.pbxproj"
BUNDLE_ID="com.dreighto.sully"

if [ ! -f "$PLIST" ]; then
  echo "ERROR: $PLIST not found — did 'npx cap add ios --packagemanager CocoaPods' run first?" >&2
  exit 1
fi

# --- Info.plist keys ---------------------------------------------------------
set_or_add() {  # $1 key  $2 type(string|bool)  $3 value
  /usr/libexec/PlistBuddy -c "Set :$1 $3" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "$PLIST"
}

# Microphone usage string — REQUIRED or the iOS mic prompt never fires and
# getUserMedia() rejects (voice mode dies silently).
set_or_add NSMicrophoneUsageDescription string "Sully uses the microphone for voice conversations."

# Declare no non-exempt encryption so TestFlight uploads skip the manual
# export-compliance question on every build.
set_or_add ITSAppUsesNonExemptEncryption bool false

# --- Podfile iOS deployment floor -------------------------------------------
# Capacitor 8 requires iOS 15.0. The CocoaPods template usually defaults to
# 15.0, but assert it so a regressed template can't resolve the wrong Cap pod.
# Runs BEFORE `cap sync` (which runs pod install), so the floor is honored.
if [ -f "$PODFILE" ]; then
  perl -0pi -e "s/platform :ios, '[0-9.]+'/platform :ios, '15.0'/g" "$PODFILE"
  echo "Podfile platform line:"; grep "platform :ios" "$PODFILE" || true
fi

# --- APNs push entitlement (Build 2) -----------------------------------------
# 1) Write the entitlements file. aps-environment=production — TestFlight + App
#    Store builds use the PRODUCTION APNs gateway (api.push.apple.com). A
#    development value here against a TestFlight build = silent BadDeviceToken.
cat > "$ENTITLEMENTS" <<'PLISTEOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>aps-environment</key>
	<string>production</string>
</dict>
</plist>
PLISTEOF
echo "wrote $ENTITLEMENTS"

# 2) Wire CODE_SIGN_ENTITLEMENTS into every App-target build config. Anchor on
#    the PRODUCT_BUNDLE_IDENTIFIER line (present once per build config for the
#    App target) and insert the entitlements path right after it — but only if
#    not already present (idempotent across re-runs). Capacitor's generated
#    pbxproj uses tabs + "KEY = VALUE;" lines; we match that shape.
if [ -f "$PBXPROJ" ]; then
  if grep -q "CODE_SIGN_ENTITLEMENTS = App/App.entitlements;" "$PBXPROJ"; then
    echo "CODE_SIGN_ENTITLEMENTS already wired — skipping"
  else
    perl -0pi -e \
      's/(PRODUCT_BUNDLE_IDENTIFIER = \Q'"$BUNDLE_ID"'\E;)/$1\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = App\/App.entitlements;/g' \
      "$PBXPROJ"
    echo "wired CODE_SIGN_ENTITLEMENTS into $(grep -c 'CODE_SIGN_ENTITLEMENTS = App/App.entitlements;' "$PBXPROJ") build config(s)"
  fi
else
  echo "WARNING: $PBXPROJ not found — entitlement not wired" >&2
fi

# --- APNs token forwarding in AppDelegate (Capacitor 8 omits it) --------------
# Capacitor 8's generated AppDelegate.swift does NOT forward the APNs device
# token to the bridge, so @capacitor/push-notifications never fires its
# 'registration' event (its plugin only observes .capacitorDidRegisterForRemote
# Notifications, which must be posted from the AppDelegate). Without this, the
# app gets a token from iOS and silently drops it — push never works. Inject the
# two forwarding methods, idempotently, before the class-closing brace.
APPDELEGATE="ios/App/App/AppDelegate.swift"
if [ -f "$APPDELEGATE" ]; then
  if grep -q 'capacitorDidRegisterForRemoteNotifications' "$APPDELEGATE"; then
    echo "AppDelegate APNs forwarding already present — skipping"
  else
    cat > /tmp/apns_methods.swift <<'SWIFTEOF'

    // APNs token forwarding — Capacitor 8's default AppDelegate omits these, so
    // @capacitor/push-notifications never receives the device token (its
    // 'registration' event never fires) without them. Re-injected every build
    // because ios/ is regenerated fresh.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
SWIFTEOF
    perl -0777 -pi -e 'BEGIN{local $/; open(F,"<","/tmp/apns_methods.swift") or die "no methods file"; $m=<F>; close F;} s/\}\s*\z/$m\n}\n/' "$APPDELEGATE"
    echo "injected APNs forwarding into AppDelegate ($(grep -c 'didRegisterForRemoteNotificationsWithDeviceToken' "$APPDELEGATE") method)"
  fi
else
  echo "WARNING: $APPDELEGATE not found — APNs token forwarding not injected" >&2
fi

# --- AVAudioSession category (voice volume fix) ------------------------------
# Without an explicit audio session, WKWebView media playback ignored the iPhone
# hardware volume / silent switch — Sully's TTS played even at zero volume.
# Set .playAndRecord (voice mode needs BOTH mic + speaker) with .voiceChat +
# .defaultToSpeaker so playback obeys the hardware volume and routes to the main
# loudspeaker (not the quiet earpiece). Idempotent. NOTE: WKWebView manages its
# own session during getUserMedia, so if iOS overrides this the fallback is a
# Capacitor audio-session plugin set at voice-mode start. If TTS sounds
# over-processed/quiet under .voiceChat, switch the mode to .default.
if [ -f "$APPDELEGATE" ]; then
  if grep -q 'AVAudioSession' "$APPDELEGATE"; then
    echo "AppDelegate AVAudioSession config already present — skipping"
  else
    grep -q '^import AVFoundation' "$APPDELEGATE" \
      || perl -0pi -e 's/(import Capacitor)/$1\nimport AVFoundation/' "$APPDELEGATE"
    cat > /tmp/audio_session.swift <<'SWIFTEOF'
        // Voice volume fix — make WKWebView audio obey the iPhone hardware volume
        // and route to the main speaker, while keeping the mic available for
        // voice mode. Re-injected every build because ios/ is regenerated fresh.
        // mode = .default (NOT .voiceChat): .voiceChat marks this a VoIP "call",
        // and iOS refuses to let the call volume reach absolute zero (it bumped
        // the volume up a step at the bottom). Voice mode is strictly turn-based
        // — the mic is released before TTS plays — so .voiceChat's echo
        // cancellation isn't needed, and .default lets the volume go fully to
        // zero AND keeps TTS full-quality (no voice-processing).
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default,
                                    options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
            try session.setActive(true)
            try session.overrideOutputAudioPort(.speaker)
        } catch { print("[Sully] AVAudioSession config failed: \(error)") }
SWIFTEOF
    perl -0777 -pi -e 'BEGIN{local $/; open(F,"<","/tmp/audio_session.swift") or die "no audio file"; $a=<F>; close F;} s/(didFinishLaunchingWithOptions[^\n]*-> Bool \{\n)/$1$a/' "$APPDELEGATE"
    echo "injected AVAudioSession config into AppDelegate ($(grep -c 'AVAudioSession' "$APPDELEGATE"))"
  fi
else
  echo "WARNING: $APPDELEGATE not found — AVAudioSession config not injected" >&2
fi

# --- Verify (printed in the build log) ---------------------------------------
echo 'iOS patch complete:'
/usr/libexec/PlistBuddy -c 'Print :NSMicrophoneUsageDescription' "$PLIST"
/usr/libexec/PlistBuddy -c 'Print :ITSAppUsesNonExemptEncryption' "$PLIST"
echo "aps-environment:"; /usr/libexec/PlistBuddy -c 'Print :aps-environment' "$ENTITLEMENTS" 2>/dev/null || echo '(entitlements file missing)'
echo "CODE_SIGN_ENTITLEMENTS lines:"; grep -c 'CODE_SIGN_ENTITLEMENTS = App/App.entitlements;' "$PBXPROJ" 2>/dev/null || echo 0
echo "AppDelegate APNs forwarding:"; grep -c 'capacitorDidRegisterForRemoteNotifications' "${APPDELEGATE:-/dev/null}" 2>/dev/null || echo 0
echo "AppDelegate AVAudioSession config:"; grep -c 'AVAudioSession' "${APPDELEGATE:-/dev/null}" 2>/dev/null || echo 0
