#!/usr/bin/env python3
"""The worker bee for Carriers On Notice.

High volume text jobs at zero Anthropic token cost. One prompt in, one text
out, one mechanical validator after. The bee NEVER acts. It only writes files
into a proposal tray that a human supervised orchestrator reviews.

Python standard library only. No pip, ever. Runs on any Python 3.9 or newer.
All input and output lives under ~/bee/ (override with env BEE_HOME for tests).
The only network egress is to the Ollama daemon, default http://127.0.0.1:11434
(override with env BEE_OLLAMA_URL for tests).

No em dashes anywhere in this file, output included.
"""

import argparse
import json
import os
import re
import sys
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import request as urlrequest
from urllib.error import URLError, HTTPError

import prompts

# ---------------------------------------------------------------------------
# Configuration. Resolved live from the environment on every call so tests can
# redirect the home directory and the Ollama endpoint per run.
# ---------------------------------------------------------------------------

FALLBACK_MODEL = "llama3:latest"
CLOUD_TIMEOUT = 300
LOCAL_TIMEOUT = 120
MAX_ATTEMPTS = 2

# Watch mode loop timing. The loop drains, waits, and drops a heartbeat.
WATCH_INTERVAL = 3
HEARTBEAT_INTERVAL = 300

# Draft type: private freeform drafting. One hard cap, one strip, no policing.
DRAFT_MAX_CHARS = 20000

# Web UI defaults. Bind address is overridable for a locked down home network.
WEB_PORT = 8899

SUBDIRS = ("jobs", "working", "out", "failed", "log")


def web_bind():
    return os.environ.get("BEE_BIND", "0.0.0.0")


def bee_home():
    return Path(os.environ.get("BEE_HOME", str(Path.home() / "bee"))).resolve()


def bee_dir(name):
    return bee_home() / name


def ollama_url():
    return os.environ.get("BEE_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")


def ensure_dirs():
    for name in SUBDIRS:
        bee_dir(name).mkdir(parents=True, exist_ok=True)


def assert_under_bee(path):
    """Guard: refuse to write anything outside the bee home tree."""
    home = bee_home()
    p = Path(path).resolve()
    if home not in p.parents and p != home:
        raise RuntimeError("refusing to write outside bee home: {0}".format(p))
    return p


def log(msg):
    ensure_dirs()
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
    line = "{0} {1}\n".format(stamp, msg)
    with open(assert_under_bee(bee_dir("log") / "bee.log"), "a", encoding="utf-8") as fh:
        fh.write(line)


# ---------------------------------------------------------------------------
# Shared mechanical helpers used by the validators.
# ---------------------------------------------------------------------------

# Em class dashes: em dash, horizontal bar, figure dash. Banned everywhere.
# Built from code points so this source file holds no literal em dash.
EM_DASHES = chr(0x2014) + chr(0x2015) + chr(0x2012)
# En dash. Banned additionally inside show scripts.
EN_DASH = chr(0x2013)

# A number token: a run of digits with optional internal commas or dots.
_NUM_RE = re.compile(r"\d[\d,\.]*\d|\d")

# Whole word employee terms and founder terms that must never appear.
_EMPLOYEE_RE = re.compile(
    r"\b(rep|employee|manager|staff|associate|worker|agent)\b", re.IGNORECASE
)
_FOUNDER_RE = re.compile(r"\b(michael|hipp|founder)\b", re.IGNORECASE)

# Rhetorical assertion tells. A question that leads with a negative auxiliary
# contraction, or that contains a classic assertion-in-costume phrase, is
# treated as a smuggled claim and rejected.
_RHET_START_RE = re.compile(
    r"^\s*[\"'“‘]?\s*"
    r"(isn'?t|aren'?t|wasn'?t|weren'?t|don'?t|doesn'?t|didn'?t|haven'?t|hasn'?t|"
    r"hadn'?t|won'?t|wouldn'?t|couldn'?t|shouldn'?t|can'?t)\b",
    re.IGNORECASE,
)
_RHET_PHRASE_RE = re.compile(
    r"(isn'?t it true|is it not true|everyone knows|we all know|admit it)",
    re.IGNORECASE,
)


def numbers_in(text):
    return _NUM_RE.findall(text or "")


def has_em_dash(text):
    return any(c in (text or "") for c in EM_DASHES)


def has_em_or_en_dash(text):
    return has_em_dash(text) or (EN_DASH in (text or ""))


def is_rhetorical_assertion(text):
    t = text or ""
    if _RHET_PHRASE_RE.search(t):
        return True
    if "?" in t and _RHET_START_RE.search(t):
        return True
    return False


def foreign_numbers(text, source):
    """Return number tokens in text that do not appear verbatim in source."""
    return [n for n in numbers_in(text) if n not in (source or "")]


# ---------------------------------------------------------------------------
# Output validators. Each is a pure function: (payload, output) -> (ok, reasons)
# These are the enforcement point. The prompt asks nicely; these decide.
# ---------------------------------------------------------------------------


def validate_show_script(payload, obj):
    reasons = []
    records = payload.get("records", [])
    by_id = {r["id"]: r for r in records}
    id_set = set(by_id.keys())
    target = int(payload.get("target_lines", 8))

    if not isinstance(obj, list):
        return False, ["output is not a JSON array"]
    n = len(obj)
    if n == 0:
        return False, ["script is empty"]
    if not (target - 2 <= n <= target + 2):
        reasons.append(
            "line count {0} outside target {1} plus or minus 2".format(n, target)
        )

    # Line 1 must carry the disclosure verbatim.
    first_text = obj[0].get("text", "") if isinstance(obj[0], dict) else ""
    if prompts.DISCLOSURE not in first_text:
        reasons.append("line 1 is missing the exact AI disclosure line")

    speakers = []
    for idx, line in enumerate(obj):
        tag = "line {0}".format(idx + 1)
        if not isinstance(line, dict):
            reasons.append("{0} is not an object".format(tag))
            continue
        speaker = line.get("speaker")
        text = line.get("text", "")
        rid = line.get("record_id", None)
        speakers.append(speaker)

        if speaker not in ("rylee", "co"):
            reasons.append("{0} has invalid speaker {1!r}".format(tag, speaker))
        if not isinstance(text, str) or not text.strip():
            reasons.append("{0} has empty text".format(tag))
            continue
        if "emotion" not in line or "pace" not in line:
            reasons.append("{0} is missing emotion or pace".format(tag))

        if has_em_or_en_dash(text):
            reasons.append("{0} contains an em or en dash".format(tag))
        if is_rhetorical_assertion(text):
            reasons.append("{0} is a question that asserts".format(tag))

        has_digit = bool(numbers_in(text))
        has_dollar = "$" in text

        if rid is not None and rid not in id_set:
            reasons.append("{0} cites unknown record_id {1!r}".format(tag, rid))
            # Cannot check numbers against a record we do not have.
            continue

        if has_digit or has_dollar:
            if rid is None:
                reasons.append(
                    "{0} contains a number or dollar sign but has no record_id".format(tag)
                )
            else:
                excerpt = by_id[rid].get("excerpt", "")
                missing = foreign_numbers(text, excerpt)
                if missing:
                    reasons.append(
                        "{0} has numbers {1} not in record {2}".format(tag, missing, rid)
                    )
        else:
            if rid is None:
                # Pure banter line. Confirm it truly carries no digits.
                if has_digit:
                    reasons.append("{0} banter line carries a digit".format(tag))

    # Alternating-ish: never three in a row from the same speaker.
    run = 1
    for i in range(1, len(speakers)):
        if speakers[i] == speakers[i - 1] and speakers[i] is not None:
            run += 1
            if run >= 3:
                reasons.append(
                    "speakers do not alternate near line {0}".format(i + 1)
                )
                break
        else:
            run = 1

    return (len(reasons) == 0), reasons


def validate_summarize_record(payload, text):
    reasons = []
    excerpt = payload.get("excerpt", "")
    if not isinstance(text, str):
        return False, ["output is not text"]
    text = text.strip()
    if not text:
        return False, ["summary is empty"]
    if has_em_dash(text):
        reasons.append("summary contains an em dash")
    if len(text) >= 320:
        reasons.append("summary is {0} chars, not under 320".format(len(text)))
    enders = re.findall(r"[.!?]+", text)
    if len(enders) > 2:
        reasons.append("summary has more than 2 sentences")
    missing = foreign_numbers(text, excerpt)
    if missing:
        reasons.append("summary has numbers {0} not in the excerpt".format(missing))
    return (len(reasons) == 0), reasons


def validate_question_bank(payload, obj):
    reasons = []
    source_parts = [payload.get("topic", "")]
    for r in payload.get("records", []):
        source_parts.append(r.get("excerpt", ""))
    source = " ".join(source_parts)

    if not isinstance(obj, list):
        return False, ["output is not a JSON array"]
    if not obj:
        return False, ["question bank is empty"]

    for idx, item in enumerate(obj):
        tag = "question {0}".format(idx + 1)
        if not isinstance(item, str) or not item.strip():
            reasons.append("{0} is not a non-empty string".format(tag))
            continue
        if not item.rstrip().endswith("?"):
            reasons.append("{0} does not end with a question mark".format(tag))
        if has_em_dash(item):
            reasons.append("{0} contains an em dash".format(tag))
        missing = foreign_numbers(item, source)
        if missing:
            reasons.append("{0} has numbers {1} not in the input".format(tag, missing))
        if _EMPLOYEE_RE.search(item):
            reasons.append("{0} names an employee role".format(tag))
        if _FOUNDER_RE.search(item):
            reasons.append("{0} mentions the founder".format(tag))
        if is_rhetorical_assertion(item):
            reasons.append("{0} is a question that asserts".format(tag))
    return (len(reasons) == 0), reasons


# Song-form vocal terms. The vocal-pop lane is closed until earned (amendment
# 9 of the broadcast spec); wordless voice as texture stays open, so words
# like choir and hum are not on this list.
_VOCAL_POP_RE = re.compile(
    r"\b(lyric|lyrics|verse|chorus|singer|vocalist|sung|rapping|rapper)\b",
    re.IGNORECASE,
)


def validate_mood_brief(payload, obj):
    reasons = []
    if not isinstance(obj, dict):
        return False, ["output is not a JSON object"]

    allowed_keys = {"name", "prompt", "tags"}
    unknown = set(obj.keys()) - allowed_keys
    if unknown:
        reasons.append("unknown keys {0}".format(sorted(unknown)))
    missing = allowed_keys - set(obj.keys())
    if missing:
        return False, ["missing keys {0}".format(sorted(missing))]

    # The only numbers the output may contain anywhere are numbers already in
    # the input payload (the tempo range). Everything is checked against the
    # serialized input, same discipline as the fact validators.
    source = json.dumps(payload)

    name = obj.get("name")
    prompt_text = obj.get("prompt")
    tags = obj.get("tags")

    if not isinstance(name, str) or not name.strip():
        reasons.append("name is not a non-empty string")
    else:
        if len(name.split()) > 6:
            reasons.append("name is more than six words")
        if len(name) > 60:
            reasons.append("name is longer than 60 characters")
        if numbers_in(name):
            reasons.append("name contains a digit")

    if not isinstance(prompt_text, str) or not prompt_text.strip():
        reasons.append("prompt is not a non-empty string")
    else:
        if len(prompt_text) > 700:
            reasons.append("prompt is {0} chars, over 700".format(len(prompt_text)))
        lane = payload.get("lane", "")
        if lane and lane.lower() not in prompt_text.lower():
            reasons.append("prompt does not name the {0} lane".format(lane))
        foreign = foreign_numbers(prompt_text, source)
        if foreign:
            reasons.append("prompt has numbers {0} not in the input".format(foreign))

    if not isinstance(tags, list) or not (3 <= len(tags) <= 6):
        reasons.append("tags must be a list of 3 to 6 entries")
    else:
        for idx, tag in enumerate(tags):
            if not isinstance(tag, str) or not tag.strip():
                reasons.append("tag {0} is not a non-empty string".format(idx + 1))
                continue
            if tag != tag.lower():
                reasons.append("tag {0} is not lowercase".format(idx + 1))
            if len(tag.split()) > 2:
                reasons.append("tag {0} is more than two words".format(idx + 1))
            if numbers_in(tag):
                reasons.append("tag {0} contains a digit".format(idx + 1))

    everything = " ".join([
        name if isinstance(name, str) else "",
        prompt_text if isinstance(prompt_text, str) else "",
        " ".join(t for t in tags if isinstance(t, str)) if isinstance(tags, list) else "",
    ])
    if has_em_or_en_dash(everything):
        reasons.append("output contains an em or en dash")
    if _VOCAL_POP_RE.search(everything):
        reasons.append("output uses song-form vocal terms; that lane is closed")
    if _EMPLOYEE_RE.search(everything):
        reasons.append("output names an employee role")
    if _FOUNDER_RE.search(everything):
        reasons.append("output mentions the founder")

    return (len(reasons) == 0), reasons


def validate_taxonomy_candidates(payload, obj):
    reasons = []
    joined = "\n".join(payload.get("excerpts", [])).lower()
    if not isinstance(obj, list):
        return False, ["output is not a JSON array"]
    if not obj:
        return False, ["candidate list is empty"]
    for idx, term in enumerate(obj):
        tag = "term {0}".format(idx + 1)
        if not isinstance(term, str) or not term.strip():
            reasons.append("{0} is not a non-empty string".format(tag))
            continue
        if has_em_dash(term):
            reasons.append("{0} contains an em dash".format(tag))
        if len(term.split()) > 4:
            reasons.append("{0} is more than four words".format(tag))
        if term.strip().lower() not in joined:
            reasons.append("{0} {1!r} does not appear in any excerpt".format(tag, term))
    return (len(reasons) == 0), reasons


# ---------------------------------------------------------------------------
# Input schema validators for submit. Cheap structural checks so a malformed
# job never reaches the runner.
# ---------------------------------------------------------------------------


def _check_records(records, need):
    errs = []
    if not isinstance(records, list) or not records:
        return ["records must be a non-empty list"]
    for i, r in enumerate(records):
        if not isinstance(r, dict):
            errs.append("record {0} is not an object".format(i))
            continue
        for key in need:
            if key not in r:
                errs.append("record {0} missing {1}".format(i, key))
    return errs


def validate_input_show_script(payload):
    errs = []
    errs += _check_records(
        payload.get("records"), ("id", "excerpt", "source_url", "record_date")
    )
    if not isinstance(payload.get("topic", ""), str):
        errs.append("topic must be a string")
    if not isinstance(payload.get("target_lines"), int):
        errs.append("target_lines must be an integer")
    return errs


def validate_input_summarize_record(payload):
    errs = []
    if not payload.get("id"):
        errs.append("id is required")
    if not isinstance(payload.get("excerpt", ""), str) or not payload.get("excerpt"):
        errs.append("excerpt must be a non-empty string")
    return errs


def validate_input_question_bank(payload):
    errs = []
    if not isinstance(payload.get("topic", ""), str) or not payload.get("topic"):
        errs.append("topic must be a non-empty string")
    errs += _check_records(payload.get("records"), ("id", "excerpt"))
    return errs


def validate_input_mood_brief(payload):
    errs = []
    lane = payload.get("lane")
    lanes = payload.get("lanes")
    if not isinstance(lane, str) or not lane.strip():
        errs.append("lane must be a non-empty string")
    if not isinstance(lanes, list) or not lanes:
        errs.append("lanes must be a non-empty list")
    elif lane not in lanes:
        errs.append("lane must be one of lanes")
    desc = payload.get("descriptors")
    if not isinstance(desc, list) or not desc:
        errs.append("descriptors must be a non-empty list")
    elif not all(isinstance(d, str) and d.strip() for d in desc):
        errs.append("every descriptor must be a non-empty string")
    for key in ("tempo_lo", "tempo_hi"):
        v = payload.get(key)
        if not isinstance(v, int) or not (40 <= v <= 220):
            errs.append("{0} must be an integer between 40 and 220".format(key))
    if not errs and payload.get("tempo_lo") >= payload.get("tempo_hi"):
        errs.append("tempo_lo must be below tempo_hi")
    energy = payload.get("energy")
    if not isinstance(energy, (int, float)) or isinstance(energy, bool) \
            or not (0.0 <= float(energy) <= 1.0):
        errs.append("energy must be a number in 0..1")
    return errs


def validate_input_taxonomy_candidates(payload):
    errs = []
    ex = payload.get("excerpts")
    if not isinstance(ex, list) or not ex:
        errs.append("excerpts must be a non-empty list")
    elif not all(isinstance(e, str) and e.strip() for e in ex):
        errs.append("every excerpt must be a non-empty string")
    return errs


def validate_input_draft(payload):
    errs = []
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        errs.append("prompt must be a non-empty string")
    return errs


# ---------------------------------------------------------------------------
# JSON extraction from model output. Local models like to wrap arrays in prose
# or fences. Pull the array out tolerantly, then parse strictly.
# ---------------------------------------------------------------------------


def extract_json_array(text):
    t = (text or "").strip()
    try:
        v = json.loads(t)
        if isinstance(v, list):
            return v, None
    except Exception:
        pass
    i = t.find("[")
    j = t.rfind("]")
    if i != -1 and j != -1 and j > i:
        try:
            v = json.loads(t[i:j + 1])
            if isinstance(v, list):
                return v, None
        except Exception as e:
            return None, "could not parse JSON array: {0}".format(e)
    return None, "no JSON array found in model output"


def parse_text(text):
    return (text or "").strip(), None


def strip_em_dashes(text):
    """Remove every em class dash from text. Private tool, so we strip, we do
    not reject. Each banned dash becomes a single space to avoid word joins."""
    out = text or ""
    for c in EM_DASHES:
        out = out.replace(c, " ")
    return out


def parse_draft(text):
    """Shape freeform draft output: strip em dashes, cap the size. Never fails
    to parse; the founder's raw text is always accepted as far as it goes."""
    shaped = strip_em_dashes((text or "").strip())
    if len(shaped) > DRAFT_MAX_CHARS:
        shaped = shaped[:DRAFT_MAX_CHARS]
    return shaped, None


def validate_draft(payload, text):
    """No content policing beyond a non-empty, dash-free, capped string. The
    stripping and the cap happen in parse_draft, so this only guards emptiness
    and re-confirms the two hard invariants."""
    if not isinstance(text, str) or not text.strip():
        return False, ["draft output is empty"]
    reasons = []
    if has_em_dash(text):
        reasons.append("draft still contains an em dash")
    if len(text) > DRAFT_MAX_CHARS:
        reasons.append("draft exceeds {0} characters".format(DRAFT_MAX_CHARS))
    return (len(reasons) == 0), reasons


def extract_json_object(text):
    """Pull a JSON object out of model output tolerantly, parse strictly."""
    t = (text or "").strip()
    try:
        v = json.loads(t)
        if isinstance(v, dict):
            return v, None
    except Exception:
        pass
    i = t.find("{")
    j = t.rfind("}")
    if i != -1 and j != -1 and j > i:
        try:
            v = json.loads(t[i:j + 1])
            if isinstance(v, dict):
                return v, None
        except Exception as e:
            return None, "could not parse JSON object: {0}".format(e)
    return None, "no JSON object found in model output"


# ---------------------------------------------------------------------------
# Job type registry. One row per type ties together its input validator, its
# prompt builder, how to parse the model output, and its output validator.
# ---------------------------------------------------------------------------

TYPES = {
    "show_script": {
        "input": validate_input_show_script,
        "build": prompts.build_show_script,
        "parse": extract_json_array,
        "validate": validate_show_script,
    },
    "summarize_record": {
        "input": validate_input_summarize_record,
        "build": prompts.build_summarize_record,
        "parse": parse_text,
        "validate": validate_summarize_record,
    },
    "question_bank": {
        "input": validate_input_question_bank,
        "build": prompts.build_question_bank,
        "parse": extract_json_array,
        "validate": validate_question_bank,
    },
    "taxonomy_candidates": {
        "input": validate_input_taxonomy_candidates,
        "build": prompts.build_taxonomy_candidates,
        "parse": extract_json_array,
        "validate": validate_taxonomy_candidates,
    },
    "mood_brief": {
        "input": validate_input_mood_brief,
        "build": prompts.build_mood_brief,
        "parse": extract_json_object,
        "validate": validate_mood_brief,
    },
    "draft": {
        "input": validate_input_draft,
        "build": prompts.build_draft,
        "parse": parse_draft,
        "validate": validate_draft,
    },
}


# ---------------------------------------------------------------------------
# Ollama call. Non-streaming generate. Any failure returns None so the caller
# can fall back to the next model in the chain.
# ---------------------------------------------------------------------------


def timeout_for(model):
    return CLOUD_TIMEOUT if "cloud" in (model or "").lower() else LOCAL_TIMEOUT


def call_ollama(model, prompt, timeout):
    body = json.dumps({"model": model, "prompt": prompt, "stream": False}).encode("utf-8")
    url = ollama_url() + "/api/generate"
    req = urlrequest.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urlrequest.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
        data = json.loads(raw)
        return data.get("response", "")
    except (HTTPError, URLError, TimeoutError, ValueError, OSError) as e:
        log("ollama call failed model={0}: {1}".format(model, e))
        return None


def fallback_chain(requested):
    chain = []
    for m in (requested, FALLBACK_MODEL):
        if m and m not in chain:
            chain.append(m)
    return chain


def fetch_tags(timeout=10):
    """Return the list of model dicts from Ollama /api/tags, or raise. Shared
    by doctor and the web model dropdown."""
    url = ollama_url() + "/api/tags"
    req = urlrequest.Request(url)
    with urlrequest.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("models", [])


def model_names(timeout=5):
    """Best effort model name list, cloud models first. Never raises. Always
    includes the fallback model so the dropdown is never empty."""
    names = []
    try:
        for m in fetch_tags(timeout=timeout):
            name = m.get("name") if isinstance(m, dict) else None
            if name and name not in names:
                names.append(name)
    except Exception:
        pass
    if FALLBACK_MODEL not in names:
        names.append(FALLBACK_MODEL)
    cloud = [n for n in names if "cloud" in n.lower()]
    rest = [n for n in names if "cloud" not in n.lower()]
    return cloud + rest


# ---------------------------------------------------------------------------
# Commands.
# ---------------------------------------------------------------------------


def submit_job(job_type, raw):
    """Core submit path shared by the CLI and the web UI. Validates the input
    schema, then atomically publishes a job file. Returns (ok, job_id, errs).
    No printing here so both callers can present results their own way."""
    if job_type not in TYPES:
        return False, None, ["unknown job type: {0}".format(job_type)]
    if not isinstance(raw, dict):
        return False, None, ["input must be a JSON object"]

    model = raw.get("model") or FALLBACK_MODEL
    payload = {k: v for k, v in raw.items() if k != "model"}

    errs = TYPES[job_type]["input"](payload)
    if errs:
        return False, None, errs

    ensure_dirs()
    job_id = "{0}-{1}-{2}".format(job_type, int(time.time() * 1000), uuid.uuid4().hex[:6])
    job = {
        "id": job_id,
        "type": job_type,
        "model": model,
        "input": payload,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    # Atomic publish: write to working, then rename into jobs.
    tmp = assert_under_bee(bee_dir("working") / (job_id + ".tmp.json"))
    dest = assert_under_bee(bee_dir("jobs") / (job_id + ".json"))
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(job, fh, indent=2)
    os.rename(tmp, dest)
    log("submitted {0}".format(job_id))
    return True, job_id, []


def cmd_submit(job_type, input_path):
    if job_type not in TYPES:
        print("unknown job type: {0}".format(job_type), file=sys.stderr)
        print("valid types: {0}".format(", ".join(sorted(TYPES))), file=sys.stderr)
        return 2
    try:
        with open(input_path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except Exception as e:
        print("could not read input JSON: {0}".format(e), file=sys.stderr)
        return 2
    if not isinstance(raw, dict):
        print("input JSON must be an object", file=sys.stderr)
        return 2

    ok, job_id, errs = submit_job(job_type, raw)
    if not ok:
        print("input schema invalid:", file=sys.stderr)
        for e in errs:
            print("  - {0}".format(e), file=sys.stderr)
        return 1

    dest = bee_dir("jobs") / (job_id + ".json")
    print("submitted {0}".format(job_id))
    print(str(dest))
    return 0


def _process_job(job):
    """Run one already-claimed job. Return (ok, out_or_none, reasons)."""
    job_type = job["type"]
    spec = TYPES[job_type]
    payload = job["input"]
    prompt = spec["build"](payload)
    chain = fallback_chain(job.get("model"))

    started = time.time()
    reasons = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        text = None
        model_used = None
        for model in chain:
            text = call_ollama(model, prompt, timeout_for(model))
            if text is not None:
                model_used = model
                break
        if text is None:
            reasons.append("attempt {0}: no model in the chain responded".format(attempt))
            continue

        parsed, perr = spec["parse"](text)
        if perr:
            reasons.append("attempt {0}: {1}".format(attempt, perr))
            continue

        ok, verrs = spec["validate"](payload, parsed)
        if ok:
            out = {
                "job": job,
                "model_used": model_used,
                "elapsed": round(time.time() - started, 3),
                "output": parsed,
                "validation": "pass",
            }
            return True, out, []
        reasons.append("attempt {0}: {1}".format(attempt, "; ".join(verrs)))

    return False, None, reasons


def _handle_job(job_path):
    """Claim and process one job file. Crash resilient: any exception, from any
    job type, is caught and lands the job in failed/ with the full traceback so
    the watch loop can never be killed by a single bad job. Returns one of
    "accepted", "failed", "crashed", or None if the job was already claimed."""
    name = job_path.name
    working_path = assert_under_bee(bee_dir("working") / name)
    try:
        os.rename(job_path, working_path)  # atomic claim
    except OSError:
        return None  # another drain took it

    try:
        try:
            with open(working_path, "r", encoding="utf-8") as fh:
                job = json.load(fh)
        except Exception as e:
            fail = assert_under_bee(bee_dir("failed") / name)
            os.rename(working_path, fail)
            log("job {0} unreadable: {1}".format(name, e))
            return "failed"

        job_id = job.get("id", name)
        if job.get("type") not in TYPES:
            job["failure_reasons"] = ["unknown job type"]
            _write_failed(job_id, job)
            os.remove(working_path)
            log("failed {0}: unknown job type".format(job_id))
            return "failed"

        ok, out, reasons = _process_job(job)
        if ok:
            dest = assert_under_bee(bee_dir("out") / (job_id + ".json"))
            with open(dest, "w", encoding="utf-8") as fh:
                json.dump(out, fh, indent=2)
            os.remove(working_path)
            log("accepted {0} model={1}".format(job_id, out["model_used"]))
            return "accepted"
        job["failure_reasons"] = reasons
        _write_failed(job_id, job)
        os.remove(working_path)
        log("failed {0}: {1}".format(job_id, " | ".join(reasons)))
        return "failed"
    except Exception:
        tb = traceback.format_exc()
        try:
            with open(working_path, "r", encoding="utf-8") as fh:
                job = json.load(fh)
        except Exception:
            job = {"id": name, "type": "unknown"}
        job_id = job.get("id", name)
        job["failure_reasons"] = ["crashed while processing:\n" + tb]
        _write_failed(job_id, job)
        try:
            if working_path.exists():
                os.remove(working_path)
        except OSError:
            pass
        log("crashed {0}: {1}".format(job_id, tb.splitlines()[-1] if tb.strip() else "unknown"))
        return "crashed"


def run_once_iteration():
    """Drain the inbox once and return a counts dict. This is the unit the
    watch loop calls on each tick, and the unit the tests exercise directly."""
    ensure_dirs()
    counts = {"processed": 0, "accepted": 0, "failed": 0, "crashed": 0}
    for job_path in sorted(bee_dir("jobs").glob("*.json")):
        status = _handle_job(job_path)
        if status:
            counts["processed"] += 1
            counts[status] = counts.get(status, 0) + 1
    return counts


def cmd_run_once():
    ensure_dirs()
    counts = run_once_iteration()
    if counts["processed"] == 0:
        print("no jobs to run")
    else:
        print("processed {0} job(s): {1} accepted, {2} failed, {3} crashed".format(
            counts["processed"], counts["accepted"], counts["failed"], counts["crashed"]))
    return 0


def _write_failed(job_id, job):
    dest = assert_under_bee(bee_dir("failed") / (job_id + ".json"))
    with open(dest, "w", encoding="utf-8") as fh:
        json.dump(job, fh, indent=2)


def queue_depths():
    ensure_dirs()
    return {name: len(list(bee_dir(name).glob("*.json")))
            for name in ("jobs", "working", "out", "failed")}


def cmd_watch():
    """Loop run-once forever. Clean Ctrl-C exit, a heartbeat to the log every
    five minutes, and per-job crash resilience so one bad job never stops the
    loop. Foreground process, meant to be kept alive by launchd."""
    ensure_dirs()
    log("watch start interval={0}s".format(WATCH_INTERVAL))
    print("bee watch: draining every {0} seconds. Press Ctrl-C to stop.".format(WATCH_INTERVAL))
    last_heartbeat = 0.0
    try:
        while True:
            try:
                counts = run_once_iteration()
                if counts["processed"]:
                    log("watch drained {0}".format(counts))
            except Exception:
                # The iteration itself should never raise (jobs are guarded),
                # but if it does, log and keep looping. Resilience is the point.
                log("watch iteration error:\n" + traceback.format_exc())
            now = time.time()
            if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                log("heartbeat depths={0}".format(queue_depths()))
                last_heartbeat = now
            time.sleep(WATCH_INTERVAL)
    except KeyboardInterrupt:
        print("\nbee watch: stopped cleanly.")
        log("watch stop")
        return 0


def dir_size_bytes(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            fp = os.path.join(root, f)
            try:
                total += os.path.getsize(fp)
            except OSError:
                pass
    return total


def cmd_doctor():
    """Health check for the daily driver. Confirms Ollama is reachable, lists
    its models, reports queue depths and disk usage, and exits nonzero if
    anything is wrong so launchd or a person can notice."""
    ensure_dirs()
    problems = []

    print("bee home: {0}".format(bee_home()))
    print("ollama:   {0}".format(ollama_url()))
    try:
        models = fetch_tags(timeout=10)
        names = [m.get("name") for m in models if isinstance(m, dict) and m.get("name")]
        print("ollama reachable: yes")
        if names:
            print("models ({0}): {1}".format(len(names), ", ".join(names)))
        else:
            print("models: none listed")
            problems.append("no models available from ollama")
    except Exception as e:
        print("ollama reachable: NO ({0})".format(e))
        problems.append("ollama unreachable at {0}".format(ollama_url()))

    depths = queue_depths()
    print("queue depths: jobs {0}, working {1}, out {2}, failed {3}".format(
        depths["jobs"], depths["working"], depths["out"], depths["failed"]))

    size_mb = dir_size_bytes(bee_home()) / (1024.0 * 1024.0)
    print("disk usage of bee home: {0:.1f} MB".format(size_mb))

    if problems:
        print("problems found:")
        for p in problems:
            print("  - {0}".format(p))
        return 1
    print("all checks passed")
    return 0


def cmd_status():
    ensure_dirs()
    counts = {}
    for name in ("jobs", "working", "out", "failed"):
        counts[name] = len(list(bee_dir(name).glob("*.json")))
    print("bee home: {0}".format(bee_home()))
    print("ollama:   {0}".format(ollama_url()))
    print("jobs waiting:   {0}".format(counts["jobs"]))
    print("in progress:    {0}".format(counts["working"]))
    print("accepted (out): {0}".format(counts["out"]))
    print("failed:         {0}".format(counts["failed"]))
    return 0


# ---------------------------------------------------------------------------
# Web UI. A single page served from stdlib http.server, designed for a
# dyslexic talk-to-text user: one big textarea, a large submit button, a live
# model dropdown, a job type selector defaulting to draft, and a results feed
# that polls every few seconds. No frameworks, no CDN, all inline. Submissions
# go through submit_job, the exact same path the CLI uses. Trusted LAN only.
# ---------------------------------------------------------------------------


def _preview_of(output):
    if isinstance(output, str):
        return output
    try:
        return json.dumps(output, indent=2)
    except Exception:
        return str(output)


def recent_results(limit=20):
    """Newest outputs from out/ and failed/, newest first. Failures carry their
    reasons in plain words. Safe against half-written files."""
    items = []
    for status, sub in (("accepted", "out"), ("failed", "failed")):
        for path in bee_dir(sub).glob("*.json"):
            try:
                mtime = path.stat().st_mtime
                with open(path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except Exception:
                continue
            if status == "accepted":
                job = data.get("job", {})
                items.append({
                    "status": "accepted",
                    "id": job.get("id", path.stem),
                    "type": job.get("type", "?"),
                    "model_used": data.get("model_used", ""),
                    "elapsed": data.get("elapsed", ""),
                    "when": mtime,
                    "text": _preview_of(data.get("output", "")),
                    "reasons": [],
                })
            else:
                items.append({
                    "status": "failed",
                    "id": data.get("id", path.stem),
                    "type": data.get("type", "?"),
                    "model_used": data.get("model", ""),
                    "elapsed": "",
                    "when": mtime,
                    "text": "",
                    "reasons": data.get("failure_reasons", ["no reason recorded"]),
                })
    items.sort(key=lambda it: it["when"], reverse=True)
    for it in items:
        it["when"] = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(it["when"]))
    return items[:limit]


WEB_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The bee</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    font-size: 20px; line-height: 1.6;
    color: #101418; background: #f6f8fa;
  }
  header { background: #0b3d2e; color: #fff; padding: 20px 24px; }
  header h1 { margin: 0; font-size: 30px; letter-spacing: 0.5px; }
  header p { margin: 6px 0 0; font-size: 18px; color: #cfe8dd; }
  main { max-width: 900px; margin: 0 auto; padding: 24px; }
  .card {
    background: #fff; border: 2px solid #d0d7de; border-radius: 12px;
    padding: 22px; margin-bottom: 26px;
  }
  label { display: block; font-size: 20px; font-weight: 700; margin: 14px 0 8px; }
  textarea {
    width: 100%; min-height: 220px; font-size: 22px; line-height: 1.6;
    padding: 16px; border: 2px solid #99a3ad; border-radius: 10px;
    resize: vertical; color: #101418;
  }
  select {
    width: 100%; font-size: 20px; padding: 14px; border: 2px solid #99a3ad;
    border-radius: 10px; background: #fff; color: #101418;
  }
  .row { display: flex; gap: 18px; flex-wrap: wrap; }
  .row > div { flex: 1 1 240px; }
  button {
    margin-top: 22px; width: 100%; font-size: 26px; font-weight: 800;
    padding: 20px; border: 0; border-radius: 12px; cursor: pointer;
    background: #0b3d2e; color: #fff;
  }
  button:active { background: #072a20; }
  #note { font-size: 18px; margin-top: 14px; min-height: 26px; }
  .ok { color: #0b6b3a; font-weight: 700; }
  .err { color: #a01414; font-weight: 700; }
  h2 { font-size: 24px; margin: 8px 0 16px; }
  .result {
    background: #fff; border: 2px solid #d0d7de; border-left-width: 10px;
    border-radius: 10px; padding: 18px; margin-bottom: 18px;
  }
  .result.accepted { border-left-color: #0b6b3a; }
  .result.failed { border-left-color: #a01414; }
  .meta { font-size: 16px; color: #4a5560; margin-bottom: 10px; }
  .result pre {
    white-space: pre-wrap; word-wrap: break-word; font-size: 19px;
    line-height: 1.6; margin: 0; font-family: inherit;
  }
  .reasons { color: #a01414; font-size: 18px; }
  @media (max-width: 600px) { body { font-size: 19px; } textarea { font-size: 20px; } }
</style>
</head>
<body>
<header>
  <h1>The bee</h1>
  <p>Type or talk. Pick a model. Press the big button. Your drafts appear below.</p>
</header>
<main>
  <div class="card">
    <label for="jobtype">What kind of job</label>
    <select id="jobtype">
      <option value="draft" selected>Draft (freeform, your thinking work)</option>
      <option value="summarize_record">Summarize record (paste JSON)</option>
      <option value="show_script">Show script (paste JSON)</option>
      <option value="question_bank">Question bank (paste JSON)</option>
      <option value="taxonomy_candidates">Taxonomy candidates (paste JSON)</option>
      <option value="mood_brief">Mood brief (paste JSON)</option>
    </select>

    <label for="model">Model</label>
    <select id="model"><option value="">loading models...</option></select>

    <label for="prompt">Your prompt</label>
    <textarea id="prompt" placeholder="Say what you want the bee to write."></textarea>

    <button id="send">Submit</button>
    <div id="note"></div>
  </div>

  <h2>Newest results</h2>
  <div id="feed">Loading...</div>
</main>

<script>
function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function loadModels() {
  fetch("/api/models").then(function(r){return r.json();}).then(function(d){
    var sel = document.getElementById("model");
    sel.innerHTML = "";
    (d.models || []).forEach(function(name){
      var o = document.createElement("option");
      o.value = name; o.textContent = name; sel.appendChild(o);
    });
  }).catch(function(){});
}
function loadResults() {
  fetch("/api/results").then(function(r){return r.json();}).then(function(d){
    var feed = document.getElementById("feed");
    var items = d.results || [];
    if (!items.length) { feed.textContent = "No results yet."; return; }
    feed.innerHTML = items.map(function(it){
      var head = '<div class="meta">' + esc(it.status.toUpperCase()) + " . " +
        esc(it.type) + " . " + esc(it.model_used || "") +
        (it.elapsed !== "" ? " . " + esc(it.elapsed) + "s" : "") +
        " . " + esc(it.when) + "</div>";
      var body;
      if (it.status === "failed") {
        body = '<div class="reasons">' + esc((it.reasons||[]).join(" | ")) + "</div>";
      } else {
        body = "<pre>" + esc(it.text) + "</pre>";
      }
      return '<div class="result ' + esc(it.status) + '">' + head + body + "</div>";
    }).join("");
  }).catch(function(){});
}
document.getElementById("send").addEventListener("click", function(){
  var note = document.getElementById("note");
  var body = {
    type: document.getElementById("jobtype").value,
    model: document.getElementById("model").value,
    prompt: document.getElementById("prompt").value
  };
  note.textContent = "Sending...";
  note.className = "";
  fetch("/api/submit", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body)
  }).then(function(r){return r.json();}).then(function(d){
    if (d.ok) {
      note.textContent = "Submitted. Job " + d.job_id + ". It will appear below shortly.";
      note.className = "ok";
      document.getElementById("prompt").value = "";
      setTimeout(loadResults, 800);
    } else {
      note.textContent = "Not accepted: " + (d.errors||[]).join("; ");
      note.className = "err";
    }
  }).catch(function(e){
    note.textContent = "Error talking to the bee: " + e;
    note.className = "err";
  });
});
loadModels();
loadResults();
setInterval(loadResults, 3000);
</script>
</body>
</html>
"""


class BeeWebHandler(BaseHTTPRequestHandler):
    def _send(self, code, body, content_type="application/json"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, code, obj):
        self._send(code, json.dumps(obj), "application/json")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/" or path == "/index.html":
            self._send(200, WEB_PAGE, "text/html; charset=utf-8")
        elif path == "/api/models":
            self._send_json(200, {"models": model_names()})
        elif path == "/api/results":
            self._send_json(200, {"results": recent_results()})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/submit":
            self._send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            data = json.loads(raw) if raw.strip() else {}
        except Exception as e:
            self._send_json(400, {"ok": False, "errors": ["bad request body: {0}".format(e)]})
            return

        job_type = data.get("type", "draft")
        model = data.get("model") or None
        prompt = data.get("prompt", "")

        if job_type == "draft":
            job_input = {"prompt": prompt}
        else:
            # Structured types need a JSON payload. Parse the textarea as JSON.
            try:
                job_input = json.loads(prompt) if prompt.strip() else {}
            except Exception:
                self._send_json(200, {
                    "ok": False,
                    "errors": ["for {0}, the prompt box must contain valid JSON".format(job_type)],
                })
                return
            if not isinstance(job_input, dict):
                self._send_json(200, {"ok": False, "errors": ["job input must be a JSON object"]})
                return
        if model:
            job_input["model"] = model

        ok, job_id, errs = submit_job(job_type, job_input)
        self._send_json(200, {"ok": ok, "job_id": job_id, "errors": errs})

    def log_message(self, *args):
        pass


def make_web_server(bind, port):
    ensure_dirs()
    return ThreadingHTTPServer((bind, port), BeeWebHandler)


def cmd_web():
    bind = web_bind()
    server = make_web_server(bind, WEB_PORT)
    shown = "127.0.0.1" if bind in ("0.0.0.0", "") else bind
    log("web start bind={0}:{1}".format(bind, WEB_PORT))
    print("bee web: open http://{0}:{1} on the home network. Ctrl-C to stop.".format(shown, WEB_PORT))
    print("(bind {0}, no login, trusted LAN only)".format(bind))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbee web: stopped.")
        log("web stop")
    finally:
        server.server_close()
    return 0



def cmd_ask(prompt, model):
    """One-shot synchronous path for orchestrating Claude sessions: submit a
    draft job, drain until it completes, print the output text to stdout.
    Exit 0 on accepted output, 1 on failure. One ssh line, one answer."""
    payload = {"prompt": prompt}
    if model:
        payload["model"] = model
    ok, job_id, errs = submit_job("draft", payload)
    if not ok:
        for e in errs:
            print("submit error: {0}".format(e), file=sys.stderr)
        return 1
    deadline = time.time() + 360
    while time.time() < deadline:
        run_once_iteration()
        done = bee_dir("out") / (job_id + ".json")
        dead = bee_dir("failed") / (job_id + ".json")
        if done.exists():
            doc = json.loads(done.read_text())
            print(doc.get("output", ""))
            print("[bee model={0} elapsed={1}s]".format(
                doc.get("model_used"), doc.get("elapsed")), file=sys.stderr)
            return 0
        if dead.exists():
            doc = json.loads(dead.read_text())
            for r in doc.get("failure_reasons", []):
                print("failed: {0}".format(r), file=sys.stderr)
            return 1
        time.sleep(1)
    print("timed out waiting for the job", file=sys.stderr)
    return 1

def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    parser = argparse.ArgumentParser(description="Carriers On Notice worker bee")
    sub = parser.add_subparsers(dest="cmd")

    p_submit = sub.add_parser("submit", help="validate an input and queue a job")
    p_submit.add_argument("type")
    p_submit.add_argument("input")

    p_ask = sub.add_parser("ask", help="synchronous draft: submit, run, print")
    p_ask.add_argument("prompt")
    p_ask.add_argument("--model", default=None)
    sub.add_parser("run-once", help="drain the jobs inbox once")
    sub.add_parser("watch", help="drain the inbox in a loop until Ctrl-C")
    sub.add_parser("doctor", help="check ollama, models, queues, and disk")
    sub.add_parser("web", help="serve the single page web UI")
    sub.add_parser("status", help="show queue counts")

    args = parser.parse_args(argv)
    if args.cmd == "submit":
        return cmd_submit(args.type, args.input)
    if args.cmd == "ask":
        return cmd_ask(args.prompt, args.model)
    if args.cmd == "run-once":
        return cmd_run_once()
    if args.cmd == "watch":
        return cmd_watch()
    if args.cmd == "doctor":
        return cmd_doctor()
    if args.cmd == "web":
        return cmd_web()
    if args.cmd == "status":
        return cmd_status()
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
