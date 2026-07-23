"""mood.py

The mood engine. Amendments 6 and 7: sentiment windows seed generation briefs;
the room steers energy, tempo, and color inside founder-picked lanes.

This module is deterministic. No model, no randomness, no clock reads. It
turns aggregate chat metrics for a time window into a MoodState, and a
MoodState into the input payload for the bee's mood_brief job, where a local
model writes the creative prompt under mechanical validation.

Honesty rules carried from amendment 7:
  1. Aggregate, never profile. Inputs are room-level Metrics only.
  2. Sample sizes decide. Below the floor, the engine does not guess the
     room's mood; it returns the station's own default identity mood and says
     so via insufficient=True. The DJ line for that state is the station
     steering itself, never a claim about the room.

No em dashes anywhere in this file. Standard library only. Python 3.9+.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from schema import Metric, DEFAULT_MIN_SAMPLE

# Founder-picked lanes (amendment 9). The founder's ear can reorder or trim
# this; the engine only ever emits lanes from the list it is given.
DEFAULT_LANES = ["textural", "cinematic", "electronic", "minimal", "maximal"]

TEMPO_FLOOR_BPM = 70
TEMPO_CEIL_BPM = 140
TEMPO_BAND_BPM = 10  # half-width of the brief's tempo range


@dataclass
class MoodConfig:
    lanes: List[str] = field(default_factory=lambda: list(DEFAULT_LANES))
    min_sample: int = DEFAULT_MIN_SAMPLE
    # Messages per minute that count as a fully energetic room. Rooms are
    # small at first; this scales with the room later, per amendment 10.
    velocity_full: float = 30.0


@dataclass
class MoodState:
    lane: str
    energy: float  # 0..1
    valence: float  # 0..1
    tempo_lo: int
    tempo_hi: int
    descriptors: List[str]
    sample_n: int
    insufficient: bool
    window_start: str = ""
    window_end: str = ""


# The station's identity mood: what plays when the room is quiet or too thin
# to read. Chosen once, on purpose, not guessed per window.
def default_mood(config: MoodConfig, window_start: str = "", window_end: str = "",
                 sample_n: int = 0) -> MoodState:
    lane = config.lanes[0] if config.lanes else "textural"
    return MoodState(
        lane=lane, energy=0.4, valence=0.55, tempo_lo=82, tempo_hi=98,
        descriptors=["warm", "patient", "open"],
        sample_n=sample_n, insufficient=True,
        window_start=window_start, window_end=window_end,
    )


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return lo if x < lo else hi if x > hi else x


def _band(x: float) -> int:
    """0 low, 1 mid, 2 high."""
    if x < 1.0 / 3.0:
        return 0
    if x < 2.0 / 3.0:
        return 1
    return 2


# Descriptor matrix, valence band by energy band. Fixed vocabulary so the
# library's memory (amendment 9 requests by remembered mood) matches against
# a stable word set.
DESCRIPTORS = [
    # valence low
    [["somber", "sparse", "slow"], ["heavy", "brooding", "steady"], ["stormy", "dense", "driving"]],
    # valence mid
    [["hazy", "drifting", "soft"], ["warm", "patient", "open"], ["restless", "layered", "moving"]],
    # valence high
    [["gentle", "glowing", "calm"], ["bright", "easy", "lifting"], ["joyful", "surging", "wide"]],
]


def _lane_for(energy: float, valence: float, lanes: List[str]) -> str:
    """Deterministic lane choice inside the founder's list. Preference order
    is computed from the mood; the first preferred lane present in the list
    wins; the list's first lane is the unconditional fallback."""
    if valence < 1.0 / 3.0:
        prefer = ["cinematic", "textural", "minimal"]
    elif energy < 1.0 / 3.0:
        prefer = ["minimal", "textural", "cinematic"]
    elif energy > 3.0 / 4.0:
        prefer = ["maximal", "electronic", "textural"]
    elif energy > 1.0 / 2.0:
        prefer = ["electronic", "textural", "maximal"]
    else:
        prefer = ["textural", "electronic", "minimal"]
    for lane in prefer:
        if lane in lanes:
            return lane
    return lanes[0] if lanes else "textural"


def compute_mood(
    sentiment: Metric,
    message_velocity: Metric,
    config: Optional[MoodConfig] = None,
    window_start: str = "",
    window_end: str = "",
) -> MoodState:
    """Aggregate window metrics to a MoodState.

    sentiment.value is the room's aggregate sentiment in 0..1 (0 dark, 1
    bright). message_velocity.value is messages per minute. Sample floor
    applies to the sentiment sample; a quiet room falls back to the station's
    identity mood."""
    config = config or MoodConfig()
    n = sentiment.n
    if not sentiment.sufficient(config.min_sample):
        return default_mood(config, window_start, window_end, sample_n=n)

    valence = _clamp(float(sentiment.value))
    vel = float(message_velocity.value or 0.0)
    energy = _clamp(vel / config.velocity_full if config.velocity_full > 0 else 0.0)

    center = TEMPO_FLOOR_BPM + energy * (TEMPO_CEIL_BPM - TEMPO_FLOOR_BPM)
    tempo_lo = int(round(center - TEMPO_BAND_BPM))
    tempo_hi = int(round(center + TEMPO_BAND_BPM))

    descriptors = list(DESCRIPTORS[_band(valence)][_band(energy)])
    lane = _lane_for(energy, valence, config.lanes)

    return MoodState(
        lane=lane, energy=round(energy, 3), valence=round(valence, 3),
        tempo_lo=tempo_lo, tempo_hi=tempo_hi, descriptors=descriptors,
        sample_n=n, insufficient=False,
        window_start=window_start, window_end=window_end,
    )


def brief_payload(mood: MoodState, config: Optional[MoodConfig] = None,
                  model: str = "") -> dict:
    """The bee mood_brief job input. The bee's validators enforce that the
    creative output stays inside these numbers and words."""
    config = config or MoodConfig()
    payload = {
        "lane": mood.lane,
        "lanes": list(config.lanes),
        "energy": mood.energy,
        "valence": mood.valence,
        "tempo_lo": mood.tempo_lo,
        "tempo_hi": mood.tempo_hi,
        "descriptors": list(mood.descriptors),
        "window_start": mood.window_start,
        "window_end": mood.window_end,
        "sample_n": mood.sample_n,
        "insufficient": mood.insufficient,
    }
    if model:
        payload["model"] = model
    return payload


def crowd_state_line(mood: MoodState) -> str:
    """The birth certificate's crowd_state summary (amendment 6 item 2), and
    what the DJ can honestly say on air. Insufficient signal is stated as the
    station's own choice, never dressed up as the room's."""
    if mood.insufficient:
        return "quiet room, station identity mood: " + ", ".join(mood.descriptors)
    return "room mood {0}: {1} (sample {2})".format(
        mood.lane, ", ".join(mood.descriptors), mood.sample_n
    )
