#!/usr/bin/env bash
# provision.sh
# Idempotent setup for Rylee's offline voice loop. Run this ON the Mac mini.
# Everything lives under ~/rylee. No sudo. No Homebrew. Nothing outside ~/rylee.
#
# Safe to run repeatedly. Existing venv and model files are reused. Model files
# are re-downloaded only when missing or the wrong size.
set -euo pipefail

RYLEE_HOME="${HOME}/rylee"
VENV="${RYLEE_HOME}/venv"
MODELS="${RYLEE_HOME}/models"
OUT="${RYLEE_HOME}/out"

ONNX_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
VOICES_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
ONNX_PATH="${MODELS}/kokoro-v1.0.onnx"
VOICES_PATH="${MODELS}/voices-v1.0.bin"

# Minimum plausible sizes in bytes. The onnx model is around 310 MB, the voice
# pack around 27 MB. Anything smaller is a truncated or error download.
ONNX_MIN_BYTES=$((200 * 1024 * 1024))
VOICES_MIN_BYTES=$((20 * 1024 * 1024))

# Pinned versions. Coded against kokoro-onnx 0.4.9, whose espeak-ng ships as a
# pip wheel (espeakng-loader), so no system espeak-ng and no Homebrew are needed.
KOKORO_ONNX_VERSION="0.4.9"
SOUNDFILE_VERSION="0.12.1"
REQUESTS_VERSION="2.32.3"
ONNXRUNTIME_VERSION="1.20.1"
NUMPY_VERSION="1.26.4"

log() { printf '[provision] %s\n' "$*"; }

file_size() {
  # Portable byte size for macOS (stat -f) with a Linux fallback (stat -c).
  local f="$1"
  if stat -f%z "$f" >/dev/null 2>&1; then
    stat -f%z "$f"
  else
    stat -c%s "$f"
  fi
}

need_download() {
  local path="$1" min="$2"
  if [[ ! -f "$path" ]]; then
    return 0
  fi
  local size
  size="$(file_size "$path")"
  if (( size < min )); then
    log "existing ${path##*/} is only ${size} bytes, below ${min}. Will re-download."
    return 0
  fi
  log "${path##*/} present and sane (${size} bytes). Skipping download."
  return 1
}

download() {
  local url="$1" path="$2" min="$3"
  local tmp="${path}.partial"
  log "downloading ${path##*/} ..."
  curl -L --fail --retry 3 --retry-delay 2 -o "$tmp" "$url"
  local size
  size="$(file_size "$tmp")"
  if (( size < min )); then
    rm -f "$tmp"
    log "ERROR: downloaded ${path##*/} is only ${size} bytes, below ${min}."
    exit 1
  fi
  mv "$tmp" "$path"
  log "saved ${path##*/} (${size} bytes)."
}

log "root is ${RYLEE_HOME}"
mkdir -p "${RYLEE_HOME}" "${MODELS}" "${OUT}"

# Python version guard. Target is 3.11 or newer.
PYBIN="${PYBIN:-python3}"
PYVER="$("${PYBIN}" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
log "using ${PYBIN} (Python ${PYVER})"
"${PYBIN}" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 11) else 1)' || {
  log "ERROR: need Python 3.11 or newer. Found ${PYVER}."
  exit 1
}

# Virtual environment.
if [[ ! -x "${VENV}/bin/python" ]]; then
  log "creating venv at ${VENV}"
  "${PYBIN}" -m venv "${VENV}"
else
  log "venv already exists. Reusing."
fi

# shellcheck disable=SC1091
source "${VENV}/bin/activate"

log "upgrading pip"
python -m pip install --upgrade pip >/dev/null

log "installing pinned dependencies"
python -m pip install \
  "numpy==${NUMPY_VERSION}" \
  "onnxruntime==${ONNXRUNTIME_VERSION}" \
  "kokoro-onnx==${KOKORO_ONNX_VERSION}" \
  "soundfile==${SOUNDFILE_VERSION}" \
  "requests==${REQUESTS_VERSION}"

# Model files.
if need_download "${ONNX_PATH}" "${ONNX_MIN_BYTES}"; then
  download "${ONNX_URL}" "${ONNX_PATH}" "${ONNX_MIN_BYTES}"
fi
if need_download "${VOICES_PATH}" "${VOICES_MIN_BYTES}"; then
  download "${VOICES_URL}" "${VOICES_PATH}" "${VOICES_MIN_BYTES}"
fi

log "done. venv ${VENV}, models under ${MODELS}, output under ${OUT}."
log "next: source ${VENV}/bin/activate then run rylee_loop.py"
