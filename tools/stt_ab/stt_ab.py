#!/usr/bin/env python3
"""STT accuracy A/B harness — turn "did recognition get better?" into a NUMBER.

Feeds a set of WAV clips (each with a KNOWN ground-truth transcript) to one or
more live STT endpoints and reports Word Error Rate (WER), domain-keyword recall,
and latency per config. Same clips + same scoring across every config, so two
runs are directly comparable: "medium-q5 = 22% WER → turbo-q8 = 9% WER".

The endpoint it hits is the SAME one the companion app uses for transcription:
the Jetson STT — POST raw PCM16 (16 kHz mono Int16-LE) to http://10.10.10.2:18780/stt,
response {"text": "..."} (see companion-speech/jetson_vad_stt_bridge.py:_stt).
So a clip's score reflects the real deployed path, not a lab proxy.

Pure stdlib (wave + audioop + urllib + argparse). No pip install. Run it on ROOM
(reaches the Jetson over the now-clean 10.10.10.2 link) or on the Jetson itself.

USAGE
  # one config (the current live STT):
  python3 stt_ab.py --manifest phrases.tsv --clips ~/voice_capture \\
      --config "current=http://10.10.10.2:18780/stt"

  # A/B two models (e.g. current vs a turbo service on another port):
  python3 stt_ab.py --manifest phrases.tsv --clips ~/voice_capture \\
      --config "medium-q5=http://10.10.10.2:18780/stt" \\
      --config "turbo-q8=http://10.10.10.2:18791/stt"

The usual single-box flow is: run once against the live endpoint (baseline),
swap the Jetson whisper model + restart the service, run again with a different
--config label, then diff the two reports. Each run writes results/<label>...md+json.

MANIFEST (TSV, one clip per line):  <wav-name-or-relpath> \\t <ground-truth text>
Lines starting with # and blank lines are ignored. Paths resolve against --clips
(or are absolute). Ground truth is what was ACTUALLY said — record a known script;
do NOT reuse an STT's own past output as the reference (that scores it against
itself). See README.md.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import wave
from datetime import datetime
from statistics import mean, median

try:
    import audioop  # stdlib through 3.12; removed in 3.13
except Exception:  # pragma: no cover
    audioop = None

import urllib.request

TARGET_SR = 16000


# ── audio ──────────────────────────────────────────────────────────────────────
def wav_to_pcm16_16k(path: str) -> bytes:
    """Read a WAV → 16 kHz mono Int16-LE PCM bytes (resample/downmix as needed)."""
    with wave.open(path, "rb") as w:
        ch, width, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        pcm = w.readframes(n)
    if width != 2:
        if audioop is None:
            raise RuntimeError(f"{path}: {width*8}-bit; need 16-bit (audioop unavailable to convert)")
        pcm = audioop.lin2lin(pcm, width, 2)
        width = 2
    if ch == 2:
        if audioop is None:
            raise RuntimeError(f"{path}: stereo; need mono (audioop unavailable to downmix)")
        pcm = audioop.tomono(pcm, 2, 0.5, 0.5)
    elif ch != 1:
        raise RuntimeError(f"{path}: {ch} channels; only mono/stereo supported")
    if sr != TARGET_SR:
        if audioop is None:
            raise RuntimeError(f"{path}: {sr} Hz; need {TARGET_SR} (audioop unavailable to resample)")
        pcm, _ = audioop.ratecv(pcm, 2, 1, sr, TARGET_SR, None)
    return pcm


# ── transcription ───────────────────────────────────────────────────────────────
def transcribe(endpoint: str, pcm16: bytes, timeout: float) -> tuple[str, float]:
    """POST raw PCM16 → (transcript, latency_ms). Raises on transport/HTTP error."""
    req = urllib.request.Request(
        endpoint, data=pcm16, headers={"Content-Type": "application/octet-stream"}, method="POST"
    )
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    dt = (time.monotonic() - t0) * 1000.0
    try:
        text = json.loads(body).get("text", "")
    except Exception:
        text = body.decode("utf-8", "replace")
    return (text or "").strip(), dt


# ── scoring ──────────────────────────────────────────────────────────────────────
_WORD = re.compile(r"[a-z0-9']+")


def normalize(text: str) -> list[str]:
    """lowercase, strip punctuation, collapse to a word list (numbers kept as-is)."""
    return _WORD.findall((text or "").lower())


def wer(ref: list[str], hyp: list[str]) -> tuple[float, int, int, int, int]:
    """Levenshtein word-edit-distance WER → (wer, subs, dels, ins, ref_len)."""
    R, H = len(ref), len(hyp)
    if R == 0:
        return (0.0 if H == 0 else 1.0, 0, 0, H, 0)
    # DP grid of (cost, S, D, I)
    prev = [(j, 0, 0, j) for j in range(H + 1)]
    for i in range(1, R + 1):
        cur = [(i, 0, i, 0)] + [(0, 0, 0, 0)] * H
        for j in range(1, H + 1):
            if ref[i - 1] == hyp[j - 1]:
                cur[j] = (prev[j - 1][0], prev[j - 1][1], prev[j - 1][2], prev[j - 1][3])
                continue
            sub = (prev[j - 1][0] + 1, prev[j - 1][1] + 1, prev[j - 1][2], prev[j - 1][3])
            dele = (prev[j][0] + 1, prev[j][1], prev[j][2] + 1, prev[j][3])
            ins = (cur[j - 1][0] + 1, cur[j - 1][1], cur[j - 1][2], cur[j - 1][3] + 1)
            cur[j] = min(sub, dele, ins, key=lambda t: t[0])
        prev = cur
    cost, s, d, ins = prev[H]
    return (cost / R, s, d, ins, R)


def keyword_recall(pairs: list[tuple[list[str], list[str]]], keywords: list[str]) -> dict:
    """Per-keyword recall: of the refs containing kw, how many hyps also contain it."""
    out = {}
    for kw in keywords:
        k = kw.lower()
        present = [(ref, hyp) for ref, hyp in pairs if k in ref]
        if not present:
            continue
        hit = sum(1 for _, hyp in present if k in hyp)
        out[kw] = {"hit": hit, "total": len(present), "recall": hit / len(present)}
    return out


# ── manifest ─────────────────────────────────────────────────────────────────────
def load_manifest(path: str, clips_dir: str) -> list[tuple[str, str, str]]:
    """Return (clip_id, abs_wav_path, ref_text). Errors loudly on a missing clip."""
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for ln, raw in enumerate(f, 1):
            line = raw.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if "\t" not in line:
                sys.exit(f"manifest line {ln}: expected '<wav>\\t<text>', got: {line!r}")
            name, ref = line.split("\t", 1)
            name, ref = name.strip(), ref.strip()
            wav = name if os.path.isabs(name) else os.path.join(clips_dir, name)
            if not os.path.isfile(wav):
                sys.exit(f"manifest line {ln}: clip not found: {wav}")
            rows.append((name, wav, ref))
    if not rows:
        sys.exit(f"manifest {path} has no clips")
    return rows


# ── main ─────────────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(description="STT accuracy A/B harness (WER + keyword recall + latency)")
    ap.add_argument("--manifest", required=True, help="TSV: <wav>\\t<ground-truth text>")
    ap.add_argument("--clips", default=".", help="dir for relative clip paths (default: cwd)")
    ap.add_argument(
        "--config", action="append", required=True, metavar="LABEL=URL",
        help="STT endpoint to test; repeatable. e.g. current=http://10.10.10.2:18780/stt",
    )
    ap.add_argument(
        "--keywords",
        default="jetson,orin,nano,dispatch,companion,sully,logueos,kokoro,whisper,workspace",
        help="comma-separated domain terms to score recall on",
    )
    ap.add_argument("--timeout", type=float, default=60.0, help="per-clip POST timeout (s)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__) or ".", "results"))
    args = ap.parse_args()

    configs = []
    for c in args.config:
        if "=" not in c:
            sys.exit(f"--config must be LABEL=URL, got: {c!r}")
        label, url = c.split("=", 1)
        configs.append((label.strip(), url.strip()))
    keywords = [k.strip() for k in args.keywords.split(",") if k.strip()]

    rows = load_manifest(args.manifest, args.clips)
    print(f"clips: {len(rows)}   configs: {', '.join(l for l, _ in configs)}\n")

    # cache decoded audio once (same bytes hit every config)
    audio = {cid: wav_to_pcm16_16k(wav) for cid, wav, _ in rows}

    # results[label] = list of per-clip dicts
    results: dict[str, list[dict]] = {label: [] for label, _ in configs}
    for label, url in configs:
        print(f"── {label}  ({url}) ──")
        for cid, _wav, ref in rows:
            ref_w = normalize(ref)
            try:
                hyp, ms = transcribe(url, audio[cid], args.timeout)
                er, s, d, ins, n = wer(ref_w, normalize(hyp))
                err = None
            except Exception as e:
                hyp, ms, er, s, d, ins, n, err = "", 0.0, 1.0, 0, len(ref_w), 0, len(ref_w), str(e)
            results[label].append(
                {"clip": cid, "ref": ref, "hyp": hyp, "wer": er, "subs": s, "dels": d,
                 "ins": ins, "ref_len": n, "latency_ms": ms, "error": err}
            )
            flag = f"  ERR: {err}" if err else ""
            print(f"  {cid:<24} WER {er*100:5.1f}%  {ms:6.0f}ms  hyp={hyp!r}{flag}")
        print()

    # aggregates
    summary = {}
    for label, _ in configs:
        rs = results[label]
        wers = [r["wer"] for r in rs]
        # corpus WER = total errors / total ref words (the honest aggregate)
        tot_err = sum(r["subs"] + r["dels"] + r["ins"] for r in rs)
        tot_ref = sum(r["ref_len"] for r in rs) or 1
        pairs = [(normalize(r["ref"]), normalize(r["hyp"])) for r in rs]
        summary[label] = {
            "clips": len(rs),
            "corpus_wer": tot_err / tot_ref,
            "mean_wer": mean(wers) if wers else 0.0,
            "median_wer": median(wers) if wers else 0.0,
            "mean_latency_ms": mean([r["latency_ms"] for r in rs]) if rs else 0.0,
            "errors": sum(1 for r in rs if r["error"]),
            "keyword_recall": keyword_recall(pairs, keywords),
        }

    # report
    os.makedirs(args.out, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = os.path.join(args.out, f"stt_ab_{stamp}")
    md = _render_md(stamp, rows, configs, results, summary, keywords)
    with open(base + ".md", "w", encoding="utf-8") as f:
        f.write(md)
    with open(base + ".json", "w", encoding="utf-8") as f:
        json.dump({"stamp": stamp, "summary": summary, "results": results}, f, indent=2)

    print("\n" + md)
    print(f"\nwrote {base}.md  +  {base}.json")
    return 0


def _render_md(stamp, rows, configs, results, summary, keywords) -> str:
    L = [l for l, _ in configs]
    out = [f"# STT A/B — {stamp}", "", f"Clips: **{len(rows)}** · Configs: {', '.join(L)}", ""]
    out += ["## Summary (lower WER = better)", "",
            "| Config | Corpus WER | Mean WER | Median WER | Mean latency | Errors |",
            "| --- | --- | --- | --- | --- | --- |"]
    for label in L:
        s = summary[label]
        out.append(f"| {label} | **{s['corpus_wer']*100:.1f}%** | {s['mean_wer']*100:.1f}% | "
                   f"{s['median_wer']*100:.1f}% | {s['mean_latency_ms']:.0f} ms | {s['errors']} |")
    out += ["", "## Domain-keyword recall (did it catch the proper nouns?)", "",
            "| Keyword | " + " | ".join(L) + " |", "| --- |" + " --- |" * len(L)]
    allkw = sorted({k for label in L for k in summary[label]["keyword_recall"]})
    for kw in allkw:
        cells = []
        for label in L:
            r = summary[label]["keyword_recall"].get(kw)
            cells.append(f"{r['hit']}/{r['total']} ({r['recall']*100:.0f}%)" if r else "—")
        out.append(f"| {kw} | " + " | ".join(cells) + " |")
    if not allkw:
        out.append("| _(no manifest refs contained the keywords)_ |" + " |" * len(L))
    out += ["", "## Per-clip", "",
            "| Clip | Reference | " + " | ".join(f"{label} (WER)" for label in L) + " |",
            "| --- | --- |" + " --- |" * len(L)]
    by_clip = {cid: {} for cid, _, _ in rows}
    for label in L:
        for r in results[label]:
            by_clip[r["clip"]][label] = r
    for cid, _wav, ref in rows:
        cells = []
        for label in L:
            r = by_clip[cid][label]
            txt = f"err: {r['error']}" if r["error"] else r["hyp"]
            cells.append(f"{txt} ({r['wer']*100:.0f}%)")
        out.append(f"| {cid} | {ref} | " + " | ".join(cells) + " |")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
