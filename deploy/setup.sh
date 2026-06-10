#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu 24.04 VPS for project-gecko.
#
# Usage (on the VPS, as root or with sudo):
#   curl -fsSL https://raw.githubusercontent.com/cdayAI/Project-Gecko/main/deploy/setup.sh | bash
# or after cloning:
#   bash deploy/setup.sh
#
# What this does:
#   1. Installs Node.js 20 LTS, git, build tools, Java 17 (for IBKR Gateway)
#   2. Installs PM2 globally
#   3. Clones project-gecko if not already present
#   4. Installs npm dependencies and builds
#   5. Downloads & unpacks IBKR Client Portal Gateway
#   6. Sets up logrotate for the bot's logs
#   7. Creates a systemd unit so PM2 restarts on boot
#
# What this does NOT do:
#   - Create .env (must be done manually with secrets)
#   - Authenticate with IBKR (run `npm run auth:ibkr` after setup)
#   - Start the bot (start manually after .env + auth are done)

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/cdayAI/Project-Gecko.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
PROJECT_DIR="${PROJECT_DIR:-$HOME/project-gecko}"
GATEWAY_DIR="${GATEWAY_DIR:-$HOME/clientportal.gw}"
GATEWAY_URL="${GATEWAY_URL:-https://download2.interactivebrokers.com/portal/clientportal.gw.zip}"

echo "===== project-gecko VPS bootstrap ====="
echo "Project dir: $PROJECT_DIR"
echo "Gateway dir: $GATEWAY_DIR"
echo ""

# ----- 1. System packages -----
echo "[1/6] Installing system packages..."
sudo apt-get update -y
sudo apt-get install -y \
  curl wget git build-essential ca-certificates gnupg lsb-release \
  openjdk-17-jre-headless \
  unzip \
  ufw \
  logrotate

# ----- 2. Node.js 20 LTS -----
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q "^v20"; then
  echo "[2/6] Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[2/6] Node $(node -v) already installed"
fi

# ----- 3. PM2 -----
if ! command -v pm2 >/dev/null 2>&1; then
  echo "[3/6] Installing PM2..."
  sudo npm install -g pm2
else
  echo "[3/6] PM2 $(pm2 -v) already installed"
fi

# ----- 4. Project repo -----
if [ ! -d "$PROJECT_DIR/.git" ]; then
  echo "[4/6] Cloning project-gecko..."
  git clone -b "$REPO_BRANCH" "$REPO_URL" "$PROJECT_DIR"
else
  echo "[4/6] Updating project-gecko..."
  cd "$PROJECT_DIR"
  git fetch origin
  git checkout "$REPO_BRANCH"
  git pull origin "$REPO_BRANCH"
fi

cd "$PROJECT_DIR"
echo "    Installing npm dependencies..."
# Bot runs via tsx (devDependency) and builds via tsc (devDependency),
# so we need dev deps installed. Use full install, not --omit=dev.
npm ci || npm install
echo "    Building..."
npm run build
mkdir -p logs data

# ----- 5. IBKR Client Portal Gateway -----
if [ ! -d "$GATEWAY_DIR" ]; then
  echo "[5/6] Installing IBKR Client Portal Gateway..."
  mkdir -p "$GATEWAY_DIR"
  cd "$GATEWAY_DIR"
  wget -O clientportal.gw.zip "$GATEWAY_URL"
  unzip -q clientportal.gw.zip
  rm clientportal.gw.zip
  chmod +x bin/run.sh
  mkdir -p logs
  echo "    Gateway unpacked to $GATEWAY_DIR"
else
  echo "[5/6] IBKR Gateway already installed at $GATEWAY_DIR"
fi

# ----- 6. Logrotate + UFW -----
echo "[6/6] Configuring logrotate and firewall..."

# Logrotate config for the bot's jsonl logs.
sudo tee /etc/logrotate.d/gecko > /dev/null <<EOF
$PROJECT_DIR/logs/*.log {
  daily
  rotate 14
  compress
  missingok
  notifempty
  copytruncate
}
$PROJECT_DIR/data/*.jsonl {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
  size 500M
}
EOF

# Minimal UFW firewall — block everything but SSH outbound trading is fine.
sudo ufw allow 22/tcp comment "ssh" || true
sudo ufw --force enable || true

echo ""
echo "===== Bootstrap complete ====="
echo ""
echo "Next steps:"
echo "  1. Create .env in $PROJECT_DIR:"
echo "       cp .env.example .env"
echo "       \$EDITOR .env"
echo "     Required minimum: BROKER=ibkr, ANTHROPIC_API_KEY"
echo ""
echo "  2. Start the IBKR gateway in the foreground first, log in once:"
echo "       cd $GATEWAY_DIR && bin/run.sh root/conf.yaml"
echo "     Open https://<vps-ip>:5000 in a browser. Log in with IBKR creds."
echo "     The gateway page will show 'Client login succeeds'."
echo ""
echo "  3. From a separate terminal on the VPS, capture the session token:"
echo "       cd $PROJECT_DIR && npm run auth:ibkr"
echo ""
echo "  4. Now run under PM2 for 24/7 operation:"
echo "       Ctrl+C the foreground gateway."
echo "       cd $PROJECT_DIR && pm2 start ecosystem.config.cjs"
echo "       pm2 save"
echo "       pm2 startup    # follow the printed command to enable on boot"
echo ""
echo "  5. Monitor:"
echo "       pm2 logs gecko-bot"
echo "       pm2 logs ibkr-gateway"
echo "       npm run report"
echo ""
