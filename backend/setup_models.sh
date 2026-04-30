#!/usr/bin/env bash
# Download all model weights up-front so synthesis runs fully offline:
#   - Israwave (Hebrew):  speech ONNX, nakdimon diacritics ONNX, espeak-ng data
#   - Kokoro (English):   weights via huggingface_hub snapshot
# Both engines run entirely locally after this script finishes.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DEST="${SCRIPT_DIR}/models/israwave"
mkdir -p "$DEST"
cd "$DEST"

BASE="https://github.com/thewh1teagle/israwave/releases/download/v0.1.0"

if [[ ! -f israwave.onnx ]]; then
  echo "Downloading israwave.onnx"
  curl -L -o israwave.onnx "$BASE/israwave.onnx"
fi

if [[ ! -f nakdimon.onnx ]]; then
  echo "Downloading nakdimon.onnx"
  curl -L -o nakdimon.onnx "$BASE/nakdimon.onnx"
fi

if [[ ! -d espeak-ng-data ]]; then
  echo "Downloading espeak-ng-data"
  curl -L -o espeak-ng-data.tar.gz "$BASE/espeak-ng-data.tar.gz"
  tar xf espeak-ng-data.tar.gz
  rm espeak-ng-data.tar.gz
fi

echo "Israwave assets installed in $DEST"

echo "Pre-caching Kokoro weights (mlx-community/Kokoro-82M-bf16)"
"${SCRIPT_DIR}/.venv/bin/python" - <<'PY'
from huggingface_hub import snapshot_download
path = snapshot_download("mlx-community/Kokoro-82M-bf16")
print(f"Kokoro cached at {path}")
PY

echo "All models ready. Backend can now run fully offline."
