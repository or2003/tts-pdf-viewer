#!/usr/bin/env bash
# Pre-cache the Kokoro English weights so the first English synthesis call doesn't
# wait on a download. Hebrew is served by Microsoft Edge TTS, which streams from
# the cloud per-request and needs no pre-caching (but does require network).
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "Pre-caching Kokoro weights (mlx-community/Kokoro-82M-bf16)"
"${SCRIPT_DIR}/.venv/bin/python" - <<'PY'
from huggingface_hub import snapshot_download
path = snapshot_download("mlx-community/Kokoro-82M-bf16")
print(f"Kokoro cached at {path}")
PY

echo "Kokoro ready. Hebrew (Edge TTS) needs network at request time, no pre-cache."
