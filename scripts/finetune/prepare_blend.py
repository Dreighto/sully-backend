#!/usr/bin/env python3
# Blend the three corpus dirs into a single training file.
#
# Baseline blend (configurable via flags):
#   1x ch (995 train pairs, planning register)
#   1x cc (2511 train pairs, working register)
#  10x companion (38 train pairs * 10 = 380 effective, in-persona — oversampled
#                 so the smallest-but-on-target source isn't drowned out)
#
# Eval set is a straight concatenation — no oversampling on eval.
#
# Output:
#   <out>/train.jsonl   shuffled blend, ready for SFTTrainer
#   <out>/eval.jsonl    concatenation of per-corpus eval splits
#   <out>/blend.json    record of which mix was used (so we can reproduce v2 exactly)
import argparse
import json
import os
import random
import sys
from datetime import datetime
from pathlib import Path


def load_jsonl(path):
    items = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            items.append(json.loads(line))
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--root",
        default=os.path.expanduser("~/dev/training-corpora"),
        help="Parent dir containing ch-/cc-/companion- subdirs.",
    )
    ap.add_argument("--tag", default="2026-06-01")
    ap.add_argument(
        "--out",
        default=os.path.expanduser("~/dev/training-corpora/blend-v1-2026-06-01"),
    )
    ap.add_argument("--mult-ch", type=int, default=1)
    ap.add_argument("--mult-cc", type=int, default=1)
    ap.add_argument("--mult-companion", type=int, default=10)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    root = Path(args.root)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    sources = [
        ("ch", root / f"ch-{args.tag}", args.mult_ch),
        ("cc", root / f"cc-{args.tag}", args.mult_cc),
        ("companion", root / f"companion-{args.tag}", args.mult_companion),
    ]

    train_blend = []
    eval_concat = []
    record = {"tag": args.tag, "blended_at": datetime.now().isoformat(timespec="seconds"), "sources": {}}

    for name, src_dir, mult in sources:
        train_path = src_dir / "train.jsonl"
        eval_path = src_dir / "eval.jsonl"
        if not train_path.exists():
            print(f"  WARN: {train_path} missing — skipping {name}", file=sys.stderr)
            continue
        train = load_jsonl(train_path)
        evals = load_jsonl(eval_path)
        for rec in train:
            rec.setdefault("meta", {})["source"] = name
        for rec in evals:
            rec.setdefault("meta", {})["source"] = name
        for _ in range(mult):
            train_blend.extend(train)
        eval_concat.extend(evals)
        record["sources"][name] = {
            "dir": str(src_dir),
            "train_pairs": len(train),
            "eval_pairs": len(evals),
            "multiplier": mult,
            "effective_train_pairs": len(train) * mult,
        }
        print(f"  {name:>10s}: {len(train):5d} train * {mult:>2d} = {len(train)*mult:5d}   {len(evals):3d} eval")

    rng.shuffle(train_blend)

    train_out = out / "train.jsonl"
    eval_out = out / "eval.jsonl"
    blend_out = out / "blend.json"

    with open(train_out, "w", encoding="utf-8") as f:
        for rec in train_blend:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    with open(eval_out, "w", encoding="utf-8") as f:
        for rec in eval_concat:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    record["effective_train_pairs"] = len(train_blend)
    record["eval_pairs"] = len(eval_concat)
    with open(blend_out, "w") as f:
        json.dump(record, f, indent=2)

    total_chars = sum(
        len(r["messages"][0]["content"]) + len(r["messages"][1]["content"])
        for r in train_blend
    )
    print()
    print(f"  effective train pairs: {len(train_blend):,}")
    print(f"  eval pairs:            {len(eval_concat):,}")
    print(f"  train chars:           {total_chars:,}  (~{total_chars // 4:,} tokens approx)")
    print(f"  output:                {out}")


if __name__ == "__main__":
    main()
