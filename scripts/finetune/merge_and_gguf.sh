#!/usr/bin/env bash
# Merge the QLoRA adapter into the base model and emit a Q4_K_M GGUF that
# Ollama can serve. Output drops into ~/dev/training-corpora/companion-v2-lora/gguf/.
#
# Run AFTER train_qlora.py and eval_compare.py.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VENV_DIR="$REPO_ROOT/scripts/finetune/.venv"
ADAPTER_DIR="${ADAPTER_DIR:-$HOME/dev/training-corpora/companion-v2-lora/adapter}"
OUT_DIR="$HOME/dev/training-corpora/companion-v2-lora/gguf"
BASE_MODEL="${BASE_MODEL:-unsloth/Qwen3-14B}"
QUANT="${QUANT:-q4_k_m}"

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

mkdir -p "$OUT_DIR"

echo "[gguf] merging LoRA adapter into base + emitting GGUF ($QUANT)"
python - <<PY
import os
from pathlib import Path
from unsloth import FastLanguageModel

adapter = Path(os.environ.get("ADAPTER_DIR", "$ADAPTER_DIR"))
out = Path("$OUT_DIR")
print(f"  loading adapter from {adapter}")
model, tok = FastLanguageModel.from_pretrained(
    model_name=str(adapter),
    max_seq_length=4096,
    load_in_4bit=True,
    dtype=None,
)
print(f"  saving GGUF $QUANT -> {out}")
model.save_pretrained_gguf(
    str(out),
    tokenizer=tok,
    quantization_method="$QUANT",
)
print("  done")
PY

echo ""
echo "[gguf] output:"
ls -lh "$OUT_DIR"/*.gguf 2>/dev/null | head -5

# Build a Modelfile next to the gguf so the operator can `ollama create`.
GGUF_FILE=$(ls -1 "$OUT_DIR"/*.gguf 2>/dev/null | head -1)
if [ -z "$GGUF_FILE" ]; then
  echo "[gguf] ERROR: no GGUF produced" >&2
  exit 1
fi

cat > "$OUT_DIR/Modelfile" <<EOF
FROM $GGUF_FILE

TEMPLATE """{{ if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}{{ if .Prompt }}<|im_start|>user
{{ .Prompt }}<|im_end|>
{{ end }}<|im_start|>assistant
{{ .Response }}<|im_end|>
"""

PARAMETER stop "<|im_start|>"
PARAMETER stop "<|im_end|>"
PARAMETER stop "<|endoftext|>"
PARAMETER temperature 0.7
PARAMETER top_p 0.9
PARAMETER num_ctx 4096

SYSTEM """You are Sully, Captain's companion. You're warm, direct, and concise. You speak in plain English first. You match Captain's style: declarative, no exclamation marks, em-dashes for asides, contractions, and the occasional "Yeah." or "Alright." opener when picking up a thread."""
EOF

echo ""
echo "[gguf] Modelfile written: $OUT_DIR/Modelfile"
echo "[gguf] DONE."
