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

## Amendment 2, 2026-07-21: the control plane and the sources of intelligence

Founder direction, same evening: leverage Cloudflare Workers as the controller of the produced lane, leverage the existing Ollama subscription, and leverage what Apple ships on the mini. Decided as one design.

### The show control plane lives on Cloudflare

Writing the show is a text problem; performing it is an audio problem. Workers own the text side. A nightly cron assembles new records into a digest, the showrunner drafts the two-anchor script, and the per-line citation validator runs server-side next to the corpus, where no mouth-side bug can route around it. A small /show API tracks each segment through drafted, validated, rendered, published. Scripts wait in D1, finished audio lands in R2, and the mini polls for validated scripts and renders when it has cycles. A stalled or busy mini stalls nothing but rendering. Standing bonus once segments exist in R2: an RSS feed off the site worker makes the produced lane a podcast at zero cost.

### The intelligence hierarchy (each layer has one job and a fallback below it)

1. Truth layer: the deterministic /ask brain on Cloudflare. No model of any size ever touches facts. This is permanent.
2. Reflex layer: Apple's on-device foundation model (macOS 26 Foundation Models framework, about 3B) for the chat moderation gate and cheap tagging. Instant, private, free, and it does not compete with the big models for memory. Requires the Apple Intelligence toggle in the mini's System Settings, a one-time founder click.
3. Conversation layer: the local Ollama 8B for Rylee's live phrasing.
4. Craft layer: the founder's Ollama cloud subscription (already paid, twenty dollars monthly) for showrunner scripts and hard classifier cases. Standing rule: the subscription is an upgrade layer, never a dependency. Every use gets a fallback chain, hosted first, Workers AI second, local 8B last, so cancellation degrades polish, never existence.
5. Utility layer: Workers AI server-side for classification, as today.

### Apple-specific adoptions

MLX (mlx-audio) is benchmarked against the ONNX Kokoro path in stage 2 and the faster one wins. whisper.cpp gets its Core ML encoder when call-ins arrive. Apple's built-in voices are never used on air: licensing and brand both say no.

### New founder items from this amendment

1. Flip Apple Intelligence on in the mini's System Settings when the moderation gate is built.
2. Approve piping the Ollama cloud API key into a Worker secret when the showrunner is built (machine-side, never displayed).

## Amendment 3, 2026-07-22: the show format doctrine

Founder direction: the output must be engaging, storytelling-first, conversational between the two anchors, and unflinchingly customer-advocate. Brutally honest about the good, the bad, and the ugly. This amendment is the showrunner's constitution.

### The doctrine

1. The two voices split the two jobs of journalism. The story anchor carries what happened to the customer: the promise, the change, the cost. The receipts anchor carries the record: case numbers, dates, fine print read verbatim. Their conversation is questions and restatements, which carry no factual claims and need no citations.
2. Segment structure: cold open on one real case told as narrative (arbitration records carry no customer names, so privacy is structural). Then the pattern number that makes it more than an anecdote. Then the fine-print reading, the actual before and after from the terms diffs, delivered flat and slow. Then what the viewer can do, pointing at the take action hub and /tell.
3. Punch comes from factual restatement, never verdicts. Not "that's outrageous." Instead "that's three years of your bill, and month thirty-five counts for nothing." If a line characterizes motive or renders a moral verdict, it does not belong to an anchor.
4. The good and the ugly run on the same machinery. A favorable terms change gets a cold open, the same prominence, the same receipts. This is what makes the critical segments impossible to dismiss.
5. Michael's read: a labeled commentary segment in Michael's own prerecorded voice, introduced on air as his commentary. The anchors state what the records show; Michael says what it adds up to. The facts and commentary split performed as a format. Rylee introduces it and never extends it.
6. Emotion controls set delivery, not content: weight and gravity for harm, warmth for good news, flatness for fine print. Tone is the show's; facts are the library's; verdicts are Michael's, labeled.

### Enforcement, unchanged and non-negotiable

Every factual line in a script carries the id of a record from its retrieval set or the validator rejects the line. Banter and reaction lines carry no facts. Citations render on the HUD as their lines are spoken. The no-additions invariant applies to scripts exactly as to live answers.

## Amendment 4, 2026-07-22: questions, the human story, and the founder's read corrected

Founder direction: the questions must be compelling, the human consequences must be the story, the growing financial impact on ordinary Americans must be conveyed, and the founder's commentary is machine-delivered because he uses systems to maximize the project's effectiveness.

### The question doctrine

Questions are the show's engine. The co-anchor's questions make stakes concrete and human: what a forfeited credit means in month twenty two of thirty six, what changes for a family when a promotion's fine print moves after signup. Questions may humanize, probe, and sharpen consequences. A question may never smuggle an unverified claim by implication. "What does this cost a family?" is allowed. "Isn't it true they planned this?" is an assertion in costume and is banned. The validator treats implication-carrying questions as factual lines: record id or rejection.

### The human story pipeline

Consented, scrubbed, human-reviewed stories from /tell are the cold-open material. The pattern comes from the files; the person comes from their own words, with consent and review as already specified. The show credits the storyteller only as they consented to be credited, defaulting to nothing.

### The financial impact, sourced

The AAA file carries per-case claim, award, and fee columns that the platform does not yet aggregate. Build item: capture and aggregate the dollar columns so the show can state total consumer claim dollars against the named carriers from the arbitration system's own public file. No unsourced statistics ever enter a script; population-share figures and similar framing stay out until a registry-cleared source backs them.

### The founder's read, corrected

Replaces amendment 3 item 5. The founder's commentary is written or approved by Michael and delivered by a dedicated third voice, distinct from both anchors and never a clone of Michael's voice. It is introduced on air as the founder's written commentary read aloud. His own voice is not required for any recurring segment. The voice-cloning ban and the facts-commentary split stand unchanged.

## Amendment 5, 2026-07-23: Rylee Radio, the station wrapper

Founder direction: the broadcast becomes a live-streamed music radio station in the GTA format-clock tradition. Music, DJ personality, variety segments, and commercial pods, with the receipts content carried as spots and breaks. This wraps the existing organs; it replaces none of them.

### The doctrine

1. The format clock is the product. A fixed repeating hour decides when content types run. Sentiment and chat decide only which item plays and what the DJ says.
2. Two speeds. The slow loop is precomputed inventory rendered by the produced lane: music rotation, station IDs, evergreen patter, variety episodes, commercial pods. The fast loop is the only realtime path: short chat-reactive DJ inserts through the live lane, hard-deadlined, with evergreen filling any missed window. Dead air is structurally impossible.
3. The ads are real. No fake commercials, ever. Spots are produced counterweights to carrier advertising, built from the decoder and the claims data, every claim cited on screen, favorable changes getting spots with equal rigor. Non-carrier spots are real content too or they do not run.
4. Chat on air passes the moderation gate first, names read only as platform display names, never anything resembling personal information.
5. All standing rules apply unchanged: brain-only facts, cite or refuse, disclosure, the walls, no em dashes.

### The gate before build

Music rights are the load-bearing decision: the library must be broadcastable and monetizable on YouTube without Content ID exposure. Options table (open-licensed catalogs versus paid AI generation with commercial terms versus license-vetted local generation) goes to the founder before any track enters inventory. COST FLAG on all paid paths.

### New build items when the gate clears

Clock scheduler (deterministic, walks the hour, respects rotation rules, always holds the next fifteen minutes), playout chain (single audio pipeline with crossfades into the stream, static visual plus now-playing readout for v1), chat ingest with the moderation gate, and inventory tooling on the bee. The desk show becomes the news desk segment inside the clock.

### Hard prerequisite

Wired network for the mini. A 24/7 upstream stream cannot ride a -82 dBm radio link.

## Amendment 6, 2026-07-23: the living library, crowd-born music

Founder direction: every new track is generated by leading AI music tools from listener sentiment, and the audience must know they are shaping the music, until a mapped archive exists for replay and thereafter alongside it.

### The doctrine

1. The crowd seeds the near future, not the exact present. Sentiment windows feed a mood engine that briefs generation; tracks enter rotation minutes after the mood that made them, and the DJ says so on air. No track is synthesized into dead air.
2. Every track carries a birth certificate stored in the library: the crowd-state summary that seeded it, the generation prompt, the tool, the timestamp, and a snapshot of the license terms in force. Audience influence is verifiable, not claimed.
3. The mood engine modulates within the station's identity. Founders pick the genre lanes; the room steers energy, tempo, and color inside them.
4. The archive is the second product: each session leaves behind the album its listeners unknowingly wrote, replayable, each track a fossil of a specific hour of specific humans.
5. Tooling is the leading paid tier by founder instruction, COST FLAG standing: per-track pricing, API terms, and the training-data litigation posture of each vendor go in the options table with real numbers before the first dollar. License terms are archived per track.

### Interaction with amendment 5

The format clock, rotation rules, and evergreen fill stand unchanged. The living library replaces the static pre-built library; generation cadence starts at a few tracks per hour and the accumulated archive carries an increasing share of rotation over time.
