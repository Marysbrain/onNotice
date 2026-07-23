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
        s[3]["text"] = "What does that mean — really — for a family?"
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
        ok, reasons = bee.validate_summarize_record(self.payload, "AT&T listed cases — many of them.")
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

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        payload = json.dumps({"response": StubHandler.canned, "done": True}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
