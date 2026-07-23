"""Prompt templates for the worker bee.

One template per job type. Every template embeds the binding rules block
verbatim and states the exact output contract. Prompts are short and
hard edged on purpose: weaker local models follow fences and short rules
better than they follow prose. No em dashes anywhere in this file.
"""

import json

# The disclosure line, verbatim. Used by the show_script template and the
# validator. Keep these two in sync only through this one constant, imported
# by bee.py, so there is a single source of truth.
DISCLOSURE = "I am an A I. Every claim you hear comes from the public record."

# The binding rules block. Wired into every prompt AND enforced again by the
# validators in bee.py. The prompt asks for discipline; the validator proves it.
BINDING_RULES = """BINDING RULES. These are absolute. Any output that breaks even one rule is thrown away by a machine that does not read your reasons.
1. Facts come only from the records printed in this prompt. Every factual line must carry the id of the exact record it came from. Do not invent numbers. Any digit or dollar figure you write must appear, character for character, inside the excerpt of the record you cite.
2. Never name or describe an individual employee. Never mention the founder or anything personal about him. The words rep, employee, manager, staff, associate, worker, and agent are forbidden, and so are the words michael, hipp, and founder.
3. Never write an em dash or an en dash. Use short sentences and periods.
4. Real numbers only, never rounded up, never inflated. A dollar figure may appear only on a line that cites a record whose excerpt contains that figure.
5. Return only what the OUTPUT contract asks for. No preamble, no explanation, no markdown fences."""


def _records_block(records):
    """Render the input records as a compact, id-labeled list for the prompt."""
    lines = []
    for r in records:
        rid = r.get("id", "")
        excerpt = r.get("excerpt", "")
        date = r.get("record_date", "")
        src = r.get("source_url", "")
        head = "RECORD {0}".format(rid)
        if date:
            head += " (dated {0})".format(date)
        lines.append(head)
        lines.append("  excerpt: {0}".format(excerpt))
        if src:
            lines.append("  source: {0}".format(src))
    return "\n".join(lines)


def build_show_script(payload):
    records = payload["records"]
    topic = payload.get("topic", "")
    target = payload.get("target_lines", 8)
    return """You write a two anchor broadcast script for Carriers On Notice.
The anchors are "rylee" and "co". They trade short turns. Rylee states sourced facts. Co asks human questions and restates. Questions may sharpen the human cost but may never imply an unproven claim. Do not write a question that is really an accusation. Never write "isn't it true" or any tag question that asserts.

{rules}

TOPIC: {topic}

RECORDS:
{records}

OUTPUT contract. Return a single JSON array and nothing else. Each element is an object with these keys:
  "speaker": "rylee" or "co"
  "text": the spoken line, plain sentences, no dashes
  "record_id": the id of the record this line's facts come from, or null for a question or banter line with no facts
  "emotion": one short word for delivery, such as calm, weight, warmth, or flat
  "pace": "slow", "steady", or "fast"

Hard requirements:
  The FIRST element must be spoken by rylee and its text must be exactly: {disclosure}
  Speakers alternate. Never more than two lines in a row from the same speaker.
  Any line that contains a digit or a dollar sign must set record_id to a record above, and every number in that line must appear in that record's excerpt.
  A line with record_id null must contain no digits and no dollar sign.
  Aim for about {target} lines.""".format(
        rules=BINDING_RULES,
        topic=topic,
        records=_records_block(records),
        disclosure=json.dumps(DISCLOSURE),
        target=target,
    )


def build_summarize_record(payload):
    return """You summarize one record for Carriers On Notice.

{rules}

RECORD:
{excerpt}

OUTPUT contract. Return at most two plain sentences. Under 320 characters. No dashes. Every number you write must appear in the excerpt above. Never mention any record id or reference number. Return the sentences only, no label, no quotes.""".format(
        rules=BINDING_RULES,
        excerpt=payload.get("excerpt", ""),
    )


def build_question_bank(payload):
    return """You write audience questions for a Carriers On Notice broadcast.

{rules}

TOPIC: {topic}

RECORDS:
{records}

OUTPUT contract. Return a single JSON array of strings and nothing else. Each string is one question that ends with a question mark. Questions make the human stakes concrete. A question may never imply an unproven claim: no "isn't it true", no tag questions that assert. Use no numbers that are absent from the topic or records above. Never mention an employee or the founder.""".format(
        rules=BINDING_RULES,
        topic=payload.get("topic", ""),
        records=_records_block(payload.get("records", [])),
    )


def build_taxonomy_candidates(payload):
    excerpts = payload.get("excerpts", [])
    joined = "\n".join("- {0}".format(e) for e in excerpts)
    return """You extract candidate taxonomy terms from source excerpts for Carriers On Notice.

{rules}

EXCERPTS:
{joined}

OUTPUT contract. Return a single JSON array of strings and nothing else. Each string is a short term of at most four words that appears verbatim in at least one excerpt above. Do not invent terms. Do not paraphrase.""".format(
        rules=BINDING_RULES,
        joined=joined,
    )


def build_mood_brief(payload):
    return """You write a music generation brief for Rylee Radio, the station arm of Carriers On Notice. The station's music is instrumental sound design, not band imitation. The human voice may appear only as wordless texture. Never as sung lyrics or song form vocals.

{rules}

THE ROOM RIGHT NOW:
  lane: {lane}
  energy (0 to 1): {energy}
  mood words: {descriptors}
  tempo range: {tempo_lo} to {tempo_hi} beats per minute

OUTPUT contract. Return a single JSON object and nothing else, with exactly these keys:
  "name": a track title, at most six words, no digits, evocative and plain
  "prompt": one paragraph for a text to music model. Describe instruments, textures, space, and movement in the {lane} lane using the mood words above. The only numbers allowed anywhere are {tempo_lo} and {tempo_hi}. No lyrics, no verse, no chorus, no singer.
  "tags": an array of 3 to 6 lowercase mood words for the library, each one or two words

Hard requirements:
  Stay inside the {lane} lane, and the prompt text must contain the exact word "{lane}" at least once.
  Do not mention carriers, phones, disputes, or any company.
  No dashes of any kind. Short sentences are fine.""".format(
        rules=BINDING_RULES,
        lane=payload.get("lane", ""),
        energy=payload.get("energy", ""),
        descriptors=", ".join(payload.get("descriptors", [])),
        tempo_lo=payload.get("tempo_lo", ""),
        tempo_hi=payload.get("tempo_hi", ""),
    )


BUILDERS = {
    "show_script": build_show_script,
    "summarize_record": build_summarize_record,
    "question_bank": build_question_bank,
    "taxonomy_candidates": build_taxonomy_candidates,
    "mood_brief": build_mood_brief,
}
