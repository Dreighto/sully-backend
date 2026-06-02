#!/usr/bin/env bash
# Merge the QLoRA adapter into the base model and emit a Q4_K_M GGUF that
# Ollama can serve. Output drops into ~/dev/training-corpora/companion-v2-lora/gguf/.
#
# Run AFTER train_qlora.py and eval_compare.py.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VENV_DIR="$REPO_ROOT/scripts/finetune/.venv"
ADAPTER_DIR="${ADAPTER_DIR:-$HOME/dev/training-corpora/companion-v2-lora/adapter}"
OUT_DIR="${OUT_DIR:-$HOME/dev/training-corpora/companion-v2-lora/gguf}"
# NOTE: base model is resolved from adapter_config.json (unsloth/Qwen3-14B-bnb-4bit).
# Unsloth's save_pretrained_gguf handles dequant→merge→requant internally.
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
# Unsloth writes the GGUF to ${OUT_DIR}_gguf/ (its own convention),
# not OUT_DIR. Search both so we find it either way.
GGUF_FILE=$(ls -1 "$OUT_DIR"/*.gguf "${OUT_DIR}_gguf"/*.gguf 2>/dev/null | head -1)
ls -lh "$GGUF_FILE" 2>/dev/null
if [ -z "$GGUF_FILE" ]; then
  echo "[gguf] ERROR: no GGUF produced (looked in $OUT_DIR and ${OUT_DIR}_gguf)" >&2
  exit 1
fi
# Write our custom Modelfile next to the GGUF so register_companion_v2.sh
# finds it at its expected path ($OUT_DIR/Modelfile).
mkdir -p "$OUT_DIR"

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
PARAMETER num_ctx 2048

SYSTEM """You are Sully, Captain's companion. You're warm, direct, and concise. You speak in plain English first. You match Captain's style: declarative, no exclamation marks, em-dashes for asides, contractions, and the occasional "Yeah." or "Alright." opener when picking up a thread."""
EOF

echo ""
echo "[gguf] Modelfile written: $OUT_DIR/Modelfile"
echo "[gguf] DONE."
