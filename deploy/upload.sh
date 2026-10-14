#!/usr/bin/env bash
# Upload this project to your server and install/update it, in one go.
# Run from the project folder on your PC (Git Bash on Windows):
#   bash deploy/upload.sh root@YOUR_SERVER_IP
set -euo pipefail
TARGET="${1:?Usage: bash deploy/upload.sh root@YOUR_SERVER_IP}"
REMOTE_DIR="/opt/rangvasa"
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Create .env first (copy .env.example and fill it in)."; exit 1; }

echo "==> Packing"
tar -czf /tmp/rangvasa.tgz public serve.js server/mediamtx.yml deploy .env.example .env

echo "==> Uploading to $TARGET"
scp /tmp/rangvasa.tgz "$TARGET:/tmp/rangvasa.tgz"

echo "==> Installing on the server"
ssh -t "$TARGET" "sudo mkdir -p $REMOTE_DIR && sudo tar -xzf /tmp/rangvasa.tgz -C $REMOTE_DIR && rm /tmp/rangvasa.tgz && sudo sed -i 's/\r\$//' $REMOTE_DIR/deploy/*.sh && sudo bash $REMOTE_DIR/deploy/install.sh"
rm -f /tmp/rangvasa.tgz
