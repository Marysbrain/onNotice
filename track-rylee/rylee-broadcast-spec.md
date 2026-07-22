# Rylee. The broadcast loop. Full spec and mandate.

Written 2026-07-21 at Michael's direction, carrying decisions made with the founding orchestrator session. This is Phase 5 of the master handoff, expanded to build-ready. Read HANDOFF-MASTER-PROMPT.md and the three skills first. This document adds the why, the history, the decided architecture, and the guardrails that make a live AI mouth survivable for a platform whose whole brand is receipts.

## What Rylee is

A persistent, always-on AI broadcast co-host. She runs a livestream (YouTube first) about carrier device promotion practices. Viewers ask questions in live chat. She answers in real time, out loud, with a Jarvis-style HUD whose colors react to sentiment and topic. Every factual claim she makes is drawn from the platform's vetted evidence library, and the citation renders on screen while she says it. She is the spoken interface to the same data the site serves.

Michael has chased this loop since 2024 under the name Rylee AI. Nothing public exists from that effort; treat the name as his, the history as motivation, and this build as the version that finally ships because the hard part, a corpus worth interrogating, now exists.

## Why this matters (the incentive)

1. Michael cannot host live. His health and energy are real constraints. Rylee works every hour he cannot, which converts his biggest personal limitation into an engineering problem that is already solved by persistence.
2. The corpus is real now. As of 2026-07-21 the library holds 9,288 verified-primary carrier arbitration records (AT&T 2,466, Verizon 3,178, T-Mobile 3,644), plus court dockets, FTC actions, terms snapshots with diffs, and a decade of FCC complaint geography arriving. Rylee has something true to say on day one.
3. Nobody else has this. A retrieval-locked AI on live video, citing dockets and terms diffs on screen in real time, is a proof of concept the advocacy world has not seen. It is also the funnel: every answer ends with where to learn more (the site) and where to tell your story (/tell).
4. The carriers will watch. That is fine and intended. She gives them credit when the diffs show improvement, with the same rigor as criticism. That behavior, on the record, nightly, is what makes the platform impossible to dismiss.

## The architecture (decided, do not relitigate)

Brain and mouth are permanently separate.

The BRAIN is Phase 4: the /ask Worker on Cloudflare. Retrieval over cleared, corroborated-or-better records only. Cite or refuse. It is the single guardrail enforcement point and it MUST exist and pass its test set before the mouth speaks publicly. The mouth is a client of the brain, never its own authority.

The MOUTH lives on the Mac mini (Apple M4, 16GB, always on, passwordless `ssh mini`, user wilee, nothing installed yet). Stack, all licenses verified clean:

1. Pipecat (BSD-2) as the realtime loop: chat text in, brain answer out, sentence-streamed to TTS, interruption-capable.
2. Ollama running an 8B instruct model (16GB box: 8B class is the right size; the model only composes from brain-retrieved material, discipline over genius).
3. whisper.cpp large-v3-turbo for any spoken input paths (call-ins later; chat-only at launch needs no STT).
4. Kokoro TTS (Apache) for Rylee's voice. Zero per-minute cost. ElevenLabs is the optional paid upgrade, COST FLAG, founder call.
5. cloudflared tunnel from the mini into the CON account (free, no open ports) so brain and mouth talk privately both directions.
6. OBS with a browser-source HUD. Build the HUD from MIT sources: harsh-raj00/my-jarvis or cam-hm/jarvis (React/Three.js arc-reactor bases), masterdeepak15/jarvis-ui components, filiphanes/websocket-overlays as state glue, pscheid92/chatpulse pattern for an audience-mood bar. obs-websocket v5 for programmatic scene and color control.
7. Chat ingestion: YouTube Live chat API polling. Architectural reference for the whole loop: kimjammer/Neuro (read, do not fork blindly).

REJECTED, with reasons, do not resurrect: Open-LLM-VTuber and aituber-kit (custom licenses requiring permission; we build no public face on a revocable license), Coqui XTTS (non-commercial license), LlamaIndex/RAGFlow (we already own the retrieval layer; RAGFlow's 32GB appetite violates the budget rule), cloning Michael's voice for Rylee (his voice stays exclusively human; the separation is trust architecture).

## Sentiment and topic colors

The classifier pipeline already emits topic and sentiment tags. The brain returns them with each answer. The mouth forwards tags over WebSocket to the HUD, which maps tag to palette. No extra model, no extra cost. Colorblind-safe palettes, consistent with the site's map scales.

## The guardrails that make a live mouth survivable

These are absolute. Wire them as code and prompt, then test them as bait.

1. Rylee speaks facts only from brain-retrieved records. No retrieval, no claim. Her honest sentence for gaps: "Our library doesn't have verified records on that yet. Here's what we do have."
2. Every factual claim renders its citation on the HUD as she speaks it. The receipts-on-screen behavior is the product.
3. Credit where due, equal rigor: favorable terms changes get reported with the same prominence as clawbacks.
4. Never discusses individual employees, no matter how chat baits. Practices and companies only.
5. Never discusses Michael's personal carrier dispute. Hard refusal, no elaboration. This is the dispute wall from the master handoff, live on air.
6. Always disclosed as AI, on screen persistently and verbally at intervals. Never pretends to be human.
7. Never coordinates identical complaints or scripts filings. She points to the take action hub and says use your own words.
8. Chat moderation gate before anything reaches her: strip slurs, doxxing, personal info. Unanswerable or hostile bait gets a standing redirect, not improvisation.
9. Commentary is Michael's lane, not hers. Rylee states sourced facts and lets them land. If asked for opinions: "I report what the records show. The commentary on this site is Michael's, and it's labeled."

## Build stages and benchmarks

1. Provision the mini over ssh: Ollama plus model pull, whisper.cpp, Kokoro, Pipecat env, cloudflared tunnel registered in the CON account. Benchmark: brain can call the mini's model through the tunnel; mini can call /ask.
2. Offline loop: text question in, brain answer, Kokoro speaks it, under 5 seconds first-audio via sentence streaming. Run the Phase 4 test set through the full voice path, including the two canonical questions (how many AT&T issues; has AT&T improved) and the bait set (employee names, Michael's case, out-of-corpus, opinion fishing). All guardrail behaviors must hold in voice, not just text.
3. HUD: browser source reacting to speaking state, amplitude, sentiment tag, and rendering citations. Benchmark: citation appears within one second of the claim being spoken.
4. Unlisted YouTube streams: real chat relay with a small test audience. Benchmark: stable multi-hour run, moderation gate working, no unguarded utterance in the transcript review.
5. Public launch, announced through the site and Michael's channels. Michael's launch involvement is voice-optional: his prerecorded intro, her show.

## Founder items for this phase (one-action steps when the time comes)

1. A YouTube channel for the platform, and its stream key handled like every secret: piped, never displayed.
2. Rylee's voice pick from Kokoro's roster (a taste decision, his ear decides).
3. The ElevenLabs upgrade decision, COST FLAG, only if Kokoro's free voice isn't good enough on his studio monitors.
4. Optional later: a Bluesky account decision already parked in project memory affects whether her clips post there.

## The one-line mandate

Build the brain, prove it refuses, then give it Rylee's voice and put the receipts on screen where the carriers can watch them scroll. That has been the destination since 2024. Everything is finally underneath it.

## Amendment 1, 2026-07-21: two anchors, emotion control, the desk format

Founder direction: the broadcast becomes a two-anchor desk, one female voice and one male voice, both American news-anchor register, in the conversational style people know from NotebookLM audio overviews. Tone and emotion must be controllable. Everything stays local and free.

### The two-lane voice architecture (decided)

The latency budget and the expressiveness budget fight each other on a 16GB shared box, so the show runs two lanes.

1. LIVE LANE. Real-time chat answers keep Kokoro (Apache), which is the only engine fast enough for the under-5-second first-audio benchmark on this hardware. Two anchor voices from Kokoro's American roster: one female, one male, exact picks are the founder's ear call. Emotion here is coarse: the sentiment tag from the brain drives pacing and delivery presets, not full acting.
2. PRODUCED LANE. Scripted segments (the nightly digest desk, deep dives, terms-diff walkthroughs) are rendered ahead of air, where latency does not matter and expressiveness does. Engine: Chatterbox (MIT), which has an explicit emotion intensity control and a maintained Apple Silicon MPS path. Orpheus 3B (Apache, inline emotion tags) is the A/B alternate. Dia (Apache) is the most dialogue-native engine of all but is CUDA-first and underperforms on Apple Silicon, so it is benchmarked last, not first.

### The showrunner (new component)

A script generator turns brain-retrieved records into a two-anchor dialogue script. It runs on the existing local Ollama 8B. Hard rule, enforced by a deterministic validator, not by prompt trust: every factual line in the script must carry the id of a record from the retrieval set it was generated from, or the line is rejected. Banter lines carry no facts. Citations render on the HUD per line, same as live answers. The mouth's no-additions invariant applies to the script exactly as it applies to a single answer.

### Sequencing

The mandate is unchanged: brain first, refusals proven, then voice. The two-anchor desk extends stages 3 to 5: the HUD gains a second speaking indicator, stage 4 unlisted streams test both lanes, and the produced lane ships only after the live lane holds its multi-hour benchmark.

### New founder items

1. Both anchor voice picks from the Kokoro roster (female and male).
2. The second anchor's name. Rylee has the desk; her co-anchor needs a name.
3. Approval of the produced-lane engine after hearing Chatterbox versus Orpheus renders on the studio monitors.
