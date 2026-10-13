#!/usr/bin/env bash
# Runs the production server in a loop (restarts on crash). Used by deploy/crypto-cruiser.service
# and by `deploy/start-tmux.sh` when systemd is not an option.
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.nvm/versions/node/v24.5.0/bin:$PATH"
set -a; . ./.env; set +a
while :; do
  npx tsx server/index.ts --serve-dist
  echo "[crypto-cruiser] exited ($?), restarting in 3s"
  sleep 3
done
