#!/usr/bin/env bash
# Trigger a Codemagic iOS -> TestFlight build, injecting the STABLE signing key
# so the distribution certificate is reused (not minted fresh each build —
# Apple caps distribution certs at 2-3).
#
# The signing key lives OUTSIDE git at ~/dev/secrets/sully_signing_key.pem and
# is passed into the build as the CERTIFICATE_PRIVATE_KEY environment variable.
# Reads CODEMAGIC_API_TOKEN from the companion .env (never echoed).
#
# Usage: tools/trigger-ios-build.sh [branch]   (default branch: main)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${1:-main}"
APP_ID="6a1b197bbf681e121fb06056"
WORKFLOW="ios-testflight"
KEY_FILE="$HOME/dev/secrets/sully_signing_key.pem"

TOKEN=$(grep '^CODEMAGIC_API_TOKEN=' "$REPO_ROOT/.env" | cut -d= -f2-)
[ -z "$TOKEN" ] && { echo "CODEMAGIC_API_TOKEN not in .env" >&2; exit 1; }
[ -f "$KEY_FILE" ] || { echo "signing key not found: $KEY_FILE" >&2; exit 1; }

# Build the JSON payload with python so the multi-line PEM key is escaped safely.
BODY=$(python3 - "$APP_ID" "$WORKFLOW" "$BRANCH" "$KEY_FILE" <<'PY'
import json, sys
app_id, workflow, branch, key_file = sys.argv[1:5]
key = open(key_file).read()
print(json.dumps({
    "appId": app_id,
    "workflowId": workflow,
    "branch": branch,
    "environment": {"variables": {"CERTIFICATE_PRIVATE_KEY": key}}
}))
PY
)

RESP=$(curl -sS -m 25 -X POST https://api.codemagic.io/builds \
  -H "Content-Type: application/json" -H "x-auth-token: $TOKEN" -d "$BODY")
BUILD_ID=$(printf '%s' "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('buildId',''))" 2>/dev/null || true)
if [ -n "$BUILD_ID" ]; then
  echo "triggered build $BUILD_ID on $BRANCH"
  echo "watch: https://codemagic.io/app/$APP_ID/build/$BUILD_ID"
else
  echo "trigger failed: $RESP" >&2; exit 1
fi
