"""schema.py

Rylee Radio outcome and birth-certificate schema. Amendments 6, 7, 10, 11.

Invariants this module enforces:
  1. Aggregate, never profile. No field anywhere in these records can hold a
     username, handle, or any per-person data. Deserialization rejects unknown
     fields so nobody can smuggle one in later.
  2. Sample sizes ride with every metric (amendment 7 item 5). A metric is a
     (value, n) pair, never a bare number. Reporting must honor the
     insufficient_signal flag instead of rounding thin data up to a finding.
  3. Every track's birth certificate archives the license terms in force at
     generation time and its CC0 dedication (amendments 6 and 11).

No em dashes anywhere in this file. Standard library only. Python 3.9+.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, fields, asdict
from typing import List, Optional


class SchemaError(Exception):
    """Raised when a record fails validation."""


# The floor below which a metric is reported as insufficient, not as a finding.
DEFAULT_MIN_SAMPLE = 20


def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise SchemaError(msg)


def _check_no_unknown_fields(cls, data: dict) -> None:
    """Reject unknown keys. This is the aggregate-never-profile enforcement
    seam: a per-person field cannot be added to stored records without first
    changing the schema in code review."""
    allowed = {f.name for f in fields(cls)}
    unknown = set(data) - allowed
    _require(not unknown, f"{cls.__name__}: unknown fields {sorted(unknown)}")


def _no_dashes(text: str, where: str) -> None:
    _require(
        chr(0x2014) not in text and chr(0x2013) not in text,
        f"{where}: em or en dash is not allowed",
    )


@dataclass
class Metric:
    """A measured value and the sample size behind it. value is None when the
    metric was not observed at all."""

    value: Optional[float] = None
    n: int = 0

    def sufficient(self, min_n: int = DEFAULT_MIN_SAMPLE) -> bool:
        return self.value is not None and self.n >= min_n

    def validate(self, name: str) -> None:
        _require(isinstance(self.n, int) and self.n >= 0, f"{name}.n must be >= 0")
        _require(
            self.value is None or isinstance(self.value, (int, float)),
            f"{name}.value must be a number or None",
        )

    @classmethod
    def from_dict(cls, data: dict, name: str = "metric") -> "Metric":
        _require(isinstance(data, dict), f"{name} must be an object")
        _check_no_unknown_fields(cls, data)
        m = cls(**data)
        m.validate(name)
        return m


@dataclass
class RoarEvent:
    """One behavioral-consensus event (amendment 10). Aggregate only: what was
    roared for and whether the encore was delivered. Never who roared."""

    at: str  # ISO 8601 UTC
    track_id: str
    delivered_encore: bool = False
    message_velocity: Metric = field(default_factory=Metric)
    affirmation_density: Metric = field(default_factory=Metric)

    def validate(self) -> None:
        _require(bool(self.at), "RoarEvent.at is required")
        _require(bool(self.track_id), "RoarEvent.track_id is required")
        self.message_velocity.validate("RoarEvent.message_velocity")
        self.affirmation_density.validate("RoarEvent.affirmation_density")

    @classmethod
    def from_dict(cls, data: dict) -> "RoarEvent":
        _require(isinstance(data, dict), "RoarEvent must be an object")
        _check_no_unknown_fields(cls, data)
        data = dict(data)
        for key in ("message_velocity", "affirmation_density"):
            if key in data:
                data[key] = Metric.from_dict(data[key], f"RoarEvent.{key}")
        ev = cls(**data)
        ev.validate()
        return ev


@dataclass
class BirthCertificate:
    """Provenance of one crowd-born track (amendments 6 and 11).

    license_snapshot holds the verbatim license text of the generation model's
    output terms as they stood at generation time. cc0 records the dedication
    of the published track itself."""

    track_id: str
    name: str  # named at birth, renders on screen (amendment 9)
    born_at: str  # ISO 8601 UTC
    crowd_state: str  # aggregate mood summary that seeded the brief
    prompt: str  # the generation brief actually sent
    tool: str  # model id, e.g. ace-step-1.5-2b-turbo
    license_name: str
    license_snapshot: str
    cc0: bool = True
    diligence_note: str = ""
    variant_id: str = ""  # A/B variant tag, empty when not part of a test

    def validate(self) -> None:
        for name in ("track_id", "name", "born_at", "crowd_state", "prompt",
                     "tool", "license_name", "license_snapshot"):
            _require(bool(getattr(self, name)), f"BirthCertificate.{name} is required")
        _no_dashes(self.name, "BirthCertificate.name")
        _no_dashes(self.crowd_state, "BirthCertificate.crowd_state")
        _no_dashes(self.prompt, "BirthCertificate.prompt")

    @classmethod
    def from_dict(cls, data: dict) -> "BirthCertificate":
        _require(isinstance(data, dict), "BirthCertificate must be an object")
        _check_no_unknown_fields(cls, data)
        cert = cls(**data)
        cert.validate()
        return cert


@dataclass
class OutcomeRecord:
    """The room's aggregate reaction to one airing (amendment 7).

    Joined to the birth certificate by track_id and to the air log by
    air_log_id. Every metric carries its sample size. insufficient_signal is
    the honesty bit: when True, reporting says insufficient, full stop."""

    track_id: str
    air_log_id: str
    window_start: str  # ISO 8601 UTC
    window_end: str
    sentiment_during: Metric = field(default_factory=Metric)
    sentiment_after: Metric = field(default_factory=Metric)
    message_velocity: Metric = field(default_factory=Metric)
    viewer_delta: Metric = field(default_factory=Metric)
    replay_requests: int = 0
    roar_events: List[RoarEvent] = field(default_factory=list)
    insufficient_signal: bool = True
    min_sample: int = DEFAULT_MIN_SAMPLE

    METRIC_FIELDS = ("sentiment_during", "sentiment_after",
                     "message_velocity", "viewer_delta")

    def compute_insufficient(self) -> bool:
        """True unless every core metric clears the sample floor."""
        return not all(
            getattr(self, name).sufficient(self.min_sample)
            for name in self.METRIC_FIELDS
        )

    def keep_signal(self) -> float:
        """Delivered encores are the strongest keep signal a track can earn
        (amendment 10 item 2). Returns a count, not a judgment."""
        return float(sum(1 for ev in self.roar_events if ev.delivered_encore))

    def validate(self) -> None:
        for name in ("track_id", "air_log_id", "window_start", "window_end"):
            _require(bool(getattr(self, name)), f"OutcomeRecord.{name} is required")
        for name in self.METRIC_FIELDS:
            getattr(self, name).validate(f"OutcomeRecord.{name}")
        _require(
            isinstance(self.replay_requests, int) and self.replay_requests >= 0,
            "OutcomeRecord.replay_requests must be >= 0",
        )
        for ev in self.roar_events:
            ev.validate()
        _require(
            self.insufficient_signal == self.compute_insufficient(),
            "OutcomeRecord.insufficient_signal does not match its metrics",
        )

    @classmethod
    def from_dict(cls, data: dict) -> "OutcomeRecord":
        _require(isinstance(data, dict), "OutcomeRecord must be an object")
        _check_no_unknown_fields(cls, data)
        data = dict(data)
        for key in cls.METRIC_FIELDS:
            if key in data:
                data[key] = Metric.from_dict(data[key], f"OutcomeRecord.{key}")
        if "roar_events" in data:
            data["roar_events"] = [RoarEvent.from_dict(e) for e in data["roar_events"]]
        rec = cls(**data)
        rec.validate()
        return rec


@dataclass
class AirLogEntry:
    """What actually aired, against what the clock scheduled."""

    air_log_id: str
    slot_index: int
    slot_type: str
    item_id: str
    track_id: str = ""  # empty for non-music items
    variant_id: str = ""
    scheduled_start: str = ""  # ISO 8601 UTC
    actual_start: str = ""
    scheduled_duration_s: float = 0.0
    actual_duration_s: float = 0.0

    def validate(self) -> None:
        _require(bool(self.air_log_id), "AirLogEntry.air_log_id is required")
        _require(bool(self.item_id), "AirLogEntry.item_id is required")
        _require(self.slot_index >= 0, "AirLogEntry.slot_index must be >= 0")
        _require(bool(self.slot_type), "AirLogEntry.slot_type is required")

    @classmethod
    def from_dict(cls, data: dict) -> "AirLogEntry":
        _require(isinstance(data, dict), "AirLogEntry must be an object")
        _check_no_unknown_fields(cls, data)
        entry = cls(**data)
        entry.validate()
        return entry


# ---------------------------------------------------------------------------
# JSON round-trip helpers. asdict handles nesting; from_dict validates it back.
# ---------------------------------------------------------------------------
def to_json(record) -> str:
    return json.dumps(asdict(record), ensure_ascii=False, sort_keys=True)


def from_json(cls, text: str):
    return cls.from_dict(json.loads(text))
