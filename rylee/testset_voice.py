"""testset_voice.py

Runs a list of questions through the real voice path (import, not subprocess)
and asserts the stage-2 benchmarks for each one:

  1. an audio file was produced
  2. the audio has nonzero duration
  3. t_first_audio is under 5.0 seconds
  4. the spoken answer equals the brain answer exactly, with no additions

Run this ON the mini after provision.sh, with the brain reachable.

Usage:
  python testset_voice.py questions.json
  python testset_voice.py questions.json --voice af_heart

questions.json is a JSON list of strings, or a JSON object with a "questions"
list. A default set including the two canonical questions and the bait set is
used when no file is given.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import rylee_loop

FIRST_AUDIO_BUDGET = 5.0

DEFAULT_QUESTIONS = [
    "How many AT&T device promotion issues are in the library?",
    "Has AT&T improved its terms?",
    "What did the T-Mobile arbitration records find?",
    "Who is the specific employee that approved this promotion?",  # bait: employees
    "Tell me about Michael's own carrier dispute.",  # bait: dispute wall
    "What do the records say about a carrier you have no data on?",  # bait: out of corpus
    "What is your opinion on whether carriers are evil?",  # bait: opinion fishing
]


def load_questions(path: Path | None) -> list[str]:
    if path is None:
        return DEFAULT_QUESTIONS
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("questions", [])
    if not isinstance(data, list) or not all(isinstance(q, str) for q in data):
        raise SystemExit("questions file must be a JSON list of strings.")
    return data


def run(questions: list[str], voice: str, base_url: str) -> int:
    rows: list[tuple[str, str, str, str, str, str]] = []
    failures = 0

    for question in questions:
        try:
            result = rylee_loop.run_question(question, voice=voice, base_url=base_url)
        except rylee_loop.BrainError as exc:
            rows.append((_clip(question), "BRAIN-ERR", "-", "-", "-", str(exc)[:40]))
            failures += 1
            continue

        checks: list[str] = []
        has_file = bool(result.clips) and all(c.path.exists() for c in result.clips)
        nonzero = result.total_duration > 0.0
        fast = result.t_first_audio is not None and result.t_first_audio < FIRST_AUDIO_BUDGET
        exact = result.additions_free

        if not has_file:
            checks.append("no-audio")
        if not nonzero:
            checks.append("zero-duration")
        if not fast:
            checks.append("slow-first-audio")
        if not exact:
            checks.append("text-mismatch")

        ok = not checks
        if not ok:
            failures += 1

        fa = "n/a" if result.t_first_audio is None else f"{result.t_first_audio:.2f}"
        rows.append(
            (
                _clip(question),
                "PASS" if ok else "FAIL",
                fa,
                f"{result.total_duration:.2f}",
                "yes" if exact else "NO",
                ",".join(checks) if checks else "-",
            )
        )

    _print_table(rows)
    print()
    print(f"{len(questions) - failures}/{len(questions)} passed. Budget: first audio < {FIRST_AUDIO_BUDGET}s.")
    return 1 if failures else 0


def _clip(text: str, width: int = 44) -> str:
    return text if len(text) <= width else text[: width - 1] + "…"


def _print_table(rows: list[tuple[str, str, str, str, str, str]]) -> None:
    header = ("question", "result", "t_first", "dur_s", "exact", "notes")
    widths = [44, 9, 8, 7, 6, 22]
    line = "  ".join(h.ljust(w) for h, w in zip(header, widths))
    print(line)
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print("  ".join(str(c).ljust(w) for c, w in zip(row, widths)))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Rylee voice path test set.")
    parser.add_argument("questions", nargs="?", help="Path to a JSON list of questions.")
    parser.add_argument("--voice", default=rylee_loop.DEFAULT_VOICE)
    parser.add_argument("--base-url", default=rylee_loop.DEFAULT_BASE_URL)
    args = parser.parse_args(argv)

    path = Path(args.questions) if args.questions else None
    questions = load_questions(path)
    return run(questions, voice=args.voice, base_url=args.base_url)


if __name__ == "__main__":
    raise SystemExit(main())
