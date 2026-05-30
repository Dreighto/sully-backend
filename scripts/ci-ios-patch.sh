#!/usr/bin/env bash
# ci-ios-patch.sh — re-apply native iOS config after `npx cap add ios`.
#
# BUILD 1 SCOPE: microphone + export-compliance + iOS-15 deployment floor only.
# Push (aps-environment entitlement + CODE_SIGN_ENTITLEMENTS wiring) is
# intentionally NOT done here yet — it lands in Build 2 alongside the push
# plugin and the remote-app register code. Keeping this patch minimal removes
# the fragile pbxproj string-edits and the entitlement/profile-mismatch risk
# from the first build.
#
# Runs on the Codemagic Mac mini (BSD userland). ios/ is generated fresh every
# build and NOT committed, so these settings must be re-applied on EVERY build.
# Idempotent (Set first, Add on failure). Run from the repo root (CM_BUILD_DIR).
set -euo pipefail

PLIST="ios/App/App/Info.plist"
PODFILE="ios/App/Podfile"

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

# --- Verify (printed in the build log) ---------------------------------------
echo 'iOS patch complete:'
/usr/libexec/PlistBuddy -c 'Print :NSMicrophoneUsageDescription' "$PLIST"
/usr/libexec/PlistBuddy -c 'Print :ITSAppUsesNonExemptEncryption' "$PLIST"
