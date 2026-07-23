"""render_script.py

Produced-lane voice renderer for Rylee's two-anchor desk. Reads a JSON script
of lines and renders each with Chatterbox TTS (MIT), inserts fixed gaps between
lines, applies a light ffmpeg master, and writes one wav and one 64 kbps mp3.

Binding rules honored here:
  1. The mouth adds no facts. Each line is spoken exactly as written. The
     concatenation of everything sent to the engine equals the concatenation of
     the input line texts, byte for byte. Emotion and pace set delivery only.
  2. Engine is Chatterbox (MIT, resemble-ai/chatterbox). No cloud TTS.
  3. Everything under ~/rylee/produced. Uses the produced venv.
  4. No em dashes anywhere, in code, comments, or defaults.

Script schema (a JSON list):
  [
    {"speaker": "rylee" | "co", "text": str, "emotion": float, "pace": float},
    ...
  ]
  emotion is 0..1 (0 flat, 1 most expressive) and maps to Chatterbox's
  exaggeration control. pace is a speaking-rate hint (1.0 neutral, lower is
  slower and more deliberate) and maps to Chatterbox's cfg_weight, which is the
  cadence control the engine actually exposes. There is no literal words-per-
  minute dial in Chatterbox, so pace shapes delivery, it does not retime audio.

This module is import-safe. torch, torchaudio, and chatterbox are imported
lazily inside the renderer so the schema validator and the no-additions
invariant can be tested under plain python with no model present.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

HOME = Path.home()
PRODUCED = HOME / "rylee" / "produced"
DEFAULT_MODELS = PRODUCED / "models"
DEFAULT_OUT = PRODUCED / "out"

# Non-login shells (ssh commands, launchd, cron) do not carry Homebrew's PATH,
# so resolve ffmpeg explicitly instead of trusting the environment.
FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"

SPEAKERS = ("rylee", "co")
DEFAULT_GAP_MS = 350

# Delivery bands. Chatterbox generate() takes exaggeration (emotion intensity,
# default 0.5) and cfg_weight (cadence, default 0.5, lower is slower).
EXAG_MIN, EXAG_MAX = 0.25, 0.85
CFG_MIN, CFG_MAX = 0.30, 0.70

# When no reference wav is supplied a speaker uses Chatterbox's single built in
# voice. To keep the two anchors distinguishable we bias their default delivery
# slightly. This is a fallback only. True distinct timbre needs two reference
# wavs, one per speaker, passed with --ref-rylee and --ref-co.
SPEAKER_BIAS = {
    "rylee": {"exag": 0.03, "cfg": 0.00},
    "co": {"exag": -0.03, "cfg": 0.04},
}


class ScriptError(Exception):
    """Raised when a script fails schema validation."""


# ---------------------------------------------------------------------------
# Schema validation. Deterministic, no model needed.
# ---------------------------------------------------------------------------
def validate_line(line: object, index: int) -> dict:
    if not isinstance(line, dict):
        raise ScriptError(f"line {index}: not a JSON object")
    speaker = line.get("speaker")
    if speaker not in SPEAKERS:
        raise ScriptError(
            f"line {index}: speaker must be one of {SPEAKERS}, got {speaker!r}"
        )
    text = line.get("text")
    if not isinstance(text, str) or text == "":
        raise ScriptError(f"line {index}: text must be a non-empty string")
    if chr(0x2014) in text or chr(0x2013) in text:
        raise ScriptError(f"line {index}: em or en dash is not allowed in text")
    emotion = line.get("emotion", 0.5)
    pace = line.get("pace", 1.0)
    if not _is_number(emotion) or not 0.0 <= float(emotion) <= 1.0:
        raise ScriptError(f"line {index}: emotion must be a number in 0..1")
    if not _is_number(pace) or not 0.25 <= float(pace) <= 2.0:
        raise ScriptError(f"line {index}: pace must be a number in 0.25..2.0")
    return {
        "speaker": speaker,
        "text": text,
        "emotion": float(emotion),
        "pace": float(pace),
    }


def _is_number(x: object) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def validate_script(obj: object) -> list[dict]:
    if not isinstance(obj, list) or not obj:
        raise ScriptError("script must be a non-empty JSON list")
    return [validate_line(line, i) for i, line in enumerate(obj)]


def load_script(path: Path) -> list[dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return validate_script(data)


# ---------------------------------------------------------------------------
# The fact-integrity seam. The exact text sent to the engine for each line is
# the line text, unchanged. Nothing is added, trimmed, or reordered.
# ---------------------------------------------------------------------------
def line_spoken_text(line: dict) -> str:
    return line["text"]


def spoken_texts(script: list[dict]) -> list[str]:
    return [line_spoken_text(line) for line in script]


def concatenated_spoken(script: list[dict]) -> str:
    return "".join(spoken_texts(script))


def concatenated_input(script: list[dict]) -> str:
    return "".join(line["text"] for line in script)


# ---------------------------------------------------------------------------
# Delivery mapping. emotion -> exaggeration, pace -> cfg_weight, plus a small
# per speaker bias when running on the built in voice.
# ---------------------------------------------------------------------------
def _clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def delivery_for(line: dict, has_ref: bool) -> tuple[float, float]:
    emotion = line["emotion"]
    pace = line["pace"]
    exag = EXAG_MIN + emotion * (EXAG_MAX - EXAG_MIN)
    # pace 1.0 -> mid cfg; slower pace lowers cfg (more deliberate cadence).
    cfg = 0.5 + (pace - 1.0) * 0.4
    if not has_ref:
        bias = SPEAKER_BIAS.get(line["speaker"], {"exag": 0.0, "cfg": 0.0})
        exag += bias["exag"]
        cfg += bias["cfg"]
    return _clamp(exag, EXAG_MIN, EXAG_MAX), _clamp(cfg, CFG_MIN, CFG_MAX)


# ---------------------------------------------------------------------------
# Rendering.
# ---------------------------------------------------------------------------
@dataclass
class RenderConfig:
    models_dir: Path = DEFAULT_MODELS
    out_dir: Path = DEFAULT_OUT
    out_name: str = "segment"
    gap_ms: int = DEFAULT_GAP_MS
    device: Optional[str] = None  # auto if None
    ref_rylee: Optional[Path] = None
    ref_co: Optional[Path] = None
    temperature: float = 0.7


def _pick_device(requested: Optional[str]):
    import torch

    if requested:
        return requested
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def render(script: list[dict], cfg: RenderConfig) -> dict:
    """Render a validated script to wav and mp3. Returns a metrics dict."""
    import torch
    import torchaudio
    from chatterbox.tts import ChatterboxTTS

    refs = {"rylee": cfg.ref_rylee, "co": cfg.ref_co}

    device = _pick_device(cfg.device)
    print(f"[render] device={device}")
    t_load0 = time.perf_counter()
    model = ChatterboxTTS.from_local(str(cfg.models_dir), device)
    sr = model.sr
    builtin_conds = model.conds  # the shipped built in voice, kept for reuse
    print(f"[render] model loaded in {time.perf_counter() - t_load0:.1f}s sr={sr}")

    cfg.out_dir.mkdir(parents=True, exist_ok=True)
    gap = torch.zeros(1, int(sr * cfg.gap_ms / 1000.0))

    pieces: list = []
    per_line: list[tuple[int, str, float]] = []
    current_ref: Optional[Path] = None
    total0 = time.perf_counter()

    for i, line in enumerate(script):
        speaker = line["speaker"]
        ref = refs.get(speaker)
        has_ref = ref is not None
        exag, cfgw = delivery_for(line, has_ref)

        # Seat the right conditioning so a reference voice never bleeds into a
        # built in voice line, and vice versa.
        if has_ref:
            if current_ref != ref:
                model.prepare_conditionals(str(ref), exaggeration=exag)
                current_ref = ref
        else:
            model.conds = builtin_conds
            current_ref = None

        t0 = time.perf_counter()
        wav = model.generate(
            line_spoken_text(line),
            exaggeration=exag,
            cfg_weight=cfgw,
            temperature=cfg.temperature,
        )
        dt = time.perf_counter() - t0
        wav = wav.detach().cpu()
        if wav.dim() == 1:
            wav = wav.unsqueeze(0)
        pieces.append(wav)
        if i < len(script) - 1:
            pieces.append(gap)
        per_line.append((i, speaker, dt))
        preview = line["text"][:48]
        print(
            f"[render] line {i:02d} {speaker:5s} "
            f"exag={exag:.2f} cfg={cfgw:.2f} {dt:6.2f}s  {preview!r}"
        )

    total_render = time.perf_counter() - total0
    raw = torch.cat(pieces, dim=1)
    raw_path = cfg.out_dir / f"{cfg.out_name}.raw.wav"
    torchaudio.save(str(raw_path), raw, sr)

    wav_path = cfg.out_dir / f"{cfg.out_name}.wav"
    mp3_path = cfg.out_dir / f"{cfg.out_name}.mp3"
    _master(raw_path, wav_path, mp3_path)
    raw_path.unlink(missing_ok=True)

    audio_seconds = raw.shape[1] / float(sr)
    print(
        f"[render] total render {total_render:.1f}s for {audio_seconds:.1f}s of "
        f"audio ({len(script)} lines). wav={wav_path} mp3={mp3_path}"
    )
    return {
        "wav": str(wav_path),
        "mp3": str(mp3_path),
        "sr": sr,
        "audio_seconds": audio_seconds,
        "total_render_seconds": total_render,
        "per_line": per_line,
    }


def _master(src: Path, wav_out: Path, mp3_out: Path) -> None:
    """Light broadcast master: highpass, gentle compression, loudness to -16 LUFS."""
    chain = (
        "highpass=f=80,"
        "acompressor=threshold=-18dB:ratio=3:attack=5:release=120,"
        "loudnorm=I=-16:TP=-1.5:LRA=11"
    )
    subprocess.run(
        [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
         "-i", str(src), "-af", chain, str(wav_out)],
        check=True,
    )
    subprocess.run(
        [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
         "-i", str(wav_out), "-b:a", "64k", str(mp3_out)],
        check=True,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Rylee produced-lane renderer.")
    parser.add_argument("script", help="Path to a JSON script file.")
    parser.add_argument("--out-name", default="segment", help="Output basename.")
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT))
    parser.add_argument("--models", default=str(DEFAULT_MODELS))
    parser.add_argument("--gap-ms", type=int, default=DEFAULT_GAP_MS)
    parser.add_argument("--device", default=None, help="mps, cpu, or cuda. Auto if unset.")
    parser.add_argument("--ref-rylee", default=None, help="Reference wav for Rylee.")
    parser.add_argument("--ref-co", default=None, help="Reference wav for the co-anchor.")
    args = parser.parse_args(argv)

    try:
        script = load_script(Path(args.script))
    except (ScriptError, json.JSONDecodeError, OSError) as exc:
        print(f"Script rejected: {exc}", file=sys.stderr)
        return 2

    # Invariant guard, enforced at run time as well as in tests.
    if concatenated_spoken(script) != concatenated_input(script):
        print("Refusing to render: spoken text would not equal input text.", file=sys.stderr)
        return 3

    cfg = RenderConfig(
        models_dir=Path(args.models),
        out_dir=Path(args.out_dir),
        out_name=args.out_name,
        gap_ms=args.gap_ms,
        device=args.device,
        ref_rylee=Path(args.ref_rylee) if args.ref_rylee else None,
        ref_co=Path(args.ref_co) if args.ref_co else None,
    )
    try:
        render(script, cfg)
    except ImportError as exc:
        print(
            f"Chatterbox stack not importable: {exc}. Run provision_produced.sh first.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
