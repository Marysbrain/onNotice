# The worker bee

High volume text jobs for Carriers On Notice at zero Anthropic token cost. One
prompt in, one text out, one mechanical validator after. The bee never acts. It
only writes files into a proposal tray. A human supervised orchestrator reviews
that tray and decides what, if anything, gets published.

Discipline here is enforced by code, not by trust. Every job runs through a
deterministic validator after the model speaks. A model that breaks a rule does
not get published. It gets moved to `failed/` with the reasons written down.

## What it needs

Python 3.9 or newer. Standard library only. No pip, no installs, ever. An
Ollama daemon reachable at `http://127.0.0.1:11434` serving local models
(llama3 8B and others) and, through the owner's subscription, cloud models such
as `gpt-oss:120b-cloud`.

Nothing else. No accounts, no keys in this code, no outbound network except the
one call to Ollama.

## Where it lives

Everything is under `~/bee/`:

- `jobs/` the inbox. Submitted jobs wait here.
- `working/` a job is moved here while it runs. Atomic claim, so two drains do
  not fight over one job.
- `out/` the proposal tray. Accepted output lands here. This is never a publish
  path. It is a tray a human reads.
- `failed/` rejected jobs, each with its `failure_reasons`.
- `log/` an append only run log.

Override the home with `BEE_HOME` and the Ollama endpoint with `BEE_OLLAMA_URL`.
The tests use both. In production leave them unset.

## Run order on the mini

1. Confirm Ollama is up: `curl -s http://127.0.0.1:11434/api/tags` returns JSON.
2. Submit one or more jobs. Each `submit` validates the input schema before it
   writes anything, so a malformed job never reaches the runner.
3. Drain the inbox: `python3 bee.py run-once`. It processes every waiting job,
   writes accepted output to `out/`, moves rejects to `failed/`.
4. Check the queue any time: `python3 bee.py status`.
5. A human reviews `out/`. Nothing leaves the mini on its own.

`run-once` drains once and exits. To run it on a schedule, wrap it in cron or a
launchd job on the mini. The bee itself starts no timers and opens no ports.

## The commands

```
python3 bee.py submit <type> <input.json>
python3 bee.py run-once
python3 bee.py status
```

`submit` reads a JSON object. An optional top level `"model"` key names the
model to try first. Everything else is the job payload for that type. If the
model is missing, the fallback `llama3:latest` is used. The runner always tries
the requested model first, then falls back to `llama3:latest`. Cloud models
(any model name containing `cloud`) get a 300 second timeout. Local models get
120 seconds. Each job gets at most two generation attempts before it fails.

## The job types

### show_script

A two anchor broadcast script. Input:

```json
{
  "model": "gpt-oss:120b-cloud",
  "topic": "AT&T arbitration",
  "target_lines": 8,
  "records": [
    {
      "id": "R1",
      "excerpt": "AT&T listed 2,466 arbitration cases in 2026.",
      "source_url": "https://example.org/r1",
      "record_date": "2026-07-21"
    }
  ]
}
```

Output is a JSON array of line objects: `speaker` (`rylee` or `co`), `text`,
`record_id` (a record id or null), `emotion`, `pace`.

The validator requires: the exact AI disclosure in line one, speakers that
alternate (never three in a row), every line with a digit or a dollar sign
carrying a record id whose excerpt contains those numbers, banter lines
(record id null) carrying no digits, no em or en dashes anywhere, no question
that asserts (an `isn't it true` style tag question is rejected), and a total
line count within the target plus or minus two.

### summarize_record

Input `{ "id": "R1", "excerpt": "..." }`. Output is at most two plain sentences.
The validator rejects any number absent from the excerpt, a length of 320
characters or more, more than two sentences, and any em dash.

### question_bank

Input `{ "topic": "...", "records": [ { "id": "...", "excerpt": "..." }, ... ] }`.
Output is a JSON array of audience questions. Every item must end with a
question mark, use no number absent from the input, name no employee role (rep,
employee, manager, staff, associate, worker, agent), never mention the founder
(michael, hipp, founder), and never smuggle a claim as a question.

### taxonomy_candidates

Input `{ "excerpts": [ "...", "..." ] }`. Output is a JSON array of short terms.
Every term must appear verbatim in at least one excerpt and be at most four
words.

## The binding rules, wired everywhere

These live in the prompt of every type and again in the validators. The prompt
asks. The validator proves.

1. Facts only from provided records. Every factual line carries a record id. No
   new numbers: any digit sequence in the output must appear in the input
   records or the line is rejected.
2. Never discuss individual employees or the founder's personal matters.
3. Never use em dashes anywhere, output included.
4. Show scripts must contain the disclosure line verbatim in line one:
   `I am an A I. Every claim you hear comes from the public record.`
5. Real numbers only, never inflated. A dollar figure may appear only on a line
   whose cited record contains that figure.

## The review discipline

`out/` is a proposal tray. It is not a publish path. Nothing here is live, seen,
or sent until a human reads it and moves it forward by hand. The bee's job ends
the moment a file lands in `out/`. That boundary is the whole point: a machine
can draft at volume because a person still decides.

## Tests

```
python3 tests.py
```

Standard library only. Covers every validator with accept and reject cases,
including a digit smuggled into a banter line, a dollar figure absent from the
source record, an em dash, an employee word inside a question, and an
`isn't it true` assertion. One end to end test runs `submit` then `run-once`
against a stub HTTP server that stands in for Ollama, so the full drain path is
exercised without a live daemon.
