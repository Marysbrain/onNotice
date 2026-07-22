"""Rylee stage-2 offline voice loop.

Reads a question, asks the brain (the /ask Worker), then speaks the answer
through Kokoro TTS with sentence streaming so the first audio starts before
the whole answer is synthesized.

Binding rules honored here:
  - The mouth adds no facts. It speaks the brain answer verbatim and nothing
    else. If the brain refuses, the refusal is spoken exactly as given.
  - The AI disclosure line is spoken verbatim at session start with --disclose.
  - No em dashes anywhere in this file, in comments, or in spoken text.

This module is import-safe. Heavy dependencies (kokoro-onnx, soundfile, numpy)
are imported lazily inside the real renderer, so tests can inject fakes and run
under plain python with no model present.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from queue import Queue
from typing import Callable, Optional
from urllib import error as urlerror
from urllib import request as urlrequest

DEFAULT_BASE_URL = "https://signal-engine.carriersonnotice.workers.dev"
DEFAULT_VOICE = "af_heart"
DEFAULT_LANG = "en-us"

HOME = Path.home()
RYLEE_HOME = HOME / "rylee"
MODEL_DIR = RYLEE_HOME / "models"
OUT_DIR = RYLEE_HOME / "out"
MODEL_ONNX = MODEL_DIR / "kokoro-v1.0.onnx"
MODEL_VOICES = MODEL_DIR / "voices-v1.0.bin"

BRAIN_TIMEOUT = 20.0


class BrainError(Exception):
    """Raised when the brain cannot be reached or returns an unusable payload."""


# ---------------------------------------------------------------------------
# Sentence splitting. Lossless: "".join(split_sentences(t)) == t.
# A period, bang, or question mark ends a sentence only when it is followed by
# whitespace or the end of the string. That keeps decimals like 3.5 intact.
# ---------------------------------------------------------------------------
def split_sentences(text: str) -> list[str]:
    if not text:
        return []
    parts: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(text)
    terminators = ".!?"
    while i < n:
        ch = text[i]
        buf.append(ch)
        if ch in terminators:
            j = i + 1
            while j < n and text[j] in terminators:
                j += 1
            is_boundary = j >= n or text[j].isspace()
            if is_boundary:
                buf.append(text[i + 1 : j])
                while j < n and text[j].isspace():
                    buf.append(text[j])
                    j += 1
                parts.append("".join(buf))
                buf = []
                i = j
                continue
        i += 1
    if buf:
        parts.append("".join(buf))
    return parts


# ---------------------------------------------------------------------------
# Brain client. One retry maximum, then a clean error. No retry storm.
# ---------------------------------------------------------------------------
def ask_brain(question: str, base_url: str = DEFAULT_BASE_URL) -> dict:
    url = base_url.rstrip("/") + "/ask"
    payload = json.dumps({"question": question}).encode("utf-8")
    last_err: Optional[Exception] = None
    for attempt in range(2):  # one try plus one retry
        try:
            req = urlrequest.Request(
                url,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    # Identify honestly. Cloudflare also rejects the default
                    # Python-urllib agent with a 403, so this is load-bearing.
                    "User-Agent": "rylee-mouth/0.1 (+contact@carriersonnotice.com)",
                },
                method="POST",
            )
            with urlrequest.urlopen(req, timeout=BRAIN_TIMEOUT) as resp:
                raw = resp.read().decode("utf-8")
            data = json.loads(raw)
            return _validate_brain_response(data)
        except (urlerror.URLError, TimeoutError, ConnectionError) as exc:
            last_err = exc
            if attempt == 0:
                time.sleep(0.75)
            continue
        except (json.JSONDecodeError, ValueError) as exc:
            raise BrainError(f"Brain returned an unreadable response: {exc}") from exc
    raise BrainError(
        f"Could not reach the brain at {url}. Tried twice. Last error: {last_err}"
    )


def _validate_brain_response(data: object) -> dict:
    if not isinstance(data, dict):
        raise BrainError("Brain response was not a JSON object.")
    if "answer" not in data or not isinstance(data["answer"], str):
        raise BrainError("Brain response is missing a string answer.")
    data.setdefault("citations", [])
    data.setdefault("tags", {})
    data.setdefault("refused", False)
    data.setdefault("disclosure", "")
    return data


# ---------------------------------------------------------------------------
# What the mouth will speak. This is the fact-integrity seam: the answer part
# is exactly the brain answer, split losslessly. Nothing is added.
# ---------------------------------------------------------------------------
@dataclass
class SpeechPlan:
    disclosure: str  # spoken first only when disclose is on, verbatim
    answer_sentences: list[str]  # concatenation equals the brain answer exactly

    @property
    def spoken_answer(self) -> str:
        return "".join(self.answer_sentences)

    def chunks(self, disclose: bool) -> list[str]:
        chunks: list[str] = []
        if disclose and self.disclosure:
            chunks.append(self.disclosure)
        chunks.extend(self.answer_sentences)
        return chunks


def plan_speech(brain_response: dict) -> SpeechPlan:
    answer = brain_response["answer"]
    disclosure = brain_response.get("disclosure", "") or ""
    if brain_response.get("refused"):
        # Refusal is spoken exactly as given and nothing else. No disclosure
        # appended, no follow up. The brain owns the refusal wording.
        return SpeechPlan(disclosure="", answer_sentences=[answer])
    return SpeechPlan(disclosure=disclosure, answer_sentences=split_sentences(answer))


# ---------------------------------------------------------------------------
# Rendering: text to a wav clip. Real renderer uses Kokoro. Injectable so tests
# and the test set can swap in fakes.
# ---------------------------------------------------------------------------
@dataclass
class Clip:
    path: Path
    duration: float  # seconds
    text: str


Renderer = Callable[[str, str, int], Clip]


class KokoroRenderer:
    """Lazy Kokoro-backed renderer. Loads the model once, on first use."""

    def __init__(
        self,
        voice: str = DEFAULT_VOICE,
        lang: str = DEFAULT_LANG,
        out_dir: Path = OUT_DIR,
        model_onnx: Path = MODEL_ONNX,
        model_voices: Path = MODEL_VOICES,
    ) -> None:
        self.voice = voice
        self.lang = lang
        self.out_dir = out_dir
        self.model_onnx = model_onnx
        self.model_voices = model_voices
        self._kokoro = None
        self._sf = None
        self.session_stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    def _ensure_loaded(self) -> None:
        if self._kokoro is not None:
            return
        try:
            from kokoro_onnx import Kokoro  # type: ignore
            import soundfile as sf  # type: ignore
        except ImportError as exc:
            raise BrainError(
                "kokoro-onnx or soundfile is not installed. Run provision.sh on the mini."
            ) from exc
        if not self.model_onnx.exists() or not self.model_voices.exists():
            raise BrainError(
                f"Kokoro model files missing under {self.model_onnx.parent}. Run provision.sh."
            )
        self._kokoro = Kokoro(str(self.model_onnx), str(self.model_voices))
        self._sf = sf
        self.out_dir.mkdir(parents=True, exist_ok=True)

    def __call__(self, text: str, voice: str, index: int) -> Clip:
        self._ensure_loaded()
        assert self._kokoro is not None and self._sf is not None
        spoken = text.strip()
        samples, sample_rate = self._kokoro.create(
            spoken, voice=voice, speed=1.0, lang=self.lang
        )
        path = self.out_dir / f"{self.session_stamp}_{index:03d}.wav"
        self._sf.write(str(path), samples, sample_rate)
        duration = float(len(samples)) / float(sample_rate) if sample_rate else 0.0
        return Clip(path=path, duration=duration, text=text)


# ---------------------------------------------------------------------------
# Playback: an ordered queue drained by a background thread. Real player shells
# out to afplay. The player records when the first clip actually starts, which
# is what t_first_audio measures.
# ---------------------------------------------------------------------------
class AudioPlayer:
    def __init__(self, play: Optional[Callable[[Path], None]] = None) -> None:
        self._play = play if play is not None else _afplay
        self._queue: "Queue[Optional[Path]]" = Queue()
        self._first_play_time: Optional[float] = None
        self._first_event = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while True:
            path = self._queue.get()
            if path is None:
                break
            if self._first_play_time is None:
                self._first_play_time = time.perf_counter()
                self._first_event.set()
            try:
                self._play(path)
            finally:
                pass

    def enqueue(self, path: Path) -> None:
        self._queue.put(path)

    def wait_first(self, timeout: float) -> bool:
        return self._first_event.wait(timeout=timeout)

    @property
    def first_play_time(self) -> Optional[float]:
        return self._first_play_time

    def finish(self) -> None:
        self._queue.put(None)
        self._thread.join()


def _afplay(path: Path) -> None:
    import subprocess

    subprocess.run(["afplay", str(path)], check=False)


# ---------------------------------------------------------------------------
# The orchestrated run. Returns metrics and the exact spoken answer so the test
# set can assert the no-additions invariant.
# ---------------------------------------------------------------------------
@dataclass
class RunResult:
    question: str
    answer: str
    spoken_answer: str
    disclosure: str
    refused: bool
    clips: list[Clip]
    t_brain: float
    t_first_audio: Optional[float]
    t_total: float
    tags: dict = field(default_factory=dict)
    citations: list = field(default_factory=list)

    @property
    def total_duration(self) -> float:
        return sum(c.duration for c in self.clips)

    @property
    def additions_free(self) -> bool:
        # The spoken answer must equal the brain answer exactly.
        return self.spoken_answer == self.answer


def run_question(
    question: str,
    *,
    voice: str = DEFAULT_VOICE,
    base_url: str = DEFAULT_BASE_URL,
    disclose: bool = False,
    brain: Callable[[str, str], dict] = ask_brain,
    renderer: Optional[Renderer] = None,
    player: Optional[AudioPlayer] = None,
) -> RunResult:
    t0 = time.perf_counter()
    response = brain(question, base_url)
    t_brain = time.perf_counter() - t0

    plan = plan_speech(response)
    chunks = plan.chunks(disclose)

    own_renderer = renderer is None
    render = renderer if renderer is not None else KokoroRenderer(voice=voice)
    own_player = player is None
    play = player if player is not None else AudioPlayer()

    clips: list[Clip] = []
    try:
        for index, chunk in enumerate(chunks):
            if not chunk.strip():
                continue
            clip = render(chunk, voice, index)
            clips.append(clip)
            play.enqueue(clip.path)
        # Give the first clip a moment to actually begin so the timestamp is real.
        play.wait_first(timeout=BRAIN_TIMEOUT)
        first_play = play.first_play_time
    finally:
        if own_player:
            play.finish()

    t_first_audio = (first_play - t0) if first_play is not None else None
    t_total = time.perf_counter() - t0
    _ = own_renderer  # renderer needs no teardown

    return RunResult(
        question=question,
        answer=response["answer"],
        spoken_answer=plan.spoken_answer,
        disclosure=plan.disclosure,
        refused=bool(response.get("refused")),
        clips=clips,
        t_brain=t_brain,
        t_first_audio=t_first_audio,
        t_total=t_total,
        tags=response.get("tags", {}),
        citations=response.get("citations", []),
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _read_question(args_question: Optional[str]) -> str:
    if args_question:
        return args_question
    data = sys.stdin.read().strip()
    return data


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Rylee offline voice loop.")
    parser.add_argument("question", nargs="?", help="Question text. Falls back to stdin.")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help="Kokoro voice name.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Brain base URL.")
    parser.add_argument(
        "--disclose",
        action="store_true",
        help="Speak the AI disclosure line verbatim before the answer.",
    )
    args = parser.parse_args(argv)

    import os

    base_url = os.environ.get("BASE_URL", args.base_url)
    question = _read_question(args.question)
    if not question:
        print("No question provided. Pass it as an argument or on stdin.", file=sys.stderr)
        return 2

    try:
        result = run_question(
            question, voice=args.voice, base_url=base_url, disclose=args.disclose
        )
    except BrainError as exc:
        print(f"Rylee is silent: {exc}", file=sys.stderr)
        return 1

    print(f"Q: {result.question}")
    print(f"A: {result.answer}")
    if result.refused:
        print("(refused: spoken exactly as the brain gave it)")
    print(f"t_brain       {result.t_brain:6.3f} s")
    fa = "n/a" if result.t_first_audio is None else f"{result.t_first_audio:6.3f} s"
    print(f"t_first_audio {fa}")
    print(f"t_total       {result.t_total:6.3f} s")
    print(f"clips         {len(result.clips)} saved under {OUT_DIR}")
    if result.t_first_audio is not None and result.t_first_audio >= 5.0:
        print("WARNING: first audio exceeded the 5.0 second budget.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
