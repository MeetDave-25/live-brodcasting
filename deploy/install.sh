#!/usr/bin/env bash
# Install (or update) Rangvasa Live on an Ubuntu 22.04 / 24.04 server.
#   sudo bash deploy/install.sh
# Safe to run again after uploading new files: keeps .env, data/ and recordings.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
MTX_VERSION="v1.21.2"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mError: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo: sudo bash deploy/install.sh"
[ -f .env ] || die "No .env file. Run: cp .env.example .env && nano .env"
sed -i 's/$//' .env   # files edited on Windows
set -a; . ./.env; set +a
: "${DOMAIN:?Set DOMAIN in .env}"
PORT="${PORT:-8080}"
case "${ADMIN_PASSWORD:-}${BROADCAST_PASSWORD:-}" in
  *change-this*|"") die "Set ADMIN_PASSWORD and BROADCAST_PASSWORD in .env" ;;
esac

PUBLIC_IP="$(curl -fsS4 https://api.ipify.org || curl -fsS4 https://ifconfig.me)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [ "$DNS_IP" != "$PUBLIC_IP" ]; then
  echo "Warning: $DOMAIN points to '${DNS_IP:-nothing}', but this server is $PUBLIC_IP."
  echo "Add a DNS A record: $DOMAIN -> $PUBLIC_IP (HTTPS will start working once it updates)."
fi

say "Installing system packages"
apt-get update -y
apt-get install -y curl tar ufw gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v caddy >/dev/null; then
  say "Installing Caddy (automatic HTTPS)"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

case "$(uname -m)" in
  x86_64) MTX_ARCH=amd64 ;;
  aarch64|arm64) MTX_ARCH=arm64 ;;
  *) die "Unsupported CPU: $(uname -m)" ;;
esac
MTX_BIN="$APP_DIR/server/bin-linux/mediamtx"
if [ ! -x "$MTX_BIN" ] || [ "$(cat "$APP_DIR/server/bin-linux/VERSION" 2>/dev/null)" != "$MTX_VERSION" ]; then
  say "Installing MediaMTX $MTX_VERSION"
  mkdir -p "$APP_DIR/server/bin-linux"
  curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/${MTX_VERSION}/mediamtx_${MTX_VERSION}_linux_${MTX_ARCH}.tar.gz" \
    | tar -xz -C "$APP_DIR/server/bin-linux" mediamtx
  echo "$MTX_VERSION" > "$APP_DIR/server/bin-linux/VERSION"
fi

say "Configuring streaming server for $PUBLIC_IP"
sed "s/^webrtcAdditionalHosts: \[\]/webrtcAdditionalHosts: [\"$PUBLIC_IP\"]/" \
  server/mediamtx.yml > server/mediamtx.prod.yml
mkdir -p server/recordings data

cat > /etc/systemd/system/rangvasa-media.service <<EOF
[Unit]
Description=Rangvasa Live - streaming engine (MediaMTX)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$APP_DIR/server
ExecStart=$MTX_BIN $APP_DIR/server/mediamtx.prod.yml
Restart=always
RestartSec=2
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/rangvasa-web.service <<EOF
[Unit]
Description=Rangvasa Live - app server
After=network-online.target rangvasa-media.service

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) $APP_DIR/serve.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

say "Configuring https://$DOMAIN"
mkdir -p /etc/caddy/sites
cat > /etc/caddy/sites/rangvasa.caddy <<EOF
$DOMAIN {
	encode gzip
	# Live video goes straight to the streaming engine
	@video path_regexp ^/cam[1-6]/
	handle @video {
		reverse_proxy 127.0.0.1:8888
	}
	# App pages, API, going live
	handle {
		reverse_proxy 127.0.0.1:$PORT
	}
}
EOF
# Use our site file; keep any other sites already configured on this server
if ! grep -q "import sites/\*.caddy" /etc/caddy/Caddyfile 2>/dev/null; then
  if grep -q "/usr/share/caddy" /etc/caddy/Caddyfile 2>/dev/null; then
    echo "import sites/*.caddy" > /etc/caddy/Caddyfile   # replace the stock welcome page
  else
    printf '\nimport sites/*.caddy\n' >> /etc/caddy/Caddyfile
  fi
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

say "Opening firewall ports (SSH, web, camera video 8189)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw allow 8189/udp >/dev/null
ufw allow 8189/tcp >/dev/null
ufw --force enable >/dev/null

say "Starting services"
systemctl daemon-reload
systemctl enable rangvasa-media rangvasa-web >/dev/null
systemctl restart rangvasa-media rangvasa-web
systemctl reload caddy || systemctl restart caddy
sleep 2
systemctl is-active --quiet rangvasa-media || die "Streaming engine didn't start: journalctl -u rangvasa-media -n 50"
systemctl is-active --quiet rangvasa-web || die "App server didn't start: journalctl -u rangvasa-web -n 50"

cat <<EOF

  Rangvasa Live is running.

  Viewers   https://$DOMAIN
  Cameras   https://$DOMAIN/studio
  Admin     https://$DOMAIN/admin

  If your provider has its own firewall (AWS, Oracle, Azure, ...), also open
  TCP 80, 443, 8189 and UDP 8189 there.

  Logs: journalctl -u rangvasa-web -f    journalctl -u rangvasa-media -f
EOF
