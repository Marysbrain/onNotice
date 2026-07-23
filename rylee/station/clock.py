"""clock.py

The Rylee Radio format clock scheduler. Amendments 5, 7, 9, 10.

The one-line mandate: the clock decides when, the room decides which, and
dead air is structurally impossible.

Invariants:
  1. Determinism is the product. Same inputs give the same schedule, byte for
     byte. Nothing here reads the real clock, random state, or the network;
     wall-clock time is always an explicit argument.
  2. Every slot resolution returns playable inventory or the standing
     fallback, never nothing. dj_insert slots additionally carry a
     pre-selected evergreen fallback so a missed realtime deadline swaps to
     it without a decision at air time.
  3. Variant assignment for the A/B laboratory is a pure function of
     (variant list, slot index, date), interleaved within the hour and
     rotated across days so comparisons survive time-of-day effects.

No em dashes anywhere in this file. Standard library only. Python 3.9+.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

SLOT_TYPES = (
    "music",
    "station_id",
    "dj_insert",
    "news_desk",
    "spot",
    "variety",
    "request",
)

SECONDS_PER_HOUR = 3600
MIN_PLAN_HORIZON_S = 15 * 60  # the clock always holds the next fifteen minutes


class ClockError(Exception):
    """Raised on invalid templates or inventory."""


@dataclass(frozen=True)
class Slot:
    """One entry in the repeating hour. offset_s is seconds from the top of
    the hour; duration_s is the slot's budget."""

    slot_type: str
    offset_s: int
    duration_s: int


# The v1 format clock. A fixed repeating hour, defined as data so a format
# change is an edit, not a rewrite. Offsets are contiguous and sum to 3600.
HOUR_TEMPLATE: List[Slot] = [
    Slot("station_id", 0, 30),
    Slot("music", 30, 570),
    Slot("dj_insert", 600, 60),
    Slot("music", 660, 540),
    Slot("spot", 1200, 120),
    Slot("music", 1320, 480),
    Slot("news_desk", 1800, 300),
    Slot("music", 2100, 420),
    Slot("dj_insert", 2520, 60),
    Slot("request", 2580, 300),
    Slot("music", 2880, 420),
    Slot("spot", 3300, 120),
    Slot("variety", 3420, 150),
    Slot("station_id", 3570, 30),
]


def validate_template(template: List[Slot]) -> None:
    """A template must tile the hour exactly: contiguous, no gaps, no overlap."""
    if not template:
        raise ClockError("template is empty")
    expected = 0
    for i, slot in enumerate(template):
        if slot.slot_type not in SLOT_TYPES:
            raise ClockError(f"slot {i}: unknown type {slot.slot_type!r}")
        if slot.offset_s != expected:
            raise ClockError(
                f"slot {i}: offset {slot.offset_s} leaves a gap or overlap "
                f"(expected {expected})"
            )
        if slot.duration_s <= 0:
            raise ClockError(f"slot {i}: duration must be positive")
        expected += slot.duration_s
    if expected != SECONDS_PER_HOUR:
        raise ClockError(f"template covers {expected}s, must cover 3600s")


@dataclass(frozen=True)
class InventoryItem:
    """One playable thing. Tests use fabricated paths; nothing reads audio."""

    item_id: str
    kind: str  # a value from SLOT_TYPES
    duration_s: float
    path: str = ""
    track_id: str = ""  # music only
    is_fresh: bool = False  # crowd-born recently vs archive
    is_evergreen: bool = False  # safe to air any time as fill

    def validate(self) -> None:
        if self.kind not in SLOT_TYPES:
            raise ClockError(f"{self.item_id}: unknown kind {self.kind!r}")
        if self.duration_s <= 0:
            raise ClockError(f"{self.item_id}: duration must be positive")


# The standing fallback: the item playout swaps in when a slot has no usable
# inventory at all. It must always exist in any deployed inventory set. Tests
# assert the scheduler emits it rather than emitting nothing.
STANDING_FALLBACK = InventoryItem(
    item_id="standing-fallback",
    kind="station_id",
    duration_s=30.0,
    path="fallback/station-id.wav",
    is_evergreen=True,
)


@dataclass
class PlannedItem:
    """One resolved entry in the playout plan."""

    slot_index: int
    slot_type: str
    start_epoch_s: float
    duration_s: float
    item: InventoryItem
    fallback: Optional[InventoryItem] = None  # pre-armed for dj_insert
    variant_id: str = ""


def slot_at(template: List[Slot], epoch_s: float):
    """Return (slot_index, slot, seconds_into_slot) for a wall-clock time.
    Pure: no reading of the real clock."""
    into_hour = int(epoch_s) % SECONDS_PER_HOUR
    for i, slot in enumerate(template):
        if slot.offset_s <= into_hour < slot.offset_s + slot.duration_s:
            return i, slot, into_hour - slot.offset_s
    raise ClockError("template does not cover the hour")  # unreachable if validated


def day_ordinal(epoch_s: float) -> int:
    """UTC day number, for cross-day variant rotation."""
    return int(epoch_s) // 86400


def variant_for_slot(variants: List[str], slot_index: int, epoch_s: float) -> str:
    """Deterministic interleaved A/B assignment (amendment 7 item 2).

    Adjacent slots on one day get different variants (interleaving within the
    hour), and a given slot's variant rotates across days, so no variant owns
    a time of day. Pure function: reproducible from the air log alone."""
    if not variants:
        return ""
    ordered = sorted(variants)
    return ordered[(slot_index + day_ordinal(epoch_s)) % len(ordered)]


@dataclass
class RequestQueue:
    """Interface for the roar detector (amendment 10). The detector, built in
    the chat-ingest stage, calls enqueue_encore when behavioral consensus
    crosses threshold. The clock only ever pops; it never detects."""

    _queue: List[str] = field(default_factory=list)  # track_ids, FIFO

    def enqueue_encore(self, track_id: str) -> None:
        if track_id and track_id not in self._queue:
            self._queue.append(track_id)

    def pop(self) -> Optional[str]:
        return self._queue.pop(0) if self._queue else None

    def peek_all(self) -> List[str]:
        return list(self._queue)


@dataclass
class RotationConfig:
    no_repeat_window_s: float = 2 * 3600.0  # a track rests this long between airings
    fresh_share: float = 0.5  # target share of fresh crowd-born tracks in music slots


class Scheduler:
    """Walks the format clock and resolves every slot to playable inventory.

    State that affects choices (play history, request queue) is explicit and
    injectable so tests can reproduce any decision."""

    def __init__(
        self,
        template: Optional[List[Slot]] = None,
        rotation: Optional[RotationConfig] = None,
        variants: Optional[List[str]] = None,
    ):
        self.template = template if template is not None else HOUR_TEMPLATE
        validate_template(self.template)
        self.rotation = rotation or RotationConfig()
        self.variants = variants or []
        self.inventory: Dict[str, InventoryItem] = {}
        self.last_played: Dict[str, float] = {}  # track_id -> epoch seconds
        self.requests = RequestQueue()
        self._music_counter = 0  # drives the fresh/archive alternation

    # -- inventory -----------------------------------------------------------
    def add_item(self, item: InventoryItem) -> None:
        item.validate()
        self.inventory[item.item_id] = item

    def _items_of_kind(self, kind: str) -> List[InventoryItem]:
        return sorted(
            (it for it in self.inventory.values() if it.kind == kind),
            key=lambda it: it.item_id,
        )

    def _evergreen_of_kind(self, kind: str) -> InventoryItem:
        for it in self._items_of_kind(kind):
            if it.is_evergreen:
                return it
        return STANDING_FALLBACK

    # -- music rotation ------------------------------------------------------
    def _eligible_music(self, now_epoch_s: float) -> List[InventoryItem]:
        out = []
        for it in self._items_of_kind("music"):
            last = self.last_played.get(it.track_id)
            if last is None or now_epoch_s - last >= self.rotation.no_repeat_window_s:
                out.append(it)
        return out

    def _pick_music(self, now_epoch_s: float) -> InventoryItem:
        """Least-recently-played within the eligible pool, alternating between
        the fresh and archive pools at the configured share. Deterministic:
        ties break on track_id."""
        eligible = self._eligible_music(now_epoch_s)
        if not eligible:
            return self._evergreen_of_kind("music")
        period = max(1, round(1.0 / self.rotation.fresh_share)) if self.rotation.fresh_share > 0 else 0
        want_fresh = bool(period) and (self._music_counter % period == 0)
        self._music_counter += 1
        pool = [it for it in eligible if it.is_fresh == want_fresh] or eligible
        pool.sort(key=lambda it: (self.last_played.get(it.track_id, float("-inf")), it.track_id))
        return pool[0]

    # -- slot resolution -----------------------------------------------------
    def resolve_slot(self, slot_index: int, slot: Slot, start_epoch_s: float) -> PlannedItem:
        """Resolve one slot. Never returns nothing: every path ends in an
        item, and dj_insert also pre-arms an evergreen fallback."""
        variant = variant_for_slot(self.variants, slot_index, start_epoch_s)

        if slot.slot_type == "music":
            item = self._pick_music(start_epoch_s)
            if item.track_id:
                self.last_played[item.track_id] = start_epoch_s
            return PlannedItem(slot_index, slot.slot_type, start_epoch_s,
                               slot.duration_s, item, variant_id=variant)

        if slot.slot_type == "dj_insert":
            # The fast loop: realtime content fills this at air time. The plan
            # carries the deadline as the slot itself and the fallback NOW, so
            # a miss swaps without a decision (amendment 5 item 2).
            fallback = self._evergreen_of_kind("dj_insert")
            return PlannedItem(slot_index, slot.slot_type, start_epoch_s,
                               slot.duration_s, fallback, fallback=fallback,
                               variant_id=variant)

        if slot.slot_type == "request":
            track_id = self.requests.pop()
            if track_id:
                for it in self._items_of_kind("music"):
                    if it.track_id == track_id:
                        self.last_played[track_id] = start_epoch_s
                        return PlannedItem(slot_index, slot.slot_type,
                                           start_epoch_s, slot.duration_s, it,
                                           variant_id=variant)
            # No pending request or unknown track: the slot plays rotation.
            item = self._pick_music(start_epoch_s)
            if item.track_id:
                self.last_played[item.track_id] = start_epoch_s
            return PlannedItem(slot_index, slot.slot_type, start_epoch_s,
                               slot.duration_s, item, variant_id=variant)

        # station_id, news_desk, spot, variety: precomputed inventory with an
        # evergreen fallback of the same kind, then the standing fallback.
        items = self._items_of_kind(slot.slot_type)
        item = items[0] if items else self._evergreen_of_kind(slot.slot_type)
        return PlannedItem(slot_index, slot.slot_type, start_epoch_s,
                           slot.duration_s, item, variant_id=variant)

    def plan(self, now_epoch_s: float, horizon_s: float = MIN_PLAN_HORIZON_S) -> List[PlannedItem]:
        """The concrete plan from now until at least horizon_s ahead. Always
        non-empty; every entry has a playable item.

        The first entry starts at the top of the CURRENT slot, which can be in
        the past. Playout joins mid-item by seeking now minus start. This is
        also what makes the BRB resume rule work: replanning at any wall-clock
        moment lands inside the slot the clock says should be airing."""
        horizon_s = max(horizon_s, MIN_PLAN_HORIZON_S)
        planned: List[PlannedItem] = []
        idx, slot, into = slot_at(self.template, now_epoch_s)
        cursor = now_epoch_s - into  # top of the current slot
        end = now_epoch_s + horizon_s
        while cursor < end:
            idx_now, slot_now, _ = slot_at(self.template, cursor)
            planned.append(self.resolve_slot(idx_now, slot_now, cursor))
            cursor += slot_now.duration_s
        return planned
