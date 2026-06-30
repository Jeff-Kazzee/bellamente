#!/usr/bin/env bash
# Full end-to-end test of the real compiled Linux binary in WSL: boot -> /health -> POST /memories
# -> POST /search, against the pgvector container published on the Windows host (0.0.0.0:5433).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
BIN="${1:-eunoia-probe-linux-full}"
DBNAME="${2:-minimem}"
PORT=8088

cp "$REPO/$BIN" /tmp/eunoia && chmod +x /tmp/eunoia
export EUNOIA_MODEL_DIR="/mnt/c/Users/jeffk/AppData/Local/Eunoia/Cache/models"
export EUNOIA_API_KEY="e2e-test"
export PORT
HOSTIP="$(ip route show default | awk '{print $3}')"
export DATABASE_URL="postgres://postgres:postgres@${HOSTIP}:5433/${DBNAME}"
echo "host ip=$HOSTIP  db=$DBNAME  port=$PORT"

/tmp/eunoia > /tmp/eunoia.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT

ok=0
for i in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then echo "health OK after ${i}s"; ok=1; break; fi
  if ! kill -0 $PID 2>/dev/null; then echo "process died early"; break; fi
  sleep 1
done
if [ "$ok" != "1" ]; then echo "=== server log ==="; cat /tmp/eunoia.log; exit 1; fi

AUTH="Authorization: Bearer e2e-test"
echo "=== POST /memories ==="
curl -sS -X POST "http://127.0.0.1:$PORT/memories" -H "$AUTH" -H "content-type: application/json" \
  -d '{"memories":[{"content":"The Eunoia native binary embeds onnxruntime and runs the embedding model in a worker thread for safety."}],"containerTag":"e2e"}'
echo
echo "=== POST /search (relevant) ==="
curl -sS -X POST "http://127.0.0.1:$PORT/search" -H "$AUTH" -H "content-type: application/json" \
  -d '{"q":"how does the binary run the embedding model?","containerTag":"e2e"}'
echo
echo "=== tail server log ==="
tail -8 /tmp/eunoia.log
