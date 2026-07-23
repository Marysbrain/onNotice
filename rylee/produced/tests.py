"""tests.py

Plain-python tests for the produced-lane renderer. No torch, no chatterbox, no
model needed: everything here exercises the schema validator, the delivery
mapping, and the no-additions invariant. Run with:

    python tests.py

Exit code is nonzero if any test fails.
"""

from __future__ import annotations

import json
from pathlib import Path

import render_script as rs

HERE = Path(__file__).resolve().parent
AB_SCRIPT = HERE / "ab_script.json"

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f"  ({detail})" if detail and not cond else ""))
    if not cond:
        _failures.append(name)


def expect_reject(name: str, obj: object) -> None:
    try:
        rs.validate_script(obj)
    except rs.ScriptError:
        check(name, True)
    else:
        check(name, False, "expected ScriptError, none raised")


# ---------------------------------------------------------------------------
# Schema validator
# ---------------------------------------------------------------------------
def test_schema_accepts_good() -> None:
    good = [
        {"speaker": "rylee", "text": "Hello there.", "emotion": 0.5, "pace": 1.0},
        {"speaker": "co", "text": "A question?", "emotion": 0.2, "pace": 0.9},
    ]
    out = rs.validate_script(good)
    check("schema accepts a valid script", len(out) == 2)
    check("schema fills defaults are floats",
          isinstance(out[0]["emotion"], float) and isinstance(out[0]["pace"], float))


def test_schema_defaults() -> None:
    line = rs.validate_line({"speaker": "co", "text": "Hi."}, 0)
    check("emotion defaults to 0.5", line["emotion"] == 0.5)
    check("pace defaults to 1.0", line["pace"] == 1.0)


def test_schema_rejections() -> None:
    expect_reject("reject: not a list", {"speaker": "rylee", "text": "x"})
    expect_reject("reject: empty list", [])
    expect_reject("reject: unknown speaker",
                  [{"speaker": "host", "text": "x", "emotion": 0.5, "pace": 1.0}])
    expect_reject("reject: empty text",
                  [{"speaker": "rylee", "text": "", "emotion": 0.5, "pace": 1.0}])
    expect_reject("reject: non-string text",
                  [{"speaker": "rylee", "text": 3, "emotion": 0.5, "pace": 1.0}])
    expect_reject("reject: emotion out of range",
                  [{"speaker": "rylee", "text": "x", "emotion": 1.5, "pace": 1.0}])
    expect_reject("reject: pace out of range",
                  [{"speaker": "rylee", "text": "x", "emotion": 0.5, "pace": 9.0}])
    expect_reject("reject: em dash in text",
                  [{"speaker": "rylee", "text": "a " + chr(0x2014) + " b", "emotion": 0.5, "pace": 1.0}])
    expect_reject("reject: bool emotion",
                  [{"speaker": "rylee", "text": "x", "emotion": True, "pace": 1.0}])


# ---------------------------------------------------------------------------
# No-additions invariant. The concatenation of everything the engine is asked
# to speak must equal the concatenation of the input line texts, exactly.
# ---------------------------------------------------------------------------
def test_no_additions_synthetic() -> None:
    script = rs.validate_script([
        {"speaker": "rylee", "text": "First line.", "emotion": 0.5, "pace": 1.0},
        {"speaker": "co", "text": "Second line?", "emotion": 0.3, "pace": 0.9},
        {"speaker": "rylee", "text": "Third and last.", "emotion": 0.6, "pace": 1.1},
    ])
    spoken = rs.concatenated_spoken(script)
    original = rs.concatenated_input(script)
    check("spoken concatenation equals input concatenation", spoken == original)
    check("per-line spoken text is verbatim",
          rs.spoken_texts(script) == [l["text"] for l in script])
    check("no text was added",
          spoken == "First line.Second line?Third and last.")


def test_no_additions_on_ab_script() -> None:
    raw = json.loads(AB_SCRIPT.read_text(encoding="utf-8"))
    script = rs.validate_script(raw)
    check("ab_script.json validates", len(script) == 8, f"got {len(script)} lines")
    check("ab_script.json has both speakers",
          {l["speaker"] for l in script} == {"rylee", "co"})
    check("ab_script.json no-additions invariant holds",
          rs.concatenated_spoken(script) == rs.concatenated_input(script))
    # The engine text for each line is exactly the JSON text, untouched.
    check("ab_script.json spoken text is byte-identical to input",
          rs.spoken_texts(script) == [l["text"] for l in raw])
    # Belt and suspenders on the em dash ban.
    check("ab_script.json contains no em or en dashes",
          all(chr(0x2014) not in l["text"] and chr(0x2013) not in l["text"] for l in script))


# ---------------------------------------------------------------------------
# Delivery mapping stays inside the engine's safe bands and is monotonic.
# ---------------------------------------------------------------------------
def test_delivery_mapping() -> None:
    flat = {"speaker": "co", "text": "x", "emotion": 0.0, "pace": 1.0}
    warm = {"speaker": "co", "text": "x", "emotion": 1.0, "pace": 1.0}
    e_flat, _ = rs.delivery_for(flat, has_ref=True)
    e_warm, _ = rs.delivery_for(warm, has_ref=True)
    check("higher emotion gives higher exaggeration", e_warm > e_flat)
    check("exaggeration stays within band",
          rs.EXAG_MIN <= e_flat <= rs.EXAG_MAX and rs.EXAG_MIN <= e_warm <= rs.EXAG_MAX)

    slow = {"speaker": "co", "text": "x", "emotion": 0.5, "pace": 0.5}
    fast = {"speaker": "co", "text": "x", "emotion": 0.5, "pace": 1.5}
    _, c_slow = rs.delivery_for(slow, has_ref=True)
    _, c_fast = rs.delivery_for(fast, has_ref=True)
    check("slower pace gives lower cfg_weight", c_slow < c_fast)
    check("cfg_weight stays within band",
          rs.CFG_MIN <= c_slow <= rs.CFG_MAX and rs.CFG_MIN <= c_fast <= rs.CFG_MAX)

    # Built-in-voice fallback biases the two anchors apart.
    r_line = {"speaker": "rylee", "text": "x", "emotion": 0.5, "pace": 1.0}
    c_line = {"speaker": "co", "text": "x", "emotion": 0.5, "pace": 1.0}
    check("built-in fallback distinguishes the anchors",
          rs.delivery_for(r_line, has_ref=False) != rs.delivery_for(c_line, has_ref=False))


def main() -> int:
    test_schema_accepts_good()
    test_schema_defaults()
    test_schema_rejections()
    test_no_additions_synthetic()
    test_no_additions_on_ab_script()
    test_delivery_mapping()
    print()
    if _failures:
        print(f"{len(_failures)} test(s) failed: {', '.join(_failures)}")
        return 1
    print("all tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
