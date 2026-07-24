#!/usr/bin/env python3
"""Tests for the worker bee. Standard library only. Run: python3 tests.py

Covers every validator with accept and reject cases, including the sneaky
ones (a digit smuggled into banter, a dollar figure not in the source record,
an em dash, an employee word inside a question, an isn't it true assertion),
plus an end to end run-once against a stub HTTP server that stands in for
Ollama.
"""

import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib import request as urlrequest

import bee


DISC = bee.prompts.DISCLOSURE


def show_records():
    return [
        {
            "id": "R1",
            "excerpt": "AT&T listed 2,466 arbitration cases in 2026.",
            "source_url": "https://example.org/r1",
            "record_date": "2026-07-21",
        }
    ]


def good_script():
    return [
        {"speaker": "rylee", "text": DISC, "record_id": None, "emotion": "calm", "pace": "steady"},
        {"speaker": "co", "text": "So what are we looking at tonight?", "record_id": None, "emotion": "curious", "pace": "steady"},
        {"speaker": "rylee", "text": "AT&T listed 2,466 arbitration cases in 2026.", "record_id": "R1", "emotion": "flat", "pace": "slow"},
        {"speaker": "co", "text": "What does that mean for one family?", "record_id": None, "emotion": "warm", "pace": "steady"},
        {"speaker": "rylee", "text": "It means the count is public and it is real.", "record_id": None, "emotion": "steady", "pace": "steady"},
        {"speaker": "co", "text": "Where can people learn more?", "record_id": None, "emotion": "warm", "pace": "steady"},
    ]


class ShowScriptTests(unittest.TestCase):
    def setUp(self):
        self.payload = {"records": show_records(), "topic": "AT&T arbitration", "target_lines": 6}

    def test_accepts_clean_script(self):
        ok, reasons = bee.validate_show_script(self.payload, good_script())
        self.assertTrue(ok, reasons)

    def test_rejects_missing_disclosure(self):
        s = good_script()
        s[0]["text"] = "Welcome to the show."
        ok, reasons = bee.validate_show_script(self.payload, s)
        self.assertFalse(ok)
        self.assertTrue(any("disclosure" in r for r in reasons))

    def test_rejects_digit_smuggled_into_banter(self):
        s = good_script()
        s[4]["text"] = "It means the count of 999 is real."  # record_id null, has digit
        ok, reasons = bee.validate_show_script(self.payload, s)
        self.assertFalse(ok)
        self.assertTrue(any("no record_id" in r for r in reasons))

    def test_rejects_dollar_figure_not_in_record(self):
        s = good_script()
        s[2]["text"] = "AT&T owed customers $5,000 in 2026."  # 5,000 not in excerpt
        ok, reasons = bee.validate_show_script(self.payload, s)
        self.assertFalse(ok)
        self.assertTrue(any("not in record" in r for r in reasons))

    def test_rejects_em_dash(self):
        s = good_script()
        em = chr(0x2014)
        s[3]["text"] = "What does that mean " + em + " really " + em + " for a family?"
        ok, reasons = bee.validate_show_script(self.payload, s)
        self.assertFalse(ok)
        self.assertTrue(any("em or en dash" in r for r in reasons))

    def test_rejects_en_dash(self):
        s = good_script()
        s[3]["text"] = "A three – year contract, is that fair?"
        ok, reasons = bee.validate_show_script(self.payload, s)
        self.assertFalse(ok)

    def test_rejects_rhetorical_question(self):
        s = good_script()
        s[3]["text"] = "Isn't it true they planned this?"
        ok, reasons = bee.validate_show_script(self.payload, s)
        self.assertFalse(ok)
        self.assertTrue(any("asserts" in r for r in reasons))

    def test_rejects_unknown_record_id(self):
        s = good_script()
        s[2]["record_id"] = "R9"
        ok, reasons = bee.validate_show_script(self.payload, s)
        self.assertFalse(ok)
        self.assertTrue(any("unknown record_id" in r for r in reasons))

    def test_rejects_three_in_a_row(self):
        s = good_script()
        s[1]["speaker"] = "rylee"
        s[2]["speaker"] = "rylee"  # lines 1,2,3 all rylee
        ok, reasons = bee.validate_show_script(self.payload, s)
        self.assertFalse(ok)
        self.assertTrue(any("alternate" in r for r in reasons))

    def test_rejects_line_count_out_of_band(self):
        s = good_script() + good_script()  # 12 lines, target 6
        ok, reasons = bee.validate_show_script(self.payload, s)
        self.assertFalse(ok)
        self.assertTrue(any("line count" in r for r in reasons))

    def test_accepts_number_present_in_cited_record(self):
        s = good_script()
        s[2]["text"] = "The 2026 file names 2,466 cases."
        ok, reasons = bee.validate_show_script(self.payload, s)
        self.assertTrue(ok, reasons)


class SummarizeTests(unittest.TestCase):
    def setUp(self):
        self.payload = {"id": "R1", "excerpt": "AT&T listed 2,466 arbitration cases in 2026."}

    def test_accepts_clean_summary(self):
        ok, reasons = bee.validate_summarize_record(self.payload, "AT&T listed 2,466 arbitration cases. The file is dated 2026.")
        self.assertTrue(ok, reasons)

    def test_rejects_foreign_number(self):
        ok, reasons = bee.validate_summarize_record(self.payload, "AT&T faced 9,999 cases in 2026.")
        self.assertFalse(ok)
        self.assertTrue(any("not in the excerpt" in r for r in reasons))

    def test_rejects_em_dash(self):
        ok, reasons = bee.validate_summarize_record(self.payload, "AT&T listed cases " + chr(0x2014) + " many of them.")
        self.assertFalse(ok)

    def test_rejects_too_long(self):
        long = "AT&T listed cases. " * 20
        ok, reasons = bee.validate_summarize_record(self.payload, long)
        self.assertFalse(ok)

    def test_rejects_more_than_two_sentences(self):
        ok, reasons = bee.validate_summarize_record(self.payload, "One thing. Two thing. Three thing.")
        self.assertFalse(ok)
        self.assertTrue(any("2 sentences" in r for r in reasons))


class QuestionBankTests(unittest.TestCase):
    def setUp(self):
        self.payload = {
            "topic": "device financing",
            "records": [{"id": "R1", "excerpt": "A 36 month credit was forfeited at month 35."}],
        }

    def test_accepts_clean_questions(self):
        q = ["What does a lost credit mean for a family?", "What changes at month 35 of 36?"]
        ok, reasons = bee.validate_question_bank(self.payload, q)
        self.assertTrue(ok, reasons)

    def test_rejects_missing_question_mark(self):
        ok, reasons = bee.validate_question_bank(self.payload, ["This is a statement."])
        self.assertFalse(ok)
        self.assertTrue(any("question mark" in r for r in reasons))

    def test_rejects_employee_word(self):
        ok, reasons = bee.validate_question_bank(self.payload, ["Did the manager know the credit would vanish?"])
        self.assertFalse(ok)
        self.assertTrue(any("employee" in r for r in reasons))

    def test_rejects_founder_word(self):
        ok, reasons = bee.validate_question_bank(self.payload, ["What does Michael think about this?"])
        self.assertFalse(ok)
        self.assertTrue(any("founder" in r for r in reasons))

    def test_rejects_foreign_number(self):
        ok, reasons = bee.validate_question_bank(self.payload, ["Why did 500 people lose credits?"])
        self.assertFalse(ok)
        self.assertTrue(any("not in the input" in r for r in reasons))

    def test_rejects_rhetorical_assertion(self):
        ok, reasons = bee.validate_question_bank(self.payload, ["Isn't it true they planned this?"])
        self.assertFalse(ok)
        self.assertTrue(any("asserts" in r for r in reasons))

    def test_word_boundary_does_not_falsely_flag(self):
        # "representative" would contain rep, but rep is bounded; "agenda" contains agent? no.
        ok, reasons = bee.validate_question_bank(self.payload, ["What is on the agenda for families?"])
        self.assertTrue(ok, reasons)


class TaxonomyTests(unittest.TestCase):
    def setUp(self):
        self.payload = {"excerpts": ["Conditional bill credit spread over thirty six months.", "Early upgrade forfeits the remaining credit."]}

    def test_accepts_verbatim_terms(self):
        ok, reasons = bee.validate_taxonomy_candidates(self.payload, ["conditional bill credit", "early upgrade"])
        self.assertTrue(ok, reasons)

    def test_rejects_invented_term(self):
        ok, reasons = bee.validate_taxonomy_candidates(self.payload, ["hidden penalty fee"])
        self.assertFalse(ok)
        self.assertTrue(any("does not appear" in r for r in reasons))

    def test_rejects_too_many_words(self):
        ok, reasons = bee.validate_taxonomy_candidates(self.payload, ["conditional bill credit spread over"])
        self.assertFalse(ok)
        self.assertTrue(any("four words" in r for r in reasons))


# ---------------------------------------------------------------------------
# End to end: submit a show_script job, run-once against a stub Ollama server,
# assert an accepted output lands in out/.
# ---------------------------------------------------------------------------


class StubHandler(BaseHTTPRequestHandler):
    canned = ""
    tags = [{"name": "gpt-oss:120b-cloud"}, {"name": "llama3:latest"}]

    def _write(self, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        self._write({"response": StubHandler.canned, "done": True})

    def do_GET(self):
        if self.path.startswith("/api/tags"):
            self._write({"models": StubHandler.tags})
        else:
            self._write({"ok": True})

    def log_message(self, *args):
        pass


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="beehome-")
        os.environ["BEE_HOME"] = self.tmp
        # Wrap the JSON in prose to exercise the tolerant extractor.
        StubHandler.canned = "Here is the script:\n" + json.dumps(good_script()) + "\nThat is all."
        self.server = HTTPServer(("127.0.0.1", 0), StubHandler)
        port = self.server.server_address[1]
        os.environ["BEE_OLLAMA_URL"] = "http://127.0.0.1:{0}".format(port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        os.environ.pop("BEE_HOME", None)
        os.environ.pop("BEE_OLLAMA_URL", None)

    def test_submit_then_run_once_accepts(self):
        job_input = {
            "model": "llama3:latest",
            "records": show_records(),
            "topic": "AT&T arbitration",
            "target_lines": 6,
        }
        inp = os.path.join(self.tmp, "input.json")
        with open(inp, "w", encoding="utf-8") as fh:
            json.dump(job_input, fh)

        rc = bee.cmd_submit("show_script", inp)
        self.assertEqual(rc, 0)
        self.assertEqual(len(list(bee.bee_dir("jobs").glob("*.json"))), 1)

        rc = bee.cmd_run_once()
        self.assertEqual(rc, 0)
        outs = list(bee.bee_dir("out").glob("*.json"))
        self.assertEqual(len(outs), 1, "expected one accepted output")
        with open(outs[0], "r", encoding="utf-8") as fh:
            result = json.load(fh)
        self.assertEqual(result["validation"], "pass")
        self.assertEqual(result["model_used"], "llama3:latest")
        self.assertEqual(len(result["output"]), 6)
        self.assertEqual(len(list(bee.bee_dir("failed").glob("*.json"))), 0)

    def test_run_once_fails_bad_output(self):
        # Server returns a script missing the disclosure line. Two attempts,
        # then the job lands in failed/.
        bad = good_script()
        bad[0]["text"] = "Welcome, no disclosure here."
        StubHandler.canned = json.dumps(bad)
        job_input = {"model": "llama3:latest", "records": show_records(), "topic": "x", "target_lines": 6}
        inp = os.path.join(self.tmp, "bad.json")
        with open(inp, "w", encoding="utf-8") as fh:
            json.dump(job_input, fh)
        bee.cmd_submit("show_script", inp)
        bee.cmd_run_once()
        self.assertEqual(len(list(bee.bee_dir("out").glob("*.json"))), 0)
        failed = list(bee.bee_dir("failed").glob("*.json"))
        self.assertEqual(len(failed), 1)
        with open(failed[0], "r", encoding="utf-8") as fh:
            job = json.load(fh)
        self.assertIn("failure_reasons", job)


class MoodBriefTests(unittest.TestCase):
    def payload(self):
        return {
            "lane": "textural",
            "lanes": ["textural", "cinematic", "electronic", "minimal", "maximal"],
            "energy": 0.4,
            "valence": 0.55,
            "tempo_lo": 82,
            "tempo_hi": 98,
            "descriptors": ["warm", "patient", "open"],
            "window_start": "2026-07-23T20:00:00Z",
            "window_end": "2026-07-23T20:10:00Z",
            "sample_n": 25,
            "insufficient": False,
        }

    def good(self):
        return {
            "name": "Rain On A Tin Roof",
            "prompt": "A textural piece for a warm and patient room. Soft felt piano over slow tape hiss. Space stays open and the movement drifts between 82 and 98 beats per minute.",
            "tags": ["warm", "patient", "open"],
        }

    def test_accepts_clean_brief(self):
        ok, reasons = bee.validate_mood_brief(self.payload(), self.good())
        self.assertTrue(ok, reasons)

    def test_rejects_foreign_tempo(self):
        out = self.good()
        out["prompt"] = out["prompt"].replace("82", "120")
        ok, reasons = bee.validate_mood_brief(self.payload(), out)
        self.assertFalse(ok)
        self.assertTrue(any("numbers" in r for r in reasons))

    def test_rejects_song_form_vocals(self):
        out = self.good()
        out["prompt"] += " A verse and chorus carry the melody."
        ok, reasons = bee.validate_mood_brief(self.payload(), out)
        self.assertFalse(ok)
        self.assertTrue(any("vocal" in r for r in reasons))

    def test_allows_voice_as_texture(self):
        out = self.good()
        out["prompt"] += " A wordless choir hums underneath."
        ok, reasons = bee.validate_mood_brief(self.payload(), out)
        self.assertTrue(ok, reasons)

    def test_rejects_unknown_key(self):
        out = self.good()
        out["viewer_handle"] = "someone"
        ok, reasons = bee.validate_mood_brief(self.payload(), out)
        self.assertFalse(ok)
        self.assertTrue(any("unknown" in r for r in reasons))

    def test_rejects_missing_key(self):
        out = self.good()
        del out["tags"]
        ok, _ = bee.validate_mood_brief(self.payload(), out)
        self.assertFalse(ok)

    def test_rejects_missing_lane_word(self):
        out = self.good()
        out["prompt"] = "Soft felt piano between 82 and 98 beats per minute."
        ok, reasons = bee.validate_mood_brief(self.payload(), out)
        self.assertFalse(ok)
        self.assertTrue(any("lane" in r for r in reasons))

    def test_rejects_digit_in_name(self):
        out = self.good()
        out["name"] = "Track 82"
        ok, reasons = bee.validate_mood_brief(self.payload(), out)
        self.assertFalse(ok)

    def test_rejects_uppercase_tag(self):
        out = self.good()
        out["tags"] = ["Warm", "patient", "open"]
        ok, reasons = bee.validate_mood_brief(self.payload(), out)
        self.assertFalse(ok)

    def test_rejects_em_dash(self):
        out = self.good()
        out["prompt"] += " tape " + chr(0x2014) + " hiss"
        ok, reasons = bee.validate_mood_brief(self.payload(), out)
        self.assertFalse(ok)

    def test_input_validator_rejects_lane_outside_lanes(self):
        p = self.payload()
        p["lane"] = "vocal pop"
        errs = bee.validate_input_mood_brief(p)
        self.assertTrue(errs)

    def test_input_validator_accepts_engine_payload(self):
        errs = bee.validate_input_mood_brief(self.payload())
        self.assertEqual(errs, [])


# ---------------------------------------------------------------------------
# A stub Ollama plus a temp BEE_HOME, shared by the new feature tests.
# ---------------------------------------------------------------------------


class StubServerMixin:
    def start_stub(self):
        self.tmp = tempfile.mkdtemp(prefix="beehome-")
        os.environ["BEE_HOME"] = self.tmp
        self.server = HTTPServer(("127.0.0.1", 0), StubHandler)
        port = self.server.server_address[1]
        os.environ["BEE_OLLAMA_URL"] = "http://127.0.0.1:{0}".format(port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop_stub(self):
        self.server.shutdown()
        self.server.server_close()
        os.environ.pop("BEE_HOME", None)
        os.environ.pop("BEE_OLLAMA_URL", None)


class DraftValidatorTests(unittest.TestCase):
    def test_parse_strips_em_dash(self):
        em = chr(0x2014)
        shaped, err = bee.parse_draft("one " + em + " two " + em + " three")
        self.assertIsNone(err)
        self.assertFalse(bee.has_em_dash(shaped))
        self.assertIn("one", shaped)
        self.assertIn("three", shaped)

    def test_parse_caps_size(self):
        shaped, _ = bee.parse_draft("x" * (bee.DRAFT_MAX_CHARS + 500))
        self.assertEqual(len(shaped), bee.DRAFT_MAX_CHARS)

    def test_validate_rejects_empty(self):
        ok, reasons = bee.validate_draft({}, "   ")
        self.assertFalse(ok)

    def test_validate_accepts_plain_text(self):
        ok, reasons = bee.validate_draft({}, "a private thought, written down.")
        self.assertTrue(ok, reasons)

    def test_input_validator_requires_prompt(self):
        self.assertTrue(bee.validate_input_draft({}))
        self.assertEqual(bee.validate_input_draft({"prompt": "think out loud"}), [])


class DraftEndToEndTests(StubServerMixin, unittest.TestCase):
    def setUp(self):
        self.start_stub()

    def tearDown(self):
        self.stop_stub()

    def test_draft_echoes_model_and_strips_dashes(self):
        em = chr(0x2014)
        StubHandler.canned = "A first line " + em + " and more thinking."
        job_input = {"model": "gpt-oss:120b-cloud", "prompt": "help me think"}
        inp = os.path.join(self.tmp, "draft.json")
        with open(inp, "w", encoding="utf-8") as fh:
            json.dump(job_input, fh)

        self.assertEqual(bee.cmd_submit("draft", inp), 0)
        bee.cmd_run_once()

        outs = list(bee.bee_dir("out").glob("*.json"))
        self.assertEqual(len(outs), 1)
        with open(outs[0], "r", encoding="utf-8") as fh:
            result = json.load(fh)
        self.assertEqual(result["model_used"], "gpt-oss:120b-cloud")
        self.assertIn("elapsed", result)
        self.assertFalse(bee.has_em_dash(result["output"]))
        self.assertIn("first line", result["output"])

    def test_draft_size_cap_enforced_end_to_end(self):
        StubHandler.canned = "y" * (bee.DRAFT_MAX_CHARS + 1000)
        job_input = {"prompt": "long one"}
        inp = os.path.join(self.tmp, "long.json")
        with open(inp, "w", encoding="utf-8") as fh:
            json.dump(job_input, fh)
        bee.cmd_submit("draft", inp)
        bee.cmd_run_once()
        outs = list(bee.bee_dir("out").glob("*.json"))
        self.assertEqual(len(outs), 1)
        with open(outs[0], "r", encoding="utf-8") as fh:
            result = json.load(fh)
        self.assertLessEqual(len(result["output"]), bee.DRAFT_MAX_CHARS)


class WatchIterationTests(StubServerMixin, unittest.TestCase):
    def setUp(self):
        self.start_stub()

    def tearDown(self):
        self.stop_stub()

    def _submit_draft(self):
        inp = os.path.join(self.tmp, "w.json")
        with open(inp, "w", encoding="utf-8") as fh:
            json.dump({"prompt": "one small thought"}, fh)
        bee.cmd_submit("draft", inp)

    def test_single_iteration_accepts(self):
        StubHandler.canned = "a clean draft with no banned marks."
        self._submit_draft()
        counts = bee.run_once_iteration()
        self.assertEqual(counts["processed"], 1)
        self.assertEqual(counts["accepted"], 1)
        self.assertEqual(len(list(bee.bee_dir("out").glob("*.json"))), 1)

    def test_iteration_survives_a_crashing_job(self):
        # Force the processor to blow up. The iteration must not raise; the job
        # must land in failed/ with the traceback, and the loop stays alive.
        StubHandler.canned = "whatever"
        self._submit_draft()
        original = bee._process_job

        def boom(job):
            raise RuntimeError("simulated processing crash")

        bee._process_job = boom
        try:
            counts = bee.run_once_iteration()  # must not raise
        finally:
            bee._process_job = original

        self.assertEqual(counts["crashed"], 1)
        self.assertEqual(len(list(bee.bee_dir("out").glob("*.json"))), 0)
        failed = list(bee.bee_dir("failed").glob("*.json"))
        self.assertEqual(len(failed), 1)
        with open(failed[0], "r", encoding="utf-8") as fh:
            job = json.load(fh)
        joined = " ".join(job.get("failure_reasons", []))
        self.assertIn("crash", joined.lower())
        self.assertEqual(len(list(bee.bee_dir("working").glob("*.json"))), 0)


class DoctorTests(StubServerMixin, unittest.TestCase):
    def setUp(self):
        self.start_stub()

    def tearDown(self):
        self.stop_stub()

    def test_doctor_passes_when_ollama_up(self):
        StubHandler.tags = [{"name": "gpt-oss:120b-cloud"}, {"name": "llama3:latest"}]
        self.assertEqual(bee.cmd_doctor(), 0)

    def test_model_names_lists_cloud_first(self):
        StubHandler.tags = [{"name": "llama3:latest"}, {"name": "gpt-oss:120b-cloud"}]
        names = bee.model_names()
        self.assertEqual(names[0], "gpt-oss:120b-cloud")

    def test_doctor_fails_when_ollama_down(self):
        # Point at a closed port so the tags call cannot connect.
        os.environ["BEE_OLLAMA_URL"] = "http://127.0.0.1:1"
        self.assertNotEqual(bee.cmd_doctor(), 0)


class WebSmokeTests(StubServerMixin, unittest.TestCase):
    def setUp(self):
        self.start_stub()
        self.web = bee.make_web_server("127.0.0.1", 0)
        self.web_port = self.web.server_address[1]
        self.web_thread = threading.Thread(target=self.web.serve_forever, daemon=True)
        self.web_thread.start()

    def tearDown(self):
        self.web.shutdown()
        self.web.server_close()
        self.stop_stub()

    def _post(self, path, obj):
        data = json.dumps(obj).encode("utf-8")
        url = "http://127.0.0.1:{0}{1}".format(self.web_port, path)
        req = urlrequest.Request(url, data=data, headers={"Content-Type": "application/json"})
        with urlrequest.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _get(self, path):
        url = "http://127.0.0.1:{0}{1}".format(self.web_port, path)
        with urlrequest.urlopen(url, timeout=5) as resp:
            return resp.read().decode("utf-8")

    def test_page_serves(self):
        html = self._get("/")
        self.assertIn("The bee", html)
        self.assertIn("<textarea", html)

    def test_post_draft_creates_job_file(self):
        before = len(list(bee.bee_dir("jobs").glob("*.json")))
        result = self._post("/api/submit", {"type": "draft", "model": "llama3:latest", "prompt": "a spoken thought"})
        self.assertTrue(result["ok"], result)
        self.assertIsNotNone(result["job_id"])
        after = len(list(bee.bee_dir("jobs").glob("*.json")))
        self.assertEqual(after, before + 1)

    def test_post_bad_structured_json_is_reported(self):
        result = self._post("/api/submit", {"type": "summarize_record", "prompt": "not json"})
        self.assertFalse(result["ok"])
        self.assertTrue(any("JSON" in e for e in result["errors"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
