#!/usr/bin/env bash
# Create a Python venv for the QLoRA fine-tune of Qwen3-14B as
# companion-v2. Uses uv for the venv; pulls the unsloth stack which brings
# its own torch/bitsandbytes/xformers via the cu124 wheel index.
#
# Idempotent: safe to re-run, will reuse the venv if it already exists.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VENV_DIR="$REPO_ROOT/scripts/finetune/.venv"

echo "[setup_env] venv -> $VENV_DIR"

if [ ! -d "$VENV_DIR" ]; then
  uv venv --python 3.12 "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# Torch first with an explicit CUDA-12.4 index — this works against the
# CUDA 13.2 driver on ROOM (forward-compatible) and is what Unsloth's
# install path uses.
uv pip install --upgrade pip
uv pip install --index-strategy unsafe-best-match \
  --extra-index-url https://download.pytorch.org/whl/cu124 \
  "torch==2.5.*" "torchvision==0.20.*"

# Unsloth stack — pulls bitsandbytes, xformers, peft, trl, accelerate,
# transformers, datasets at compatible versions.
uv pip install "unsloth[cu124-torch250]"
uv pip install --upgrade "unsloth"

# Helpers used by our scripts.
uv pip install "huggingface_hub[cli]" sentencepiece protobuf

echo ""
echo "[setup_env] verifying CUDA visibility ..."
python - <<'PY'
import torch
print(f"  torch: {torch.__version__}")
print(f"  CUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"  device:  {torch.cuda.get_device_name(0)}")
    print(f"  vram:    {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")
PY

echo ""
echo "[setup_env] importing unsloth ..."
python -c "from unsloth import FastLanguageModel; print('  unsloth import OK')"

echo ""
echo "[setup_env] DONE. activate with: source $VENV_DIR/bin/activate"
