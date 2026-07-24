---
name: bee-operator
description: How any Claude session drives the worker bee on the Mac mini to get zero-token output from every Ollama model on Michael's Pro account, on demand. Load whenever generation work can be delegated off Anthropic tokens.
---

# Bee operator

The bee is a stdlib-only job runner at mini:~/bee (repo copy: bee/). It calls the mini's Ollama daemon (localhost:11434), which serves local models AND Michael's Ollama Pro cloud models. Generations cost zero Anthropic tokens. A launchd service (com.con.bee) keeps a watch loop draining jobs at all times.

## The one-liner (use this first)

    ssh mini 'cd ~/bee && python3 bee.py ask "PROMPT" --model gpt-oss:120b-cloud'

Synchronous: submits a draft job, waits, prints the output. Model and elapsed go to stderr. Exit 0 on success.

## Model selection doctrine

Check the live roster before choosing: `ssh mini 'cd ~/bee && python3 bee.py doctor'` (also verifies daemon health, queues, disk).
- gpt-oss:120b-cloud: reasoning, writing, scripts, anything quality-sensitive. Default for real work.
- llama3:latest (local 8B): fast cheap passes, bulk summarization, when cloud is slow or offline.
- deepseek-coder:latest (local): code sketches only.
- Cloud model names end in -cloud. New cloud models appear on the roster as Ollama ships them; prefer the largest cloud model for judgment-adjacent text.

## Structured job types (validated, for production content)

submit then run: `python3 bee.py submit <type> <input.json>` (the service processes it; results land in out/ or failed/ with reasons).
- show_script: records in, two-anchor script out. Validators enforce the citation knot: any line with digits or dollars carries a record_id whose excerpt contains those exact figures; banter carries no digits; disclosure line present; no rhetorical assertions.
- summarize_record: excerpt in, two plain sentences out, no foreign digits.
- question_bank: audience questions, all ending in ?, no employee or founder words.
- taxonomy_candidates: terms that literally appear in the input excerpts.
- draft: freeform, size-capped, dash-stripped, no content validators. For thinking work, never for publishing.
- Model rides INSIDE the input JSON as "model": "...".

## Iron rules

1. out/ is a proposal tray. A Claude reviews everything before it goes anywhere. The bee never publishes.
2. Strict validators reject rather than fix. A failed/ entry with reasons is the system working; adjust the prompt or the input, never loosen a validator to make output pass.
3. Zero-token means the GENERATION is free; your orchestration is not. Batch jobs, avoid chatty loops, use ask for single answers.
4. Binding project rules ride inside every structured prompt template (prompts.py). Do not bypass templates for structured types.
5. If the daemon is down, doctor says so; the fix is on the mini (Ollama app), not in the bee.

## Web window

`http://192.168.1.159:8899` shows recent outputs and takes submissions (Michael's window; trusted LAN only, no auth).
