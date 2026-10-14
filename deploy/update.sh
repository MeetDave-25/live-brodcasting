#!/usr/bin/env bash
# Pull the latest version from GitHub and reinstall. Keeps .env, data/ and recordings.
# Started by the control room's "Update server" button (or run: sudo bash deploy/update.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== Update started $(date)"
git fetch --depth 1 origin main
git reset --hard origin/main
bash deploy/install.sh
echo "== Update finished $(date)"
