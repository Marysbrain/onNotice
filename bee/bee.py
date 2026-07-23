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
import uuid
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

SUBDIRS = ("jobs", "working", "out", "failed", "log")


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
EM_DASHES = "—―‒"
# En dash. Banned additionally inside show scripts.
EN_DASH = "–"

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


def validate_input_taxonomy_candidates(payload):
    errs = []
    ex = payload.get("excerpts")
    if not isinstance(ex, list) or not ex:
        errs.append("excerpts must be a non-empty list")
    elif not all(isinstance(e, str) and e.strip() for e in ex):
        errs.append("every excerpt must be a non-empty string")
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


# ---------------------------------------------------------------------------
# Commands.
# ---------------------------------------------------------------------------


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

    model = raw.get("model", FALLBACK_MODEL)
    payload = {k: v for k, v in raw.items() if k != "model"}

    errs = TYPES[job_type]["input"](payload)
    if errs:
        print("input schema invalid:", file=sys.stderr)
        for e in errs:
            print("  - {0}".format(e), file=sys.stderr)
        return 1

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
                "output": parsed,
                "validation": "pass",
            }
            return True, out, []
        reasons.append("attempt {0}: {1}".format(attempt, "; ".join(verrs)))

    return False, None, reasons


def cmd_run_once():
    ensure_dirs()
    jobs = sorted(bee_dir("jobs").glob("*.json"))
    if not jobs:
        print("no jobs to run")
        return 0
    processed = 0
    for job_path in jobs:
        name = job_path.name
        working_path = assert_under_bee(bee_dir("working") / name)
        try:
            os.rename(job_path, working_path)  # atomic claim
        except OSError:
            continue  # another drain took it
        try:
            with open(working_path, "r", encoding="utf-8") as fh:
                job = json.load(fh)
        except Exception as e:
            fail = assert_under_bee(bee_dir("failed") / name)
            os.rename(working_path, fail)
            log("job {0} unreadable: {1}".format(name, e))
            continue

        job_id = job.get("id", name)
        if job.get("type") not in TYPES:
            job["failure_reasons"] = ["unknown job type"]
            _write_failed(job_id, job)
            os.remove(working_path)
            continue

        ok, out, reasons = _process_job(job)
        if ok:
            dest = assert_under_bee(bee_dir("out") / (job_id + ".json"))
            with open(dest, "w", encoding="utf-8") as fh:
                json.dump(out, fh, indent=2)
            os.remove(working_path)
            log("accepted {0} model={1}".format(job_id, out["model_used"]))
            print("accepted {0}".format(job_id))
        else:
            job["failure_reasons"] = reasons
            _write_failed(job_id, job)
            os.remove(working_path)
            log("failed {0}: {1}".format(job_id, " | ".join(reasons)))
            print("failed {0}".format(job_id))
        processed += 1
    print("processed {0} job(s)".format(processed))
    return 0


def _write_failed(job_id, job):
    dest = assert_under_bee(bee_dir("failed") / (job_id + ".json"))
    with open(dest, "w", encoding="utf-8") as fh:
        json.dump(job, fh, indent=2)


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


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    parser = argparse.ArgumentParser(description="Carriers On Notice worker bee")
    sub = parser.add_subparsers(dest="cmd")

    p_submit = sub.add_parser("submit", help="validate an input and queue a job")
    p_submit.add_argument("type")
    p_submit.add_argument("input")

    sub.add_parser("run-once", help="drain the jobs inbox once")
    sub.add_parser("status", help="show queue counts")

    args = parser.parse_args(argv)
    if args.cmd == "submit":
        return cmd_submit(args.type, args.input)
    if args.cmd == "run-once":
        return cmd_run_once()
    if args.cmd == "status":
        return cmd_status()
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
