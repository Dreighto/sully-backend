#!/usr/bin/env python3
# QLoRA fine-tune of Qwen3-14B as Sully's companion-v2.
#
# Loads the blended JSONL produced by prepare_blend.py, applies the Qwen3
# chat template, and runs Unsloth's SFTTrainer for ~3 epochs. Saves the
# LoRA adapter only — merge_and_gguf.sh handles the merge + GGUF step.
#
# Defaults tuned for a 5060 Ti 16 GB:
#   - 4-bit base load (Unsloth's unsloth/Qwen3-14B-bnb-4bit)
#   - max_seq_length = 4096 (covers >95% of pairs without truncation)
#   - per_device_train_batch_size = 2, grad_accum_steps = 4  (effective 8)
#   - learning_rate = 2e-4
#   - warmup_ratio = 0.03
#   - 3 epochs
#
# Expected runtime: ~1-3 hours on a 5060 Ti for ~3500 pairs across 3 epochs.
import argparse
import json
import os
import sys
from pathlib import Path

# Thread caps for CPU side of the pipeline (GMI rec — prevents thread thrash
# while GPU is the bottleneck). Set BEFORE any torch/numpy imports.
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--blend-dir",
        default=os.path.expanduser("~/dev/training-corpora/blend-v1-2026-06-01"),
    )
    ap.add_argument(
        "--out-dir",
        default=os.path.expanduser("~/dev/training-corpora/companion-v2-lora"),
    )
    ap.add_argument("--base-model", default="unsloth/Qwen3-14B-bnb-4bit")
    ap.add_argument("--max-seq-length", type=int, default=4096)
    ap.add_argument("--num-train-epochs", type=float, default=3.0)
    ap.add_argument("--per-device-batch-size", type=int, default=2)
    ap.add_argument("--grad-accum-steps", type=int, default=4)
    ap.add_argument("--learning-rate", type=float, default=2e-4)
    ap.add_argument("--warmup-ratio", type=float, default=0.03)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=32)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument(
        "--resume-from-checkpoint",
        default=None,
        help="Path to a checkpoint dir, or 'auto' to use latest in output_dir",
    )
    args = ap.parse_args()

    # Import here so --help works without unsloth installed.
    from unsloth import FastLanguageModel
    from unsloth.chat_templates import get_chat_template
    from datasets import load_dataset
    from trl import SFTTrainer, SFTConfig

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[train] loading base model: {args.base_model}")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base_model,
        max_seq_length=args.max_seq_length,
        load_in_4bit=True,
        dtype=None,
    )

    # Qwen3 uses ChatML — get_chat_template returns the tokenizer with the
    # right apply_chat_template set up for SFT.
    tokenizer = get_chat_template(tokenizer, chat_template="qwen-2.5")

    print(f"[train] attaching LoRA adapter r={args.lora_r} alpha={args.lora_alpha}")
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.lora_r,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        lora_alpha=args.lora_alpha,
        lora_dropout=0.0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=args.seed,
    )

    train_path = Path(args.blend_dir) / "train.jsonl"
    eval_path = Path(args.blend_dir) / "eval.jsonl"
    print(f"[train] dataset: {train_path}  (eval: {eval_path})")
    ds_train = load_dataset("json", data_files=str(train_path), split="train")
    ds_eval = load_dataset("json", data_files=str(eval_path), split="train")

    def format_with_template(example):
        text = tokenizer.apply_chat_template(
            example["messages"], tokenize=False, add_generation_prompt=False
        )
        return {"text": text}

    ds_train = ds_train.map(format_with_template, remove_columns=ds_train.column_names)
    ds_eval = ds_eval.map(format_with_template, remove_columns=ds_eval.column_names)

    cfg = SFTConfig(
        output_dir=str(out_dir / "checkpoints"),
        per_device_train_batch_size=args.per_device_batch_size,
        gradient_accumulation_steps=args.grad_accum_steps,
        num_train_epochs=args.num_train_epochs,
        learning_rate=args.learning_rate,
        warmup_ratio=args.warmup_ratio,
        logging_steps=10,
        save_steps=200,
        save_total_limit=10,
        eval_strategy="steps",
        eval_steps=200,
        per_device_eval_batch_size=1,
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        bf16=True,
        optim="adamw_8bit",
        weight_decay=0.0,
        lr_scheduler_type="cosine",
        seed=args.seed,
        report_to="none",
        max_seq_length=args.max_seq_length,
        dataset_text_field="text",
        packing=False,
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=ds_train,
        eval_dataset=ds_eval,
        args=cfg,
    )

    print(f"[train] starting — {len(ds_train):,} train / {len(ds_eval):,} eval pairs")
    resume = args.resume_from_checkpoint
    if resume == "auto":
        resume = True
    if resume:
        print(f"[train] resuming from checkpoint: {resume}")
    train_result = trainer.train(resume_from_checkpoint=resume) if resume else trainer.train()

    print(f"[train] saving adapter to {out_dir}")
    trainer.save_model(str(out_dir / "adapter"))
    tokenizer.save_pretrained(str(out_dir / "adapter"))

    with open(out_dir / "train_result.json", "w") as f:
        json.dump(
            {
                "train_runtime_sec": train_result.metrics.get("train_runtime"),
                "train_loss": train_result.metrics.get("train_loss"),
                "global_step": train_result.metrics.get("step", 0),
                "args": vars(args),
            },
            f,
            indent=2,
        )

    print(f"[train] DONE. adapter at {out_dir / 'adapter'}")


if __name__ == "__main__":
    main()
