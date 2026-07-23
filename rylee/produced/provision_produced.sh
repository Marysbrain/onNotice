#!/usr/bin/env bash
# provision_produced.sh
# Idempotent setup for Rylee's PRODUCED voice lane (Chatterbox TTS, MIT).
# Run this ON the Mac mini. Everything lives under ~/rylee/produced. It never
# touches the existing ~/rylee/venv or ~/rylee/models. No sudo, no Homebrew.
#
# Why this is not a plain "pip install chatterbox-tts":
# The mini's bulk downloads stall after 15 to 45 MB per connection but resume
# correctly. A direct pip install of torch-sized wheels hangs forever. So we:
#   1. resolve the full dependency set with pip's dry-run report (this pulls
#      only tiny metadata, never the big wheels),
#   2. build a complete local wheelhouse, fetching every file over 10 MB with
#      the resumable chunk_fetch loop and small files with a plain curl,
#   3. install offline from the wheelhouse (--no-index), falling back to an
#      index-allowed pass only to fill small gaps, with the giant wheels
#      already satisfied locally so they are never pulled over the flaky link,
#   4. chunk_fetch the Chatterbox checkpoints from Hugging Face,
#   5. smoke synthesize one sentence.
#
# Safe to run repeatedly. Existing venv, wheels, and model files are reused.
# No em dashes anywhere in this file.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCED="${HERE}"
VENV="${PRODUCED}/venv"
WHEELHOUSE="${PRODUCED}/wheelhouse"
BUILD="${PRODUCED}/build"
MODELS="${PRODUCED}/models"
OUT="${PRODUCED}/out"
CHUNK_FETCH="${PRODUCED}/chunk_fetch.sh"

REPO_ID="ResembleAI/chatterbox"
HF_BASE="https://huggingface.co/${REPO_ID}/resolve/main"

log() { printf '[provision-produced] %s\n' "$*"; }

file_size() {
  local f="$1"
  [[ -e "$f" ]] || { echo 0; return 0; }
  if stat -f%z "$f" >/dev/null 2>&1; then stat -f%z "$f"; else stat -c%s "$f"; fi
}

mkdir -p "${PRODUCED}" "${WHEELHOUSE}" "${BUILD}" "${MODELS}" "${OUT}"
chmod +x "${CHUNK_FETCH}" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 1. Python. Prefer 3.14 (Chatterbox 0.1.7 declares a 3.14 branch: torch>=2.9,
# numpy>=2). cp314 arm64 wheels for torch, torchaudio, numpy, numba, scipy,
# and the abi3 packages all exist as of this writing. Fall back to the newest
# 3.11+ found. Override with PYBIN=/path/to/python if a resolve conflict on
# 3.14 (most likely the numba/numpy/librosa triangle) forces 3.13.
# ---------------------------------------------------------------------------
find_python() {
  local cand
  for cand in "${PYBIN:-}" \
      /opt/homebrew/bin/python3.14 \
      /opt/homebrew/bin/python3.13 \
      /opt/homebrew/bin/python3.12 \
      python3.14 python3.13 python3.12 \
      /opt/homebrew/bin/python3 python3; do
    [[ -n "$cand" ]] || continue
    command -v "$cand" >/dev/null 2>&1 || continue
    if "$cand" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 11) else 1)' 2>/dev/null; then
      echo "$cand"; return 0
    fi
  done
  return 1
}

PYBIN="$(find_python)" || { log "ERROR: no Python 3.11+ found."; exit 1; }
PYVER="$("${PYBIN}" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
log "using ${PYBIN} (Python ${PYVER})"

# ---------------------------------------------------------------------------
# 2. Venv (NEW, separate from ~/rylee/venv).
# ---------------------------------------------------------------------------
if [[ ! -x "${VENV}/bin/python" ]]; then
  log "creating venv at ${VENV}"
  "${PYBIN}" -m venv "${VENV}"
else
  log "venv already exists. Reusing."
fi
# shellcheck disable=SC1091
source "${VENV}/bin/activate"

log "upgrading pip, setuptools, wheel (small, direct download)"
python -m pip install --quiet --upgrade pip setuptools wheel

# ---------------------------------------------------------------------------
# 3. Resolve the dependency set without downloading the big wheels.
# pip --dry-run --report pulls only metadata and any small sdists it needs to
# read metadata from. It writes every resolved artifact URL to report.json.
# A resolution conflict (for example numba vs numpy on this Python) surfaces
# HERE, before a single large byte is fetched.
# ---------------------------------------------------------------------------
REPORT="${BUILD}/report.json"
log "resolving chatterbox-tts dependency tree (metadata only) ..."
if ! python -m pip install --dry-run --quiet \
      --report "${REPORT}" chatterbox-tts; then
  log "ERROR: dependency resolution failed on Python ${PYVER}."
  log "Most likely a cp314 gap in the numba/numpy/librosa triangle."
  log "Retry with a different interpreter, for example:"
  log "  PYBIN=/opt/homebrew/bin/python3.13 rm -rf '${VENV}' && bash '${BASH_SOURCE[0]}'"
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Build the wheelhouse. Every file over 10 MB goes through chunk_fetch;
# small files get a bounded plain curl. This yields a complete local index.
# ---------------------------------------------------------------------------
BIG_THRESHOLD=$((10 * 1024 * 1024))

mapfile -t URLS < <(python - "${REPORT}" <<'PY'
import json, sys
rep = json.load(open(sys.argv[1]))
seen = set()
for item in rep.get("install", []):
    di = item.get("download_info") or {}
    url = di.get("url")
    if url and url.startswith("http") and url not in seen:
        seen.add(url)
        print(url)
PY
)

log "resolved ${#URLS[@]} artifacts. Populating wheelhouse ..."
for url in "${URLS[@]}"; do
  fname="${url##*/}"
  fname="${fname%%\?*}"
  dest="${WHEELHOUSE}/${fname}"
  if [[ -s "$dest" ]]; then
    log "  have ${fname}"
    continue
  fi
  # Content-Length tells us whether to use the resumable loop.
  clen="$(curl -sIL --max-time 60 "$url" | awk 'BEGIN{IGNORECASE=1} /^content-length:/ {v=$2} END{gsub(/\r/,"",v); print v+0}')"
  if (( clen >= BIG_THRESHOLD )); then
    log "  chunk_fetch ${fname} (${clen} bytes)"
    # min_bytes: 95% of advertised length is a safe truncation floor.
    minb=$(( clen * 95 / 100 ))
    bash "${CHUNK_FETCH}" "$url" "$dest" "$minb"
  else
    log "  curl ${fname} (${clen} bytes)"
    curl -L --fail --show-error --silent --retry 5 --retry-delay 2 \
      --max-time 300 -o "${dest}.partial" "$url"
    mv "${dest}.partial" "$dest"
  fi
done

# ---------------------------------------------------------------------------
# 5. Install. Seat the giant binary wheels first from local disk so no later
# step can decide to re-fetch torch over the network. Then install the tree
# offline; fall back to an index-allowed pass only if an sdist-only dependency
# needs a small build backend we do not have cached.
# ---------------------------------------------------------------------------
shopt -s nullglob
BIGWHEELS=( "${WHEELHOUSE}"/torch-*.whl "${WHEELHOUSE}"/torchaudio-*.whl )
shopt -u nullglob
if (( ${#BIGWHEELS[@]} )); then
  log "seating torch and torchaudio from wheelhouse (no deps)"
  python -m pip install --no-index --find-links "${WHEELHOUSE}" --no-deps "${BIGWHEELS[@]}"
fi

log "installing chatterbox-tts offline from wheelhouse"
if ! python -m pip install --no-index --find-links "${WHEELHOUSE}" chatterbox-tts; then
  log "offline install incomplete. Falling back to index-allowed pass"
  log "(big wheels are already installed locally and will not be refetched)."
  python -m pip install --find-links "${WHEELHOUSE}" chatterbox-tts
fi

python -m pip freeze > "${PRODUCED}/versions.txt"
log "resolved versions written to ${PRODUCED}/versions.txt"

# ---------------------------------------------------------------------------
# 6. Chatterbox checkpoints (English model). These are what from_local loads.
# Sizes as of 2026-07: t3_cfg 2.13 GB and s3gen 1.06 GB are the resumable
# cases; the other three are small. min_bytes floors reject truncated files.
# ---------------------------------------------------------------------------
fetch_model() {
  local name="$1" minb="$2"
  bash "${CHUNK_FETCH}" "${HF_BASE}/${name}" "${MODELS}/${name}" "${minb}"
}
log "fetching Chatterbox checkpoints into ${MODELS}"
fetch_model "ve.safetensors"      $((5 * 1024 * 1024))          # ~5.7 MB
fetch_model "t3_cfg.safetensors"  $((2000 * 1024 * 1024))       # ~2.13 GB
fetch_model "s3gen.safetensors"   $((1000 * 1024 * 1024))       # ~1.06 GB
fetch_model "tokenizer.json"      $((10 * 1024))                # ~25 KB
fetch_model "conds.pt"            $((50 * 1024))                # ~105 KB

# ---------------------------------------------------------------------------
# 7. Smoke synthesis: "The receipts are on screen." -> out/smoke.wav
# ---------------------------------------------------------------------------
log "running smoke synthesis"
PYTORCH_ENABLE_MPS_FALLBACK=1 python - "$MODELS" "$OUT" <<'PY'
import sys, time
from pathlib import Path
models = Path(sys.argv[1]); out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)

import torch
import torchaudio
from chatterbox.tts import ChatterboxTTS

if torch.backends.mps.is_available():
    device = "mps"
elif torch.cuda.is_available():
    device = "cuda"
else:
    device = "cpu"
print(f"[smoke] device={device}")

t0 = time.perf_counter()
model = ChatterboxTTS.from_local(str(models), device)
print(f"[smoke] model loaded in {time.perf_counter()-t0:.1f}s, sr={model.sr}")

t1 = time.perf_counter()
wav = model.generate("The receipts are on screen.")
print(f"[smoke] synthesized in {time.perf_counter()-t1:.1f}s")

path = out / "smoke.wav"
torchaudio.save(str(path), wav.detach().cpu(), model.sr)
print(f"[smoke] wrote {path}")
PY

SMOKE="${OUT}/smoke.wav"
if (( $(file_size "${SMOKE}") > 1000 )); then
  log "SUCCESS: ${SMOKE} ($(file_size "${SMOKE}") bytes)"
else
  log "ERROR: smoke synthesis did not produce a usable ${SMOKE}"
  exit 1
fi
log "done. venv ${VENV}, models ${MODELS}, wheelhouse ${WHEELHOUSE}, output ${OUT}."
