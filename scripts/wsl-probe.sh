#!/usr/bin/env bash
# Run a cross-compiled Linux probe binary inside WSL/Linux, reusing the Windows-cached model.
# Usage: bash scripts/wsl-probe.sh [main|worker] [binary-name]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
MODE="${1:-main}"
BIN="${2:-eunoia-probe-linux}"

cp "$REPO/$BIN" /tmp/probe && chmod +x /tmp/probe
export EUNOIA_MODEL_DIR="/mnt/c/Users/jeffk/AppData/Local/Eunoia/Cache/models"

echo "=== model cache ($EUNOIA_MODEL_DIR) ==="
ls "$EUNOIA_MODEL_DIR/Xenova/multilingual-e5-small" 2>&1 | head
echo "=== glibc / ldd version ==="
ldd --version 2>&1 | head -1
echo "=== RUN PROBE_MODE=$MODE ==="
PROBE_MODE="$MODE" /tmp/probe
echo "EXIT=$?"
