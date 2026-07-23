"""playout.py

The playout chain skeleton and the BRB failsafe watchdog. Amendment 5 (single
audio pipeline, crossfades, now-playing readout) and the amendment 6 revision
(the failsafe overlay: BRB card locally, backoff reconnect, and resume where
the clock SHOULD be by wall time, never where it stopped).

This is a skeleton on purpose. It generates the ffmpeg command plan and the
now-playing readout, and it executes nothing unless dry_run is False. Encoder
and stream control sit behind the EncoderControl interface, stubbed until the
OBS/encoder stage.

ffmpeg is resolved explicitly because non-login shells (ssh, launchd, cron)
do not carry Homebrew's PATH.

No em dashes anywhere in this file. Standard library only. Python 3.9+.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass, field
from typing import List, Optional

from clock import PlannedItem

FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"

DEFAULT_CROSSFADE_S = 2.0


@dataclass
class PlayoutPlan:
    """The ffmpeg invocation and the human-readable now-playing lines for a
    stretch of resolved schedule."""

    command: List[str]
    now_playing: List[str]
    total_duration_s: float


def build_playout_plan(
    items: List[PlannedItem],
    output_path: str,
    crossfade_s: float = DEFAULT_CROSSFADE_S,
) -> PlayoutPlan:
    """One audio pipeline for a resolved plan: every item's file, chained with
    acrossfade. Deterministic text generation only; nothing runs here."""
    if not items:
        raise ValueError("cannot build a playout plan from an empty schedule")

    inputs: List[str] = []
    for planned in items:
        path = planned.item.path or f"missing/{planned.item.item_id}.wav"
        inputs.extend(["-i", path])

    if len(items) == 1:
        filter_arg = "[0:a]anull[out]"
    else:
        parts = []
        prev = "[0:a]"
        for i in range(1, len(items)):
            label = "[out]" if i == len(items) - 1 else f"[x{i}]"
            parts.append(
                f"{prev}[{i}:a]acrossfade=d={crossfade_s:g}:c1=tri:c2=tri{label}"
            )
            prev = label
        filter_arg = ";".join(parts)

    command = (
        [FFMPEG, "-y", "-hide_banner", "-loglevel", "error"]
        + inputs
        + ["-filter_complex", filter_arg, "-map", "[out]", output_path]
    )

    now_playing = []
    for planned in items:
        label = planned.item.track_id or planned.item.item_id
        line = f"{planned.slot_type}: {label}"
        if planned.variant_id:
            line += f" (variant {planned.variant_id})"
        now_playing.append(line)

    total = sum(p.duration_s for p in items)
    if len(items) > 1:
        total -= crossfade_s * (len(items) - 1)
    return PlayoutPlan(command=command, now_playing=now_playing,
                       total_duration_s=total)


def run_playout(plan: PlayoutPlan, dry_run: bool = True) -> Optional[int]:
    """Execute the plan's ffmpeg command. Tests keep dry_run True; nothing is
    executed and None is returned. With dry_run False, returns the exit code."""
    if dry_run:
        return None
    return subprocess.run(plan.command, check=False).returncode


# ---------------------------------------------------------------------------
# The BRB failsafe watchdog (amendment 6 revision, item 3).
# ---------------------------------------------------------------------------
class EncoderControl:
    """Interface to the encoder/stream layer. The real implementation arrives
    with the OBS/encoder stage. The watchdog only ever calls these three."""

    def show_brb_card(self) -> None:
        raise NotImplementedError

    def resume_stream(self) -> None:
        raise NotImplementedError

    def is_upline_ok(self) -> bool:
        raise NotImplementedError


STREAMING = "STREAMING"
BRB = "BRB"
RESUMING = "RESUMING"

# Reconnect backoff in seconds. Capped so the party never waits long once the
# upline is actually back.
BACKOFF_SCHEDULE_S = (5.0, 10.0, 20.0, 40.0, 60.0)


@dataclass
class BRBWatchdog:
    """State machine over the upline.

    STREAMING and the upline drops: switch to the local BRB card immediately
    and start the backoff loop. Each backoff expiry probes the upline; when it
    answers, RESUMING runs the resume rule and hands back to STREAMING.

    The resume rule: the clock resumes where it SHOULD be by wall clock. The
    caller asks resume_plan for the moment the upline returned, and the
    scheduler replans from that wall-clock time. Nothing rewinds."""

    encoder: EncoderControl
    state: str = STREAMING
    _backoff_index: int = 0
    _next_probe_epoch_s: float = field(default=0.0)

    def on_upline_lost(self, now_epoch_s: float) -> None:
        if self.state == STREAMING:
            self.state = BRB
            self._backoff_index = 0
            self._next_probe_epoch_s = now_epoch_s + BACKOFF_SCHEDULE_S[0]
            self.encoder.show_brb_card()

    def tick(self, now_epoch_s: float) -> None:
        """Call periodically. Probes the upline on the backoff schedule."""
        if self.state != BRB or now_epoch_s < self._next_probe_epoch_s:
            return
        if self.encoder.is_upline_ok():
            self.state = RESUMING
        else:
            self._backoff_index = min(self._backoff_index + 1,
                                      len(BACKOFF_SCHEDULE_S) - 1)
            self._next_probe_epoch_s = (
                now_epoch_s + BACKOFF_SCHEDULE_S[self._backoff_index]
            )

    def resume_plan(self, scheduler, now_epoch_s: float) -> List[PlannedItem]:
        """The resume rule made concrete: replan from the current wall clock.
        Returns the plan and moves the machine back to STREAMING."""
        if self.state != RESUMING:
            raise RuntimeError(f"resume_plan called in state {self.state}")
        plan = scheduler.plan(now_epoch_s)
        self.encoder.resume_stream()
        self.state = STREAMING
        self._backoff_index = 0
        return plan
