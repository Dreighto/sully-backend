#!/usr/bin/env bash
# Register companion-v2 with the local Ollama daemon, then smoke-test.
# Does NOT touch model-registry.ts — the main CC instance handles that
# after eval review.
set -euo pipefail

OUT_DIR="$HOME/dev/training-corpora/companion-v2-lora/gguf"
MODELFILE="$OUT_DIR/Modelfile"
MODEL_NAME="${MODEL_NAME:-companion-v2}"

if [ ! -f "$MODELFILE" ]; then
  echo "[register] ERROR: no Modelfile at $MODELFILE — run merge_and_gguf.sh first" >&2
  exit 1
fi

echo "[register] ollama create $MODEL_NAME -f $MODELFILE"
ollama create "$MODEL_NAME" -f "$MODELFILE"

echo ""
echo "[register] ollama list:"
ollama list | grep -E "^(NAME|companion-v[12])"

echo ""
echo "[register] smoke test — 'Yeah. How's it going Sully?'"
curl -s http://localhost:11434/api/generate -d "{
  \"model\": \"$MODEL_NAME\",
  \"prompt\": \"Yeah. How's it going Sully?\",
  \"stream\": false
}" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
print('  response:', data.get('response', '').strip()[:400])
"

echo ""
echo "[register] DONE — companion-v2 is in Ollama. NOT YET wired into the app."
echo "[register] Main CC will update src/lib/chat/model-registry.ts after eval review."
