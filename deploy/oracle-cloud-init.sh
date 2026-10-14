#!/bin/bash
# =====================================================================
#  RANGVAASA Live: one-time server setup, done entirely from a phone.
#  Paste this whole file into Oracle Cloud -> Create instance ->
#  "Show advanced options" -> Management -> "Paste cloud-init script".
#
#  1. Change the two passwords below (avoid the characters $ ' " and spaces).
#  2. Leave DOMAIN empty to get a free https address automatically,
#     or put your own, e.g. live.yourdomain.com (add its DNS A record first).
# =====================================================================
ADMIN_PASSWORD='change-this-admin-password'
BROADCAST_PASSWORD='change-this-camera-password'
DOMAIN=''
MAX_VIEWERS='400'

exec > /var/log/rangvaasa-setup.log 2>&1
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git
git clone --depth 1 https://github.com/MeetDave-25/live-brodcasting.git /opt/rangvaasa
cd /opt/rangvaasa
cat > .env <<EOF
DOMAIN=$DOMAIN
ADMIN_PASSWORD=$ADMIN_PASSWORD
BROADCAST_PASSWORD=$BROADCAST_PASSWORD
PORT=8080
MAX_VIEWERS=$MAX_VIEWERS
EOF
bash deploy/install.sh
echo "RANGVAASA setup finished"
