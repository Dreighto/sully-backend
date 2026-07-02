#!/usr/bin/env bash
# chat-regression-probe.sh — periodic main-chat health probe (dev QA).
#
# Catches the regression classes we have actually hit by hand, cheaply and
# deterministically (no LLM tokens). Two tiers:
#   (default)  scan + smoke  — read-only DB anomaly scan + one text turn. Cheap,
#                              safe to run on a short cadence (cron).
#   --full                   — adds the API battery: image gen, regenerate-reuse,
#                              dispatch routing, error rollback. Costs API $, run
#                              after a ship or a few times a day, not every tick.
#
# Exit 0 = GREEN (main chat healthy). Non-zero = anomalies found (see output).
# Env: BASE (default http://127.0.0.1:18779/companion), DB, PROBE_PING=1 to
# Telegram the operator on FAILURE (uses ~/.sully-build.env creds).
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:18779/companion}"
DB="${DB:-/home/dreighto/dev/sully-backend/data/companion.db}"
FULL=0; [[ "${1:-}" == "--full" ]] && FULL=1
FAILS=(); PASSES=0
now=$(date +%s)
q(){ sqlite3 "$DB" "$1" 2>/dev/null; }
pass(){ PASSES=$((PASSES+1)); echo "  [PASS] $1"; }
fail(){ FAILS+=("$1"); echo "  [FAIL] $1"; }

echo "=== chat-regression-probe $(date '+%F %T %Z') (full=$FULL) ==="

# ---- Tier 1: read-only DB anomaly scan (free) --------------------------------
echo "-- DB anomaly scan --"

# Orphan operator turns: an operator row whose next in-thread row is another
# operator (or end-of-thread) AND it is not a dispatch/work turn (no pending_jobs
# in a working/synthesized state). Stage-1 rollback should keep this at 0 for
# NEW turns; a rising count means orphans are leaking again.
orphans=$(q "
WITH ops AS (SELECT id, thread_id, message,
  (SELECT sender FROM chat_messages n WHERE n.thread_id=o.thread_id AND n.id>o.id ORDER BY n.id ASC LIMIT 1) AS next_sender,
  (SELECT task_id FROM chat_messages n WHERE n.id=o.id) AS tid
  FROM chat_messages o WHERE sender='operator' AND id > (SELECT COALESCE(MAX(id),0)-200 FROM chat_messages))
SELECT COUNT(*) FROM ops WHERE (next_sender IS NULL OR next_sender='operator')
  AND tid NOT IN (SELECT trace_id FROM pending_jobs WHERE status IN ('working','synthesized','done','verified','gated','decided'));")
[[ "${orphans:-0}" -eq 0 ]] && pass "no new orphan operator turns (last 200)" || fail "orphan operator turns (last 200): $orphans"

# Duplicate adjacent operator rows with identical text (the retry/regenerate
# duplicate signature). Stage-2/3 should keep this at 0 among keyed turns.
dups=$(q "
SELECT COUNT(*) FROM chat_messages a
JOIN chat_messages b ON a.thread_id=b.thread_id AND b.id=(SELECT MIN(id) FROM chat_messages x WHERE x.thread_id=a.thread_id AND x.id>a.id)
WHERE a.sender='operator' AND b.sender='operator' AND a.message=b.message
  AND a.id > (SELECT COALESCE(MAX(id),0)-200 FROM chat_messages);")
[[ "${dups:-0}" -eq 0 ]] && pass "no adjacent duplicate operator rows (last 200)" || fail "adjacent duplicate operator rows: $dups"

# RECENTLY-stuck proposed/classified jobs: started in the last 2h but still not
# advanced after 10 min = a live stuck dispatch decision (a regression signal).
# Bounded to recent so historical proposed/classified cruft is not counted.
dangle=$(q "SELECT COUNT(*) FROM pending_jobs WHERE status IN ('proposed','classified') AND started_at < datetime('now','-10 minutes') AND started_at > datetime('now','-2 hours');")
[[ "${dangle:-0}" -eq 0 ]] && pass "no recently-stuck proposed/classified jobs" || fail "recently-stuck proposed/classified jobs (10m-2h): $dangle"
# Also surface the historical backlog as INFO (not a failure) so it is visible.
hist=$(q "SELECT COUNT(*) FROM pending_jobs WHERE status IN ('proposed','classified') AND started_at <= datetime('now','-2 hours');")
[[ "${hist:-0}" -gt 0 ]] && echo "  [INFO] historical proposed/classified backlog (>2h, not a regression): $hist"

# Client-turn-id uniqueness invariant (Stage 2): no (thread,client_turn_id) with
# >1 operator row.
keydup=$(q "SELECT COUNT(*) FROM (SELECT thread_id, client_turn_id, COUNT(*) c FROM chat_messages WHERE sender='operator' AND client_turn_id IS NOT NULL GROUP BY thread_id, client_turn_id HAVING c>1);")
[[ "${keydup:-0}" -eq 0 ]] && pass "client_turn_id idempotency holds" || fail "duplicate operator rows per client_turn_id: $keydup"

# ---- Tier 1: backend health -------------------------------------------------
echo "-- backend health --"
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/api/chat/voice-config" 2>/dev/null)
[[ "$code" == "200" ]] && pass "backend health 200" || fail "backend health: $code"

# ---- Tier 1: text-turn smoke (one cheap Gemini turn) ------------------------
echo "-- text-turn smoke --"
T="probe-$now"
sse=$(curl -sN --max-time 40 -X POST "$BASE/api/chat/sdk-stream" -H 'Content-Type: application/json' \
  -d "{\"messages\":[{\"id\":\"u1\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Reply with exactly: probe-ok\"}]}],\"thread\":\"$T\",\"provider\":\"google\"}" 2>/dev/null)
echo "$sse" | grep -q 'data-sully-reply-id' && pass "text turn emits reply-id frame" || fail "text turn missing reply-id frame"
echo "$sse" | grep -q 'text-delta' && pass "text turn streamed text" || fail "text turn produced no text"
row=$(q "SELECT COUNT(*) FROM chat_messages WHERE thread_id='$T' AND sender<>'operator';")
[[ "${row:-0}" -ge 1 ]] && pass "text turn persisted a reply" || fail "text turn persisted no reply"
q "DELETE FROM chat_messages WHERE thread_id='$T'; DELETE FROM chat_thread_meta WHERE thread_id='$T'; DELETE FROM chat_thread_state WHERE thread_id='$T';"

# ---- Tier 2: --full API battery ---------------------------------------------
if [[ "$FULL" == 1 ]]; then
  echo "-- FULL battery --"
  # image gen
  TI="probe-img-$now"
  isse=$(curl -sN --max-time 45 -X POST "$BASE/api/chat/sdk-stream" -H 'Content-Type: application/json' \
    -d "{\"messages\":[{\"id\":\"u1\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Generate a picture of a small blue dot\"}]}],\"thread\":\"$TI\",\"provider\":\"google\"}" 2>/dev/null)
  echo "$isse" | grep -qE '!\[[^]]*\]\([^)]*uploads' && pass "image gen renders markdown" || fail "image gen produced no image markdown"
  echo "$isse" | grep -q 'data-sully-reply-id' && pass "image turn emits reply-id" || fail "image turn missing reply-id"
  q "DELETE FROM chat_messages WHERE thread_id='$TI'; DELETE FROM chat_thread_meta WHERE thread_id='$TI'; DELETE FROM chat_thread_state WHERE thread_id='$TI';"

  # regenerate reuse: same client_turn_id twice -> ONE operator row
  TR="probe-reuse-$now"; K="probe-key-$now"
  for i in 1 2; do curl -sN --max-time 40 -X POST "$BASE/api/chat/sdk-stream" -H 'Content-Type: application/json' \
    -d "{\"messages\":[{\"id\":\"u1\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Reply with exactly: reuse-ok\"}]}],\"thread\":\"$TR\",\"provider\":\"google\",\"client_turn_id\":\"$K\"}" >/dev/null 2>&1; done
  opc=$(q "SELECT COUNT(*) FROM chat_messages WHERE thread_id='$TR' AND sender='operator';")
  [[ "${opc:-0}" -eq 1 ]] && pass "regenerate reuse: one operator row for one key" || fail "regenerate reuse: $opc operator rows for one client_turn_id (expected 1)"
  q "DELETE FROM chat_messages WHERE thread_id='$TR'; DELETE FROM chat_thread_meta WHERE thread_id='$TR'; DELETE FROM chat_thread_state WHERE thread_id='$TR';"
fi

# ---- verdict ----------------------------------------------------------------
echo "=== $PASSES passed, ${#FAILS[@]} failed ==="
if [[ ${#FAILS[@]} -gt 0 ]]; then
  printf '  ANOMALY: %s\n' "${FAILS[@]}"
  if [[ "${PROBE_PING:-0}" == 1 && -r "$HOME/.sully-build.env" ]]; then
    set +u; source "$HOME/.sully-build.env"; set -u
    if [[ -n "${SULLY_BUILD_BOT_TOKEN:-}" && -n "${SULLY_BUILD_CHAT_ID:-}" ]]; then
      MSG=$(printf 'Sully chat probe FAILED (%d)\n%s' "${#FAILS[@]}" "$(printf -- '- %s\n' "${FAILS[@]}")")
      curl -sS "https://api.telegram.org/bot${SULLY_BUILD_BOT_TOKEN}/sendMessage" \
        --data-urlencode chat_id="${SULLY_BUILD_CHAT_ID}" --data-urlencode text="$MSG" >/dev/null 2>&1 || true
    fi
  fi
  exit 1
fi
echo "GREEN — main chat healthy."
exit 0
