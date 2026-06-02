#!/usr/bin/env python3
# Compare companion-v1 baseline (Qwen3-14B + system prompt only) against
# companion-v2 (the QLoRA-tuned adapter) on the held-out eval set.
#
# Outputs:
#   - token-level loss on each model
#   - 5 sample side-by-side generations (base vs tuned) on real eval prompts
#
# Stop short of any registry / Ollama changes — this is read-only scoring.
import argparse
import json
import math
import os
import random
import sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--blend-dir",
        default=os.path.expanduser("~/dev/training-corpora/blend-v1-2026-06-01"),
    )
    ap.add_argument(
        "--adapter-dir",
        default=os.path.expanduser(
            "~/dev/training-corpora/companion-v2-lora/adapter"
        ),
    )
    ap.add_argument("--base-model", default="unsloth/Qwen3-14B-bnb-4bit")
    ap.add_argument("--max-seq-length", type=int, default=4096)
    ap.add_argument("--n-samples", type=int, default=5)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    import torch
    from unsloth import FastLanguageModel
    from unsloth.chat_templates import get_chat_template
    from datasets import load_dataset

    rng = random.Random(args.seed)
    eval_path = Path(args.blend_dir) / "eval.jsonl"
    ds_eval = load_dataset("json", data_files=str(eval_path), split="train")

    def loss_for_model(model, tokenizer, ds, label):
        model.eval()
        total_loss, total_tokens = 0.0, 0
        for ex in ds:
            text = tokenizer.apply_chat_template(
                ex["messages"], tokenize=False, add_generation_prompt=False
            )
            ids = tokenizer(text, return_tensors="pt", truncation=True,
                            max_length=args.max_seq_length).input_ids.to(model.device)
            with torch.no_grad():
                out = model(input_ids=ids, labels=ids)
            n = ids.shape[1]
            total_loss += float(out.loss) * n
            total_tokens += n
        mean = total_loss / max(total_tokens, 1)
        print(f"  [{label}] mean token loss: {mean:.4f}   perplexity: {math.exp(mean):.2f}")
        return mean

    def sample_for_model(model, tokenizer, prompts, label):
        out = []
        model.eval()
        for p in prompts:
            ids = tokenizer.apply_chat_template(
                [p["messages"][0]],
                tokenize=True, return_tensors="pt", add_generation_prompt=True,
            ).to(model.device)
            with torch.no_grad():
                gen = model.generate(
                    ids,
                    max_new_tokens=200,
                    do_sample=True, temperature=0.7, top_p=0.9,
                    pad_token_id=tokenizer.eos_token_id,
                )
            new = gen[0, ids.shape[1]:]
            out.append(tokenizer.decode(new, skip_special_tokens=True).strip())
        return out

    # 5 samples drawn from eval — same indices for both models
    eval_idx = rng.sample(range(len(ds_eval)), k=min(args.n_samples, len(ds_eval)))
    sample_set = [ds_eval[i] for i in eval_idx]

    print("[eval] loading base ...")
    base_model, base_tok = FastLanguageModel.from_pretrained(
        model_name=args.base_model,
        max_seq_length=args.max_seq_length,
        load_in_4bit=True,
        dtype=None,
    )
    base_tok = get_chat_template(base_tok, chat_template="qwen-2.5")
    FastLanguageModel.for_inference(base_model)
    base_loss = loss_for_model(base_model, base_tok, ds_eval, "base")
    base_samples = sample_for_model(base_model, base_tok, sample_set, "base")
    del base_model
    import gc; gc.collect(); torch.cuda.empty_cache()

    print("[eval] loading tuned ...")
    tuned_model, tuned_tok = FastLanguageModel.from_pretrained(
        model_name=args.adapter_dir,
        max_seq_length=args.max_seq_length,
        load_in_4bit=True,
        dtype=None,
    )
    tuned_tok = get_chat_template(tuned_tok, chat_template="qwen-2.5")
    FastLanguageModel.for_inference(tuned_model)
    tuned_loss = loss_for_model(tuned_model, tuned_tok, ds_eval, "tuned")
    tuned_samples = sample_for_model(tuned_model, tuned_tok, sample_set, "tuned")

    print()
    print("============ RESULTS ============")
    print(f"  base  loss: {base_loss:.4f}   ppl: {math.exp(base_loss):.2f}")
    print(f"  tuned loss: {tuned_loss:.4f}   ppl: {math.exp(tuned_loss):.2f}")
    delta = base_loss - tuned_loss
    pct = (delta / base_loss) * 100.0
    print(f"  delta:      {delta:+.4f}  ({pct:+.1f}% loss reduction)")
    print()
    print("============ SAMPLES ============")
    for i, (ex, b, t) in enumerate(zip(sample_set, base_samples, tuned_samples), 1):
        user = ex["messages"][0]["content"]
        gold = ex["messages"][1]["content"]
        src = ex.get("meta", {}).get("source", "?")
        print(f"-- sample {i} (src={src}) --")
        print(f"  USER:  {user[:200]!r}{'...' if len(user)>200 else ''}")
        print(f"  GOLD:  {gold[:200]!r}{'...' if len(gold)>200 else ''}")
        print(f"  BASE:  {b[:200]!r}{'...' if len(b)>200 else ''}")
        print(f"  TUNED: {t[:200]!r}{'...' if len(t)>200 else ''}")
        print()

    summary = {
        "base_loss": base_loss,
        "tuned_loss": tuned_loss,
        "loss_reduction_pct": pct,
        "samples": [
            {"user": ex["messages"][0]["content"], "gold": ex["messages"][1]["content"],
             "base": b, "tuned": t, "source": ex.get("meta", {}).get("source")}
            for ex, b, t in zip(sample_set, base_samples, tuned_samples)
        ],
    }
    out = Path(args.adapter_dir).parent / "eval_compare.json"
    with open(out, "w") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print(f"[eval] wrote {out}")


if __name__ == "__main__":
    main()
