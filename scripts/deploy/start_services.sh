#!/usr/bin/env bash
# Start the ADG stack on the AutoDL container: postgres + api(:6006) +
# verify(:8001) + diarization worker. Idempotent; each service runs in its
# own tmux session (tmux is installed by bootstrap.sh).
set -e

BASE=/root/autodl-tmp/adg
VENV=$BASE/venv/bin
LOGS=$BASE/logs
mkdir -p "$LOGS" "$BASE/data"

service postgresql start >/dev/null 2>&1 || true

export PYTHONPATH=/srv
export DATABASE_URL=postgresql+psycopg://adg:adg@127.0.0.1:5432/adg
export DATA_DIR=$BASE/data
export MODELS_DIR=$BASE/models
export VERIFY_URL=http://127.0.0.1:8001
export EMBEDDING_DEVICE=auto
export TORCH_NUM_THREADS=8

start () {  # name, command...
  local name=$1; shift
  tmux has-session -t "$name" 2>/dev/null && { echo "$name already running"; return; }
  tmux new-session -d -s "$name" "$* &> $LOGS/$name.log"
  echo "$name started (log: $LOGS/$name.log)"
}

start api     "$VENV/uvicorn app.main:app --host 0.0.0.0 --port 6006"
start verify  "$VENV/uvicorn app.verify.server:app --host 0.0.0.0 --port 8001"
start worker  "$VENV/python -m app.worker.worker"

echo "---"
sleep 2
tmux ls
