# Handoff prompt — paste into the parallel CC instance

Open a fresh `cc` session in a new terminal (any cwd is fine; the prompt
sets the working dir). Paste the block below verbatim as your first message:

---

```
You are CC instance #2 — your only job this session is to fine-tune Qwen3-14B
into Sully's companion-v2 using the bootstrap corpus, then register it with
the local Ollama daemon. Stop there. Do NOT modify any code outside
scripts/finetune/, do NOT touch src/lib/chat/model-registry.ts, do NOT
push commits, do NOT restart services. Main CC handles registry updates
after we review your eval results.

Working dir:
  cd /home/dreighto/dev/LogueOS-Companion

Runbook:
  scripts/finetune/README.md

Execute the six steps in order, one at a time:

  1. bash scripts/finetune/setup_env.sh
  2. source scripts/finetune/.venv/bin/activate
     python scripts/finetune/prepare_blend.py
  3. python scripts/finetune/train_qlora.py
  4. python scripts/finetune/eval_compare.py
  5. bash scripts/finetune/merge_and_gguf.sh
  6. bash scripts/finetune/register_companion_v2.sh

After EACH step, give Captain a plain-English status update of:
  - what happened (1 sentence)
  - whether it worked (yes / no / partial)
  - if not, what specifically broke (don't try to fix — flag it)

Captain is not a coder. Status updates must lead with plain English; put
technical detail (commands, stack traces, file paths) below a --- divider.

Long-running step is #3 (training). Expected ~1-3 hours on the 5060 Ti.
Trainer prints loss every 10 steps and runs eval every 200 — relay one
brief status every ~10 minutes during training, not a flood.

When done, print:
  - eval_compare.py output (base vs tuned loss + 5 samples)
  - confirmation that `ollama list` shows companion-v2
  - smoke-test reply from companion-v2

Then STOP. Don't proceed to wire the new model into the app — main CC owns
that step after Captain reviews your output.

Hard rules:
  - Don't edit any .ts / .svelte / .py file outside scripts/finetune/
  - Don't run pnpm / npm / git push / git commit
  - Don't restart any logueos-* service or Ollama
  - If a step errors: STOP and post the error + diagnosis. Do not retry blindly.
  - The Companion app at :18769 must keep running. Don't touch it.
```

---

After you paste that, Captain — you don't need to do anything else. Step
back here and we'll keep working on the pending list while it runs.
