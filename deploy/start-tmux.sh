#!/usr/bin/env bash
# Start (or restart) the server in a detached tmux session named "crypto". No sudo needed.
cd "$(dirname "$0")/.."
tmux kill-session -t crypto 2>/dev/null
# the node process outlives the tmux shell; stop every old copy so the port is free
pkill -f "tsx server/index.ts --serve-dist" 2>/dev/null
for i in 1 2 3 4 5; do pgrep -f "tsx server/index.ts --serve-dist" >/dev/null || break; sleep 1; done
tmux new-session -d -s crypto -n server "bash deploy/run.sh 2>&1 | tee -a server.log"
echo "started: tmux attach -t crypto"
