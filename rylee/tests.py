"""tests.py

Offline checks that run with plain python. No pytest, no kokoro, no model.
These validate the two things that can be verified without the mini:

  - the sentence splitter is lossless and does not break decimals
  - the mouth adds no facts: what gets sent to the synth equals the brain
    answer exactly, and refusals are spoken verbatim with nothing appended

Run:  python tests.py
"""

from __future__ import annotations

from pathlib import Path

import rylee_loop
from rylee_loop import AudioPlayer, Clip, RunResult, plan_speech, run_question, split_sentences

_failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    status = "ok  " if condition else "FAIL"
    print(f"[{status}] {name}{('  ' + detail) if detail and not condition else ''}")
    if not condition:
        _failures.append(name)


# ---------------------------------------------------------------------------
# Splitter
# ---------------------------------------------------------------------------
def test_split_lossless() -> None:
    samples = [
        "",
        "One sentence only",
        "First. Second. Third.",
        "Is that so? Yes it is! Good.",
        "AT&T had 2,466 records. Verizon had 3,178.",
        "The rate rose 3.5 percent last year. That matters.",
        "Really?! No way... okay then.",
        "Trailing space. ",
    ]
    for text in samples:
        parts = split_sentences(text)
        rejoined = "".join(parts)
        check(f"lossless join: {text!r}", rejoined == text, f"got {rejoined!r}")


def test_split_keeps_decimals() -> None:
    parts = split_sentences("The rate rose 3.5 percent. Done.")
    check("decimal 3.5 stays intact", any("3.5" in p for p in parts), str(parts))
    check("splits into two sentences", len(parts) == 2, str(parts))


def test_split_counts() -> None:
    parts = split_sentences("First. Second. Third.")
    check("three sentences counted", len(parts) == 3, str(parts))


# ---------------------------------------------------------------------------
# No-additions invariant, using fakes. No numpy or soundfile needed.
# ---------------------------------------------------------------------------
class RecordingRenderer:
    def __init__(self) -> None:
        self.rendered: list[str] = []

    def __call__(self, text: str, voice: str, index: int) -> Clip:
        self.rendered.append(text)
        return Clip(path=Path("/dev/null"), duration=1.0, text=text)


def _fake_brain(answer: str, refused: bool = False, disclosure: str = "") -> object:
    def brain(question: str, base_url: str) -> dict:
        return {
            "answer": answer,
            "citations": [],
            "tags": {"carrier": "att", "topic": "promo", "sentiment": "neutral"},
            "refused": refused,
            "disclosure": disclosure,
        }

    return brain


def _silent_player() -> AudioPlayer:
    return AudioPlayer(play=lambda path: None)


def test_no_additions_normal() -> None:
    answer = "AT&T has 2,466 verified records. That is what the library holds."
    renderer = RecordingRenderer()
    result: RunResult = run_question(
        "how many att",
        brain=_fake_brain(answer, disclosure="This voice is AI."),
        renderer=renderer,
        player=_silent_player(),
        disclose=False,
    )
    check("spoken answer equals brain answer", result.spoken_answer == answer)
    check("additions_free is true", result.additions_free)
    check("rendered concatenation equals answer", "".join(renderer.rendered) == answer)


def test_disclosure_added_but_answer_untouched() -> None:
    answer = "AT&T has 2,466 verified records."
    disclosure = "I am Rylee, an AI. Everything I say comes from verified records."
    renderer = RecordingRenderer()
    result = run_question(
        "how many att",
        brain=_fake_brain(answer, disclosure=disclosure),
        renderer=renderer,
        player=_silent_player(),
        disclose=True,
    )
    check("disclosure spoken first", renderer.rendered[0] == disclosure)
    check("answer still exact after disclosure", result.spoken_answer == answer)
    check(
        "only disclosure plus answer spoken",
        "".join(renderer.rendered) == disclosure + answer,
    )


def test_refusal_spoken_verbatim() -> None:
    refusal = "I do not discuss individual employees. I report on companies and practices."
    renderer = RecordingRenderer()
    result = run_question(
        "name the employee",
        brain=_fake_brain(refusal, refused=True, disclosure="I am an AI."),
        renderer=renderer,
        player=_silent_player(),
        disclose=True,  # even with disclose on, a refusal is spoken alone
    )
    check("refusal spoken exactly", result.spoken_answer == refusal)
    check("refusal is the only utterance", renderer.rendered == [refusal])
    check("refused flag propagated", result.refused)


def test_metrics_present() -> None:
    answer = "First fact here. Second fact here."
    result = run_question(
        "q",
        brain=_fake_brain(answer),
        renderer=RecordingRenderer(),
        player=_silent_player(),
    )
    check("t_first_audio measured", result.t_first_audio is not None)
    check("t_first_audio under budget", (result.t_first_audio or 99) < 5.0)
    check("two clips produced", len(result.clips) == 2)
    check("total duration nonzero", result.total_duration > 0.0)


# ---------------------------------------------------------------------------
# Brain response validation
# ---------------------------------------------------------------------------
def test_validate_rejects_bad_payloads() -> None:
    for bad in [[], {"answer": 5}, {"nope": 1}, "string"]:
        raised = False
        try:
            rylee_loop._validate_brain_response(bad)  # noqa: SLF001
        except rylee_loop.BrainError:
            raised = True
        check(f"rejects payload {bad!r}", raised)


def test_validate_fills_defaults() -> None:
    out = rylee_loop._validate_brain_response({"answer": "hi"})  # noqa: SLF001
    check("defaults refused", out["refused"] is False)
    check("defaults citations", out["citations"] == [])
    check("defaults disclosure", out["disclosure"] == "")


def main() -> int:
    test_split_lossless()
    test_split_keeps_decimals()
    test_split_counts()
    test_no_additions_normal()
    test_disclosure_added_but_answer_untouched()
    test_refusal_spoken_verbatim()
    test_metrics_present()
    test_validate_rejects_bad_payloads()
    test_validate_fills_defaults()
    print()
    if _failures:
        print(f"{len(_failures)} check(s) failed: {', '.join(_failures)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
