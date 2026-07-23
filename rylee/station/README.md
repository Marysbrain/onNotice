# Rylee Radio station core

The clock scheduler, the outcome schema, and the playout chain skeleton.
Amendments 5, 6, 7, 9, 10, and 11 wired together, offline, with placeholder
audio. Nothing here touches the network, a model, or a real audio file.

## What exists

- clock.py: the deterministic format clock. A fixed repeating hour defined as
  data (HOUR_TEMPLATE), rotation rules with a no-repeat window and a
  fresh/archive share, the A/B variant assignment as a pure function, the
  request queue with the roar detector's enqueue interface, and a plan()
  that always holds at least the next fifteen minutes. Every slot resolves to
  playable inventory or the standing fallback. Dead air is structurally
  impossible: an empty inventory still plans.
- schema.py: birth certificates (crowd state, prompt, tool, license snapshot,
  CC0 dedication), outcome records (every metric carries its sample size, the
  insufficient_signal flag is validated against the data so it cannot lie),
  roar events, and air log entries. Deserialization rejects unknown fields,
  which is how aggregate-never-profile is enforced at the storage seam.
- playout.py: builds the single-pipeline ffmpeg command with crossfades and
  the now-playing readout. Executes nothing unless dry_run is False. The BRB
  failsafe watchdog is a three-state machine (STREAMING, BRB, RESUMING) with
  a capped backoff; its resume rule replans from the wall clock, so the
  station comes back where it should be, not where it stopped.
- tests.py: run with `python3 tests.py` from this directory. No dependencies.

## What is stubbed

- EncoderControl: the OBS/encoder layer. The watchdog calls show_brb_card,
  resume_stream, and is_upline_ok; the real implementation arrives with the
  streaming stage and the wired network.
- The fast loop's realtime content: dj_insert slots pre-arm their evergreen
  fallback now; the live lane fills the slot at air time in the chat-ingest
  stage.
- The roar detector: RequestQueue.enqueue_encore is its interface. Detection
  itself rides the chat-ingest build.
- Music inventory: tests fabricate items. Real tracks arrive with the music
  generation lane after the founder's license and ear decisions.

## What the next stage wires in

1. Chat ingest with the moderation gate, feeding the fast loop and the roar
   detector.
2. The mood engine and mood-to-brief compiler (bee job type) feeding
   generation, which feeds inventory with birth certificates.
3. Encoder control and the stream watchdog against the real upline, after the
   ethernet cable lands.
4. Persistence: air logs and outcome records into the platform's store so no
   early stream's data is lost. The schema ships first on purpose.
