# Sully companion-v2 QLoRA runbook

This dir contains everything needed to fine-tune **Qwen3-14B** into **Sully's
companion-v2** on Captain's bootstrap corpus (CH chats + CC sessions + in-app
Sully chats), then register the result with the local Ollama daemon.

## What gets produced

| Artifact                         | Path                                                         |
| -------------------------------- | ------------------------------------------------------------ |
| Blended training data            | `~/dev/training-corpora/blend-v1-2026-06-01/`                |
| LoRA adapter + checkpoints       | `~/dev/training-corpora/companion-v2-lora/`                  |
| Merged GGUF (Q4_K_M) + Modelfile | `~/dev/training-corpora/companion-v2-lora/gguf/`             |
| Ollama model `companion-v2`      | `ollama list`                                                |
| Eval comparison vs base          | `~/dev/training-corpora/companion-v2-lora/eval_compare.json` |

## Hardware

ROOM box only — needs the **5060 Ti 16 GB**. Verify before starting:

```
nvidia-smi  # confirms CUDA 13.2, RTX 5060 Ti visible, free VRAM > 14 GB
```

## Runbook

Run each step in order. Each step is **idempotent and re-runnable** if something
fails partway. Total wall-clock: **roughly 1-3 hours** (download + train).

### 1. Environment

```bash
bash scripts/finetune/setup_env.sh
```

Creates `scripts/finetune/.venv` and installs Unsloth + Torch (cu124 wheels).
Verifies CUDA is visible from PyTorch. ~10 minutes first run.

### 2. Blend the corpora

```bash
source scripts/finetune/.venv/bin/activate
python scripts/finetune/prepare_blend.py
```

Default blend = 1× CH + 1× CC + 10× Companion oversample, shuffled with seed 42.
Writes `~/dev/training-corpora/blend-v1-2026-06-01/{train,eval}.jsonl` plus a
`blend.json` recording the exact mix. ~5 seconds.

To try a different mix:

```bash
python scripts/finetune/prepare_blend.py --mult-companion 5
```

### 3. Train

```bash
python scripts/finetune/train_qlora.py
```

Loads `unsloth/Qwen3-14B-bnb-4bit`, attaches LoRA (r=16, α=32), trains 3 epochs
with effective batch size 8 (per_device=2 × grad_accum=4), saves the adapter to
`~/dev/training-corpora/companion-v2-lora/adapter/`.

Defaults are tuned for the 5060 Ti — should keep VRAM under 15 GB. First run
will download the base model (~9 GB). Logs every 10 steps; evals every 200.

### 4. Compare base vs tuned

```bash
python scripts/finetune/eval_compare.py
```

Loads base Qwen3-14B and the tuned model in sequence, scores each on the
held-out eval set, generates 5 side-by-side samples. Writes `eval_compare.json`.
Print a summary including:

- Mean token loss + perplexity for each model
- Loss reduction percentage
- 5 (USER, GOLD, BASE, TUNED) samples for qualitative review

### 5. Merge + GGUF

```bash
bash scripts/finetune/merge_and_gguf.sh
```

Merges the LoRA adapter into the full base, exports a Q4_K_M GGUF + a Modelfile
to `~/dev/training-corpora/companion-v2-lora/gguf/`. ~5-10 minutes.

### 6. Register with Ollama

```bash
bash scripts/finetune/register_companion_v2.sh
```

`ollama create companion-v2 -f Modelfile`, then sends a quick smoke prompt
(`"Yeah. How's it going Sully?"`) and prints the response.

**STOPS THERE.** Does NOT touch `src/lib/chat/model-registry.ts` — main CC
instance handles registry updates after the operator approves the eval results.

## Scope guards for the parallel CC instance running this

- Touch nothing outside `scripts/finetune/` and `~/dev/training-corpora/`
- Do not push commits or modify the registry / Ollama-using code
- Do not run the dev server or restart services
- If you hit a real error: STOP, post a plain-English diagnosis, wait for main CC

## Knobs you might want to tune

| Knob                                           | Default  | When to change                                                                           |
| ---------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `--mult-companion` (`prepare_blend.py`)        | 10       | If tuned model loses warmth, raise to 15-20. If it overfits to short replies, drop to 5. |
| `--num-train-epochs` (`train_qlora.py`)        | 3        | If eval loss plateaus early in logs, drop to 2.                                          |
| `--lora-r` / `--lora-alpha` (`train_qlora.py`) | 16 / 32  | Bigger r = more capacity but slower + more VRAM. r=8 is the cheap fallback if OOM.       |
| `--per-device-batch-size` (`train_qlora.py`)   | 2        | Drop to 1 if OOM mid-epoch; bump grad_accum to keep effective batch.                     |
| `QUANT` env var (`merge_and_gguf.sh`)          | `q4_k_m` | `q5_k_m` for higher quality / more VRAM at inference; `q4_0` for smallest.               |
