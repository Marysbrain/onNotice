# Music generation options table. Local models for Rylee Radio.

Verified 2026-07-23 against each project's own license files and model cards. This is the decision document required by amendment 5's music-rights gate and the amendment 6 revision (local-first generation). The founder picks lanes and models by ear from rendered samples; this table settles what is legally and physically possible on the mini first.

The mini: Apple M4, 16GB unified memory, macOS 26. The memory pool is shared with Kokoro or Chatterbox TTS, the local 8B, the bee, and playout. Model downloads ride the chunk-resume pattern and must be sequenced, never parallel, on the current radio link.

## The candidates

### ACE-Step 1.5. The front-runner.

- License: MIT, code and weights both. Confirmed on the [GitHub repo](https://github.com/ace-step/ACE-Step-1.5) and the [Hugging Face weights repo](https://huggingface.co/ACE-Step/Ace-Step1.5).
- Mac support: explicit. macOS launch scripts ship in the repo and an MLX backend for Apple Silicon is documented. This is the only full-song candidate that names our hardware.
- Memory: the 2B turbo model runs in 6 to 8GB. Fits beside the TTS and the 8B on a 16GB box. Larger XL variants want 12 to 20GB and are out of budget while anything else is loaded.
- Speed: under 2 seconds per full song on an A100, under 10 seconds on an RTX 3090. No published Mac numbers. Even at 20x slower than the 3090 it lands inside the amendment 6 promise of minutes after the mood.
- Output terms: MIT imposes no conditions on outputs. Clean for the amendment 11 CC0 dedication with no strings.
- Open item: render samples on the mini and bench real MPS/MLX generation time. Weights are a multi-GB fetch; sequence it after the Chatterbox grind finishes.

### ACE-Step v1-3.5B. The original candidate, now superseded.

- License: Apache 2.0 ([Hugging Face](https://huggingface.co/ACE-Step/ACE-Step-v1-3.5B)).
- Only worth benching if 1.5 disappoints on the mini. Same family, older, bigger appetite.

### DiffRhythm. Apache on the surface, Stability underneath.

- License: DiT weights and code Apache 2.0, BUT the VAE is fine-tuned from Stable Audio Open and the [model card says directly](https://huggingface.co/ASLP-lab/DiffRhythm-vae) it is subject to the Stability AI Community License. The whole pipeline therefore runs under Stability's terms, not pure Apache. The spec's earlier description of DiffRhythm as Apache-licensed was two-thirds right and the wrong third is load-bearing.
- Stability Community License in practice: free commercial use while annual revenue is under $1M, "Powered by Stability AI" attribution on the site, and we own the outputs, so CC0 dedication of tracks remains possible. Not disqualifying. Just not the clean MIT story.
- Mac support: unproven. No published MPS numbers anywhere I could find. DiT is around 1B so memory is plausible. Bench only if a second full-song flavor is wanted.

### YuE. License-clean, hardware-dead.

- License: Apache 2.0, weights included. Outputs explicitly free to use commercially; crediting "YuE by HKUST/M-A-P" is encouraged, not required ([README](https://github.com/multimodal-art-projection/YuE/blob/main/README.md)). CC0-clean.
- Hardware: stage 1 is 7B, guidance says 24GB GPU for short runs and 80GB-class hardware for full songs, roughly 150 seconds per 30 seconds of audio on an H800. The mini cannot carry this beside anything else. Closed on feasibility, not on license. Revisit only on founder hardware.

### Stable Audio Open (1.0 and small). The beds and stingers lane.

- License: Stability AI Community License ([license page](https://stability.ai/license), [model card](https://huggingface.co/stabilityai/stable-audio-open-1.0)). Free commercial use under $1M annual revenue. "This Stability AI Model is licensed under the Stability AI Community License" notice plus "Powered by Stability AI" display on the site. We own the outputs; CC0 on published tracks stays possible.
- The small model (about 341M) is Arm-optimized and the natural fit for station IDs, beds, and stingers on the mini at low memory cost. Not a full-song engine; it was never meant to be.

### MusicGen. Barred, unchanged.

Non-commercial weights. Amendment 6 revision already closed this. No new information changes it.

## The CC0 question (amendment 11 diligence)

- MIT and Apache weights place no conditions on outputs. Tracks from ACE-Step 1.5 or YuE can carry an unconditional CC0 dedication.
- Stability-licensed engines (Stable Audio Open, and DiffRhythm via its VAE): the license says we own outputs and use them at our discretion under the AUP. CC0 dedication is ours to make. The attribution duties bind the station's pages, not the people downloading tracks, so the archive page carries the Stability notice and the tracks stay unconditional.
- Every track's birth certificate archives the license text in force at generation time, per amendment 11 item 2.

## Recommendation to the founder (ear test still decides)

1. Full-song lane: ACE-Step 1.5, 2B turbo. MIT everywhere, Mac-native, fits our memory, CC0 with no strings. Bench and render samples first.
2. Beds and stingers lane: Stable Audio Open small, with the Stability notice on the site. COST: zero. Revenue condition ($1M/yr) is not a near-term constraint and its crossing would be a good problem.
3. Keep DiffRhythm as the bench-later alternate. Drop YuE until different hardware exists.
4. Nothing here costs money. No COST FLAG needed on any recommended path.
