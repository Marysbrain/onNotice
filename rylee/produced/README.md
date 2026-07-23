# Rylee produced lane: the Chatterbox voice renderer

This is the produced (pre-rendered) voice lane for the two-anchor desk. It turns
a validated JSON script into finished audio using Chatterbox TTS (MIT). Latency
does not matter here, expressiveness does. Everything lives under
`~/rylee/produced` and uses a new venv that never touches the live lane's
`~/rylee/venv`.

The renderer speaks each line exactly as written. Emotion and pace control
delivery, never content. The no-additions invariant is enforced in code and in
tests: the concatenation of everything sent to the engine equals the
concatenation of the input line texts, byte for byte.

## Files

- `chunk_fetch.sh` resumable single-file fetcher for the mini's flaky link
  (args: url, dest, min_bytes).
- `provision_produced.sh` idempotent setup: venv, wheelhouse, Chatterbox
  checkpoints, smoke synthesis.
- `render_script.py` the renderer.
- `ab_script.json` an eight-line two-anchor demo script (see the note below).
- `tests.py` plain-python tests for the validator and the no-additions
  invariant. No model needed.

## Run order (on the mini)

1. Provision once. This is the long part.

   ```
   bash ~/rylee/produced/provision_produced.sh
   ```

   It creates `~/rylee/produced/venv`, resolves the whole dependency tree
   without downloading the big wheels, builds a local wheelhouse (fetching every
   file over 10 MB through `chunk_fetch.sh`), installs offline, fetches the
   Chatterbox checkpoints, and finishes by synthesizing "The receipts are on
   screen." to `~/rylee/produced/out/smoke.wav`.

2. Render a script.

   ```
   source ~/rylee/produced/venv/bin/activate
   python ~/rylee/produced/render_script.py ~/rylee/produced/ab_script.json --out-name ab
   ```

   Outputs `~/rylee/produced/out/ab.wav` and `ab.mp3` (64 kbps). Per-line and
   total render times print as it goes.

3. Optional reference voices. Chatterbox ships one built in voice, so by default
   both anchors use it, biased slightly apart so you can tell them apart. For two
   genuinely distinct timbres, pass a short clean reference wav per speaker:

   ```
   python render_script.py ab_script.json --out-name ab \
     --ref-rylee ~/rylee/produced/voices/rylee.wav \
     --ref-co    ~/rylee/produced/voices/co.wav
   ```

## Expected durations

- First provisioning: hours, honestly. The mini's bulk downloads stall after 15
  to 45 MB per connection and resume. The two big model files alone are about
  2.13 GB (`t3_cfg.safetensors`) and 1.06 GB (`s3gen.safetensors`), plus torch
  (roughly 75 to 110 MB) and the rest of the wheelhouse. `chunk_fetch.sh` grinds
  through all of it in bounded resumable passes. Expect to leave it running.
  It is idempotent: a killed run picks up where it left off on the next start,
  and finished files are skipped.
- Model load per render session: tens of seconds on the M4 (the t3 checkpoint is
  large). This happens once per process, not once per line.
- Per line synthesis on MPS: a few seconds for a normal sentence. A short
  eight-line segment renders in well under a minute of compute after load. CPU
  fallback is several times slower but works.
- ffmpeg master: a second or two.

## What the emotion and pace numbers do

- `emotion` (0..1) maps to Chatterbox's `exaggeration` control, clamped to a
  safe band. Flat for fine print, warmth for the close, per the show doctrine.
- `pace` (0.25..2.0, 1.0 neutral) maps to `cfg_weight`, the cadence control the
  engine actually exposes. Lower pace yields slower, more deliberate delivery.
  Chatterbox has no literal words-per-minute dial, so pace shapes delivery, it
  does not retime the audio after the fact.

## cp314 wheel findings (verified against PyPI, 2026-07-23)

Chatterbox 0.1.7 declares an explicit Python 3.14 branch (torch>=2.9, numpy>=2),
and the wheels exist, so the provisioner targets `/opt/homebrew/bin/python3.14`:

- torch cp314 macOS arm64 wheels exist from 2.9.0 (about 75 MB) through later
  releases; torchaudio cp314 arm64 wheels exist for the matching 2.9 to 2.11
  line.
- safetensors 0.5.3 and tokenizers ship abi3 arm64 wheels (`cp38-abi3`,
  `cp310-abi3`) that run on 3.14.
- numba, llvmlite, scipy, numpy, sentencepiece, and regex all have cp314 arm64
  wheels as of this date.

The one real risk on 3.14 is the numba / numpy / librosa version triangle. The
provisioner's dry-run resolve surfaces any such conflict before a single large
byte is fetched. If it fails, rerun on 3.13:

```
PYBIN=/opt/homebrew/bin/python3.13 rm -rf ~/rylee/produced/venv && \
  bash ~/rylee/produced/provision_produced.sh
```

## Note on ab_script.json

The task pointed at `../render_demo.py` for the existing desk demo's eight lines.
That file does not exist in this repo or its git history. If it exists on the
mini (for example `~/rylee/render_demo.py`), replace `ab_script.json`'s eight
lines with the verbatim lines from it. Until then, `ab_script.json` is an
original eight-line placeholder that follows the amendment 3 and 4 doctrine
(cold open narrative, a humanizing question, the pattern number, the fine print
read flat, factual restatement without a verdict, warm close pointing at the
take action hub). The only hard figure it uses, 2,466 AT&T arbitration records,
is stated verbatim in the broadcast spec. It is delivery-test scaffolding, not a
validated aired script: the server-side showrunner and its per-line citation
validator own aired content, and the mouth speaks whatever it is handed exactly.

## Licenses

Chatterbox TTS is MIT (resemble-ai/chatterbox). Its dependency tree resolves to
permissively licensed wheels. No cloud TTS, no non-commercial dependency.
