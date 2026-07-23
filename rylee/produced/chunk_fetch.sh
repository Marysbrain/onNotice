#!/usr/bin/env bash
# chunk_fetch.sh
# Resumable single-file fetcher for the mini, whose bulk downloads stall after
# 15 to 45 MB per connection but resume correctly over HTTP range requests.
#
# Usage:
#   chunk_fetch.sh <url> <dest> <min_bytes>
#
# It curls into <dest>.partial with -C - (resume from wherever the last pass
# stopped) and a hard per-pass timeout, looping until the file reaches
# min_bytes or the pass budget is spent. On success it moves the file into
# place. min_bytes is the sanity floor: a file smaller than that is treated as
# truncated and the run fails loudly rather than handing back a stub.
#
# No em dashes anywhere in this file.
set -euo pipefail

MAX_PASSES="${CHUNK_FETCH_MAX_PASSES:-400}"   # bounded so a dead URL cannot spin forever
PASS_TIMEOUT="${CHUNK_FETCH_PASS_TIMEOUT:-120}"  # hard seconds per curl pass
PASS_SLEEP="${CHUNK_FETCH_PASS_SLEEP:-2}"     # pause between passes

log() { printf '[chunk_fetch] %s\n' "$*"; }

file_size() {
  # Portable byte size: macOS stat -f, Linux stat -c fallback.
  local f="$1"
  if [[ ! -e "$f" ]]; then
    echo 0
    return 0
  fi
  if stat -f%z "$f" >/dev/null 2>&1; then
    stat -f%z "$f"
  else
    stat -c%s "$f"
  fi
}

main() {
  if [[ $# -ne 3 ]]; then
    echo "usage: chunk_fetch.sh <url> <dest> <min_bytes>" >&2
    exit 2
  fi
  local url="$1" dest="$2" min_bytes="$3"
  local tmp="${dest}.partial"

  # Already present and sane: nothing to do. Idempotent by design.
  local existing
  existing="$(file_size "$dest")"
  if (( existing >= min_bytes )); then
    log "${dest##*/} already present and sane (${existing} bytes >= ${min_bytes}). Skipping."
    return 0
  fi

  mkdir -p "$(dirname "$dest")"
  log "fetching ${dest##*/}"
  log "  url        ${url}"
  log "  min_bytes  ${min_bytes}"

  local pass=0 size=0 last=-1 stalls=0
  while (( pass < MAX_PASSES )); do
    pass=$((pass + 1))
    size="$(file_size "$tmp")"
    if (( size >= min_bytes )); then
      break
    fi

    # -C - resumes from the current tail. --fail so an HTTP error is a nonzero
    # exit, not a saved error page. A pass that times out mid-stream still keeps
    # whatever bytes arrived, and the next pass resumes from there.
    set +e
    curl -L --fail --show-error --silent \
      -C - \
      --max-time "$PASS_TIMEOUT" \
      --retry 0 \
      -o "$tmp" \
      "$url"
    local rc=$?
    set -e

    local now
    now="$(file_size "$tmp")"
    log "  pass ${pass}: ${now} bytes (curl rc=${rc})"

    # Stall detection: if two consecutive passes add zero bytes and curl is not
    # reporting success, the endpoint is not serving ranges. Bail with context.
    if (( now == last )); then
      stalls=$((stalls + 1))
      if (( stalls >= 3 )); then
        log "ERROR: ${dest##*/} made no progress across 3 passes at ${now} bytes. Aborting."
        exit 1
      fi
    else
      stalls=0
    fi
    last="$now"

    if (( now >= min_bytes )); then
      break
    fi
    sleep "$PASS_SLEEP"
  done

  size="$(file_size "$tmp")"
  if (( size < min_bytes )); then
    log "ERROR: ${dest##*/} reached only ${size} bytes after ${pass} passes, below ${min_bytes}."
    exit 1
  fi

  mv "$tmp" "$dest"
  log "saved ${dest##*/} (${size} bytes) after ${pass} pass(es)."
}

main "$@"
