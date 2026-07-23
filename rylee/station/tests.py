"""tests.py

Offline tests for the station core: clock, schema, playout. Plain python3,
no pytest, no network, no audio files, no model. Style matches
rylee/produced/tests.py: [PASS]/[FAIL] lines and a non-zero exit on failure.

No em dashes anywhere in this file. Dash characters under test are built with
chr, never written literally.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import clock as clock_mod
import mood as mood_mod
import playout as playout_mod
import schema as schema_mod
from clock import (
    HOUR_TEMPLATE,
    STANDING_FALLBACK,
    InventoryItem,
    RotationConfig,
    Scheduler,
    Slot,
    slot_at,
    validate_template,
    variant_for_slot,
    ClockError,
)
from playout import (
    BACKOFF_SCHEDULE_S,
    BRB,
    BRBWatchdog,
    EncoderControl,
    RESUMING,
    STREAMING,
    build_playout_plan,
    run_playout,
)
from schema import (
    AirLogEntry,
    BirthCertificate,
    Metric,
    OutcomeRecord,
    RoarEvent,
    SchemaError,
    from_json,
    to_json,
)

FAILURES = []


def check(name, fn):
    try:
        fn()
        print(f"[PASS] {name}")
    except AssertionError as exc:
        FAILURES.append(name)
        print(f"[FAIL] {name}: {exc}")
    except Exception as exc:  # noqa: BLE001
        FAILURES.append(name)
        print(f"[FAIL] {name}: unexpected {type(exc).__name__}: {exc}")


def expect_raises(exc_type, fn, why):
    try:
        fn()
    except exc_type:
        return
    raise AssertionError(f"expected {exc_type.__name__}: {why}")


# ---------------------------------------------------------------------------
# Fixtures. Fabricated inventory; nothing reads audio.
# ---------------------------------------------------------------------------
def make_scheduler(variants=None, with_music=True, with_extras=True):
    sched = Scheduler(variants=variants or [])
    if with_music:
        for i in range(6):
            sched.add_item(InventoryItem(
                item_id=f"music-{i}", kind="music", duration_s=180.0,
                path=f"fake/music-{i}.wav", track_id=f"track-{i}",
                is_fresh=(i % 2 == 0),
            ))
        sched.add_item(InventoryItem(
            item_id="music-evergreen", kind="music", duration_s=180.0,
            path="fake/evergreen.wav", track_id="track-evergreen",
            is_evergreen=True,
        ))
    if with_extras:
        for kind in ("station_id", "dj_insert", "news_desk", "spot", "variety"):
            sched.add_item(InventoryItem(
                item_id=f"{kind}-evergreen", kind=kind, duration_s=30.0,
                path=f"fake/{kind}.wav", is_evergreen=True,
            ))
    return sched


CERT_FIELDS = dict(
    track_id="track-1",
    name="Rain On A Tin Roof",
    born_at="2026-07-23T20:00:00Z",
    crowd_state="calm, late, nostalgic",
    prompt="minimal texture, slow rain, warm room",
    tool="ace-step-1.5-2b-turbo",
    license_name="MIT",
    license_snapshot="Permission is hereby granted, free of charge ...",
)


def full_metric():
    return {"value": 0.5, "n": 25}


def outcome_dict(insufficient=False):
    return dict(
        track_id="track-1",
        air_log_id="air-1",
        window_start="2026-07-23T20:00:00Z",
        window_end="2026-07-23T20:10:00Z",
        sentiment_during=full_metric(),
        sentiment_after=full_metric(),
        message_velocity=full_metric(),
        viewer_delta=dict(full_metric(), n=(25 if not insufficient else 3)),
        replay_requests=2,
        roar_events=[],
        insufficient_signal=insufficient,
    )


# ---------------------------------------------------------------------------
# Clock template and slot walk.
# ---------------------------------------------------------------------------
def test_template_valid():
    validate_template(HOUR_TEMPLATE)
    assert sum(s.duration_s for s in HOUR_TEMPLATE) == 3600


def test_template_gap_rejected():
    bad = [Slot("music", 0, 100), Slot("music", 150, 3450)]
    expect_raises(ClockError, lambda: validate_template(bad), "gap in template")


def test_slot_at_boundaries():
    i0, s0, into0 = slot_at(HOUR_TEMPLATE, 0)
    assert i0 == 0 and into0 == 0
    ilast, slast, _ = slot_at(HOUR_TEMPLATE, 3599)
    assert ilast == len(HOUR_TEMPLATE) - 1
    iwrap, _, intowrap = slot_at(HOUR_TEMPLATE, 3600)
    assert iwrap == 0 and intowrap == 0
    hour_top = 1_000_000 * 3600
    imid, _, _ = slot_at(HOUR_TEMPLATE, hour_top + 601)
    assert HOUR_TEMPLATE[imid].slot_type == "dj_insert"


# ---------------------------------------------------------------------------
# Dead air is structurally impossible.
# ---------------------------------------------------------------------------
def test_plan_covers_horizon():
    sched = make_scheduler()
    now = 1_753_000_000
    plan = sched.plan(now)
    assert plan, "plan is empty"
    end = plan[-1].start_epoch_s + plan[-1].duration_s
    assert end - now >= 15 * 60, "plan holds less than fifteen minutes"
    assert all(p.item is not None for p in plan)


def test_empty_inventory_still_plays():
    sched = Scheduler()
    plan = sched.plan(0)
    assert plan, "empty inventory produced an empty plan"
    assert all(p.item is not None for p in plan)
    assert any(p.item.item_id == STANDING_FALLBACK.item_id for p in plan)


def test_dj_insert_prearms_fallback():
    sched = make_scheduler()
    plan = sched.plan(0, horizon_s=3600)
    inserts = [p for p in plan if p.slot_type == "dj_insert"]
    assert inserts, "no dj_insert slots in a full hour"
    for p in inserts:
        assert p.fallback is not None, "dj_insert without a pre-armed fallback"
        assert p.fallback.is_evergreen or p.fallback.item_id == STANDING_FALLBACK.item_id


# ---------------------------------------------------------------------------
# Rotation.
# ---------------------------------------------------------------------------
def test_no_repeat_window():
    sched = make_scheduler()
    now = 2_000_000_000
    first = sched._pick_music(now)
    sched.last_played[first.track_id] = now
    second = sched._pick_music(now + 60)
    assert second.track_id != first.track_id, "track repeated inside the window"


def test_repeat_allowed_after_window():
    sched = Scheduler(rotation=RotationConfig(no_repeat_window_s=600))
    sched.add_item(InventoryItem(
        item_id="only", kind="music", duration_s=180.0,
        path="fake/only.wav", track_id="track-only",
    ))
    now = 2_000_000_000
    sched.last_played["track-only"] = now
    later = sched._pick_music(now + 601)
    assert later.track_id == "track-only"


def test_fresh_share_alternates():
    sched = make_scheduler()
    kinds = []
    now = 2_000_000_000
    for i in range(4):
        item = sched._pick_music(now + i * 10_000)
        sched.last_played[item.track_id] = now + i * 10_000
        kinds.append(item.is_fresh)
    assert True in kinds and False in kinds, f"no alternation: {kinds}"


# ---------------------------------------------------------------------------
# The A/B laboratory.
# ---------------------------------------------------------------------------
def test_variant_pure_and_interleaved():
    variants = ["a", "b"]
    t = 1_753_000_000
    v1 = variant_for_slot(variants, 3, t)
    v2 = variant_for_slot(variants, 3, t)
    assert v1 == v2, "variant assignment is not pure"
    assert variant_for_slot(variants, 3, t) != variant_for_slot(variants, 4, t), \
        "adjacent slots share a variant"
    assert variant_for_slot(variants, 3, t) != variant_for_slot(variants, 3, t + 86400), \
        "same slot keeps its variant across days"
    assert variant_for_slot([], 3, t) == ""


# ---------------------------------------------------------------------------
# Requests and the roar interface.
# ---------------------------------------------------------------------------
def test_encore_delivered():
    sched = make_scheduler()
    sched.requests.enqueue_encore("track-3")
    sched.requests.enqueue_encore("track-3")  # duplicates ignored
    assert sched.requests.peek_all() == ["track-3"]
    slot = next(s for s in HOUR_TEMPLATE if s.slot_type == "request")
    idx = HOUR_TEMPLATE.index(slot)
    planned = sched.resolve_slot(idx, slot, 2_000_000_000)
    assert planned.item.track_id == "track-3", "roared encore not delivered"


def test_request_slot_falls_back_to_rotation():
    sched = make_scheduler()
    slot = next(s for s in HOUR_TEMPLATE if s.slot_type == "request")
    idx = HOUR_TEMPLATE.index(slot)
    planned = sched.resolve_slot(idx, slot, 2_000_000_000)
    assert planned.item.kind == "music", "empty request queue must play rotation"


# ---------------------------------------------------------------------------
# Schema: birth certificates, outcomes, air log.
# ---------------------------------------------------------------------------
def test_birth_certificate_roundtrip():
    cert = BirthCertificate(**CERT_FIELDS)
    cert.validate()
    back = from_json(BirthCertificate, to_json(cert))
    assert back == cert


def test_unknown_field_rejected():
    data = dict(CERT_FIELDS, username="someone")
    expect_raises(SchemaError, lambda: BirthCertificate.from_dict(data),
                  "per-person field smuggled into a birth certificate")
    out = outcome_dict()
    out["viewer_handle"] = "someone"
    expect_raises(SchemaError, lambda: OutcomeRecord.from_dict(out),
                  "per-person field smuggled into an outcome record")


def test_dash_rejected_in_cert():
    em = chr(0x2014)
    data = dict(CERT_FIELDS, name=f"Rain {em} Tin")
    expect_raises(SchemaError, lambda: BirthCertificate.from_dict(data),
                  "em dash in a track name")


def test_outcome_roundtrip_and_signal():
    rec = OutcomeRecord.from_dict(outcome_dict(insufficient=False))
    assert rec.compute_insufficient() is False
    back = from_json(OutcomeRecord, to_json(rec))
    assert back == rec


def test_insufficient_signal_is_honest():
    lying = outcome_dict(insufficient=False)
    lying["viewer_delta"] = {"value": 0.5, "n": 3}
    expect_raises(SchemaError, lambda: OutcomeRecord.from_dict(lying),
                  "thin sample claimed as sufficient")
    honest = OutcomeRecord.from_dict(outcome_dict(insufficient=True))
    assert honest.insufficient_signal is True


def test_keep_signal_counts_encores():
    out = outcome_dict()
    out["roar_events"] = [
        dict(at="2026-07-23T20:05:00Z", track_id="track-1",
             delivered_encore=True),
        dict(at="2026-07-23T20:06:00Z", track_id="track-1",
             delivered_encore=False),
    ]
    rec = OutcomeRecord.from_dict(out)
    assert rec.keep_signal() == 1.0


def test_metric_sufficiency():
    assert Metric(value=0.1, n=20).sufficient()
    assert not Metric(value=0.1, n=19).sufficient()
    assert not Metric(value=None, n=100).sufficient()


def test_air_log_roundtrip():
    entry = AirLogEntry(
        air_log_id="air-1", slot_index=1, slot_type="music",
        item_id="music-0", track_id="track-0", variant_id="a",
        scheduled_start="2026-07-23T20:00:30Z",
        actual_start="2026-07-23T20:00:31Z",
        scheduled_duration_s=570.0, actual_duration_s=568.5,
    )
    back = from_json(AirLogEntry, to_json(entry))
    assert back == entry


# ---------------------------------------------------------------------------
# Playout plan generation.
# ---------------------------------------------------------------------------
def test_playout_single_item():
    sched = make_scheduler()
    plan_items = sched.plan(0)[:1]
    plan = build_playout_plan(plan_items, "out.wav")
    assert plan.command[0] == playout_mod.FFMPEG
    assert "anull" in " ".join(plan.command)
    assert run_playout(plan, dry_run=True) is None


def test_playout_crossfades():
    sched = make_scheduler()
    items = sched.plan(0, horizon_s=3600)
    plan = build_playout_plan(items, "out.wav", crossfade_s=2.0)
    joined = " ".join(plan.command)
    assert joined.count("acrossfade") == len(items) - 1
    expected = sum(p.duration_s for p in items) - 2.0 * (len(items) - 1)
    assert abs(plan.total_duration_s - expected) < 1e-6
    assert len(plan.now_playing) == len(items)


def test_playout_empty_rejected():
    expect_raises(ValueError, lambda: build_playout_plan([], "out.wav"),
                  "empty schedule must not build")


# ---------------------------------------------------------------------------
# The BRB failsafe watchdog.
# ---------------------------------------------------------------------------
class FakeEncoder(EncoderControl):
    def __init__(self):
        self.brb_shown = 0
        self.resumed = 0
        self.upline = False

    def show_brb_card(self):
        self.brb_shown += 1

    def resume_stream(self):
        self.resumed += 1

    def is_upline_ok(self):
        return self.upline


def test_brb_state_machine():
    enc = FakeEncoder()
    dog = BRBWatchdog(encoder=enc)
    t = 1_753_000_000.0
    dog.on_upline_lost(t)
    assert dog.state == BRB and enc.brb_shown == 1
    dog.on_upline_lost(t + 1)  # idempotent while already BRB
    assert enc.brb_shown == 1
    dog.tick(t + 1)  # before the first probe time: nothing
    assert dog.state == BRB
    dog.tick(t + BACKOFF_SCHEDULE_S[0] + 0.1)  # probe fails, backoff grows
    assert dog.state == BRB
    enc.upline = True
    dog.tick(t + BACKOFF_SCHEDULE_S[0] + BACKOFF_SCHEDULE_S[1] + 0.2)
    assert dog.state == RESUMING


def test_brb_resume_is_wall_clock():
    enc = FakeEncoder()
    enc.upline = True
    dog = BRBWatchdog(encoder=enc)
    sched = make_scheduler()
    t_loss = 1_753_000_000.0
    dog.on_upline_lost(t_loss)
    dog.tick(t_loss + BACKOFF_SCHEDULE_S[0] + 0.1)
    assert dog.state == RESUMING
    t_back = t_loss + 1800.0  # half an hour of outage
    plan = dog.resume_plan(sched, t_back)
    assert dog.state == STREAMING and enc.resumed == 1
    idx_expected, _, into = slot_at(sched.template, t_back)
    assert plan[0].slot_index == idx_expected, \
        "resume did not land where the clock should be by wall time"
    assert plan[0].start_epoch_s == t_back - into


def test_brb_resume_needs_resuming_state():
    dog = BRBWatchdog(encoder=FakeEncoder())
    expect_raises(RuntimeError, lambda: dog.resume_plan(make_scheduler(), 0.0),
                  "resume from STREAMING must raise")


# ---------------------------------------------------------------------------
# The mood engine.
# ---------------------------------------------------------------------------
def test_mood_insufficient_falls_back():
    m = mood_mod.compute_mood(Metric(value=0.9, n=3), Metric(value=50.0, n=3))
    assert m.insufficient is True, "thin sample must not be read as the room"
    assert m.lane == mood_mod.DEFAULT_LANES[0]
    assert "station identity" in mood_mod.crowd_state_line(m)


def test_mood_deterministic_and_bounded():
    a = mood_mod.compute_mood(Metric(value=0.8, n=40), Metric(value=25.0, n=40))
    b = mood_mod.compute_mood(Metric(value=0.8, n=40), Metric(value=25.0, n=40))
    assert a == b, "mood engine is not deterministic"
    assert 0.0 <= a.energy <= 1.0 and 0.0 <= a.valence <= 1.0
    assert a.tempo_lo < a.tempo_hi
    assert a.lane in mood_mod.DEFAULT_LANES
    assert a.insufficient is False


def test_mood_energy_tracks_velocity():
    slow = mood_mod.compute_mood(Metric(value=0.5, n=40), Metric(value=2.0, n=40))
    fast = mood_mod.compute_mood(Metric(value=0.5, n=40), Metric(value=30.0, n=40))
    assert fast.energy > slow.energy
    assert fast.tempo_hi > slow.tempo_hi


def test_mood_lane_stays_in_founder_list():
    cfg = mood_mod.MoodConfig(lanes=["minimal"])
    m = mood_mod.compute_mood(Metric(value=0.9, n=40), Metric(value=30.0, n=40),
                              config=cfg)
    assert m.lane == "minimal", "lane escaped the founder's list"


def test_mood_brief_payload_passes_bee_input_validator():
    candidates = [HERE.parent.parent / "bee", Path.home() / "bee"]
    bee_dir = next((p for p in candidates if (p / "bee.py").exists()), None)
    assert bee_dir is not None, f"bee not found in {[str(c) for c in candidates]}"
    sys.path.insert(0, str(bee_dir))
    try:
        import bee  # noqa: PLC0415
        m = mood_mod.compute_mood(Metric(value=0.7, n=40), Metric(value=12.0, n=40),
                                  window_start="2026-07-23T20:00:00Z",
                                  window_end="2026-07-23T20:10:00Z")
        payload = mood_mod.brief_payload(m, model="gpt-oss:120b-cloud")
        errs = bee.validate_input_mood_brief(payload)
        assert errs == [], f"bee rejected the engine's own payload: {errs}"
    finally:
        sys.path.remove(str(bee_dir))


# ---------------------------------------------------------------------------
# Hygiene: no em or en dashes in any station source file.
# ---------------------------------------------------------------------------
def test_no_dashes_in_station_files():
    em, en = chr(0x2014), chr(0x2013)
    for path in sorted(HERE.glob("*.py")) + sorted(HERE.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        assert em not in text, f"em dash in {path.name}"
        assert en not in text, f"en dash in {path.name}"


# ---------------------------------------------------------------------------
def main():
    tests = [(name, fn) for name, fn in sorted(globals().items())
             if name.startswith("test_") and callable(fn)]
    for name, fn in tests:
        check(name.replace("test_", "").replace("_", " "), fn)
    print()
    if FAILURES:
        print(f"{len(FAILURES)} of {len(tests)} tests FAILED")
        return 1
    print(f"all {len(tests)} tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
