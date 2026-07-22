# Rylee offline voice loop (stage 2)

This is the mouth, not the brain. It takes a question, asks the brain (the /ask
Worker), and speaks the answer out loud through Kokoro TTS. It never adds facts.
If the brain refuses, the refusal is spoken exactly as given.

Everything lives under `~/rylee`. Nothing installs outside it. No sudo, no
Homebrew, no cloud TTS, no paid APIs.

## Files

- `provision.sh` sets up the venv and downloads the Kokoro model. Run it on the mini.
- `rylee_loop.py` is the loop. One question in, spoken answer out, with metrics.
- `testset_voice.py` runs a list of questions through the real voice path and checks the benchmarks.
- `tests.py` runs offline checks with plain python. No model needed.

## Pinned versions

The code is written against these exact versions. Change them and the Kokoro API
may not match.

- kokoro-onnx 0.4.9
- onnxruntime 1.20.1
- soundfile 0.12.1
- requests 2.32.3
- numpy 1.26.4

Note on espeak. kokoro-onnx 0.4.9 pulls its espeak-ng as a pip wheel through
`espeakng-loader`. That is why no Homebrew and no system espeak-ng are needed.
If a future kokoro-onnx version drops that wheel, provisioning would need a
system espeak-ng, which this environment does not allow. Stay on the pinned
version unless you re-test the phonemizer path.

## Setup (run on the mini)

Copy this folder to the mini, then run the provisioner.

```
bash ~/rylee/provision.sh
```

It creates `~/rylee/venv`, installs the pinned packages, and downloads two model
files into `~/rylee/models`:

- `kokoro-v1.0.onnx` (around 310 MB)
- `voices-v1.0.bin` (around 27 MB)

Both come from the official kokoro-onnx GitHub release `model-files-v1.0`. The
script skips a download if the file is already present and the right size. It is
safe to run again.

## Ask one question

Activate the venv first.

```
source ~/rylee/venv/bin/activate
python ~/rylee/rylee_loop.py "How many AT&T device promotion issues are in the library?"
```

You can also pipe the question on stdin.

```
echo "Has AT&T improved its terms?" | python ~/rylee/rylee_loop.py
```

Speak the AI disclosure line first with `--disclose`. Pick a voice with
`--voice`. The default voice is `af_heart`.

```
python ~/rylee/rylee_loop.py --disclose --voice af_heart "Has AT&T improved?"
```

Point at a different brain with the `BASE_URL` environment variable.

```
BASE_URL="https://signal-engine.carriersonnotice.workers.dev" python ~/rylee/rylee_loop.py "..."
```

Each run prints three numbers:

- `t_brain` is the request round trip to the brain.
- `t_first_audio` is question received to first audio playing. The target is under 5 seconds.
- `t_total` is the whole run.

Every spoken clip is saved as a wav under `~/rylee/out` with a timestamp.

## Run the benchmark set

Give it a JSON file that is a list of question strings, or an object with a
`questions` list.

```
source ~/rylee/venv/bin/activate
python ~/rylee/testset_voice.py questions.json
```

With no file it uses a built in set that includes the two canonical questions
and the bait set (employee names, the founder dispute, out of corpus, opinion
fishing). It imports the loop and calls it in library mode, so it exercises the
same code the CLI uses.

For each question it asserts four things and prints a table:

1. an audio file was produced
2. the audio has nonzero duration
3. `t_first_audio` is under 5 seconds
4. the spoken answer equals the brain answer exactly

The command exits non zero if any question fails.

## Offline checks (run anywhere)

These need no model and no network. They cover the sentence splitter and the no
additions rule.

```
python ~/rylee/tests.py
```

## How sentence streaming works

The answer is split into sentences with a lossless splitter. Joining the pieces
back together gives the original answer character for character, so nothing is
added or dropped. The first sentence is synthesized and playback starts while
the rest are synthesized and queued behind it. That is how first audio lands
before the whole answer is ready. A period only ends a sentence when whitespace
or the end of the text follows it, so numbers like 3.5 stay whole.

## Guardrails that live in this code

- The mouth speaks the brain answer verbatim. It never adds, embellishes, or speculates.
- A refusal is spoken exactly as the brain gave it, alone, with nothing appended.
- The AI disclosure line is spoken verbatim when `--disclose` is set.
- The brain is the only source of facts. If it is unreachable, Rylee stays silent and prints a clean error. One retry, then stop. No retry storm.
- No em dashes in any spoken text, code, or comment.

## What was not verified here

The provisioner and the two model downloads were not run. Kokoro synthesis and
`afplay` playback were not run, because the model and the packages are not on
this machine. The offline checks in `tests.py` all pass, both scripts compile,
and `provision.sh` passes a syntax check. Run `provision.sh` then `tests.py` and
`testset_voice.py` on the mini to confirm the voice path end to end.
