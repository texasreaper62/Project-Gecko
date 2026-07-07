# Deploying Gecko to a VPS

Tested on Vultr Cloud Compute (Ubuntu 24.04 LTS), New Jersey region.
Should work on any Ubuntu 22.04+ VPS with at least 1 vCPU / 2GB RAM.

## TL;DR

```bash
# On the VPS (as root or a sudo user):
curl -fsSL https://raw.githubusercontent.com/cdayAI/Project-Gecko/main/deploy/setup.sh | bash

# Then edit secrets:
cd ~/project-gecko && cp .env.example .env && nano .env

# Then auth + start (see steps 2-4 below)
```

## What's installed

| Component | Purpose |
|---|---|
| Node.js 20 LTS | Runs the bot |
| PM2 | Process manager, auto-restart on crash, on-boot startup |
| Java 17 JRE | Runs the IBKR Client Portal Gateway |
| IBKR Client Portal Gateway | Holds the authenticated IBKR session locally; bot talks to it at https://localhost:5000 |
| logrotate | Rotates daily logs + jsonl files |
| ufw | Minimal firewall (SSH only inbound) |

## Setup walkthrough

### 0. SSH into the VPS

```bash
ssh root@<your-vps-ip>   # or your IP
```

### 1. Run the bootstrap

```bash
curl -fsSL https://raw.githubusercontent.com/cdayAI/Project-Gecko/main/deploy/setup.sh | bash
```

The script installs everything, clones the repo to `~/project-gecko`, builds,
and unpacks IBKR Gateway to `~/clientportal.gw`. Idempotent — re-run safely.

### 2. Configure secrets

```bash
cd ~/project-gecko
cp .env.example .env
nano .env
```

Required:
- `BROKER=ibkr`
- `ANTHROPIC_API_KEY=sk-ant-...` (your fresh key)
- `IBKR_BASE_URL=https://localhost:5000/v1/api`
- `LIVE_TRADING=false` (start safe; flip to true when validated)
- Optional but recommended: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` for alerts

### 3. First-time IBKR auth (one-time, interactive)

IBKR's Gateway requires a browser-based login the first time. Easiest way:

**Option A — SSH tunnel from your laptop:**

```bash
# On your laptop, NOT the VPS:
ssh -L 5000:localhost:5000 root@<your-vps-ip>
```

Leave that terminal open. On the VPS, start the gateway in the foreground:

```bash
cd ~/clientportal.gw && bin/run.sh root/conf.yaml
```

In your laptop's browser, open `https://localhost:5000`. Accept the self-signed
cert warning. Log in with your IBKR credentials. You should see
"Client login succeeds."

From another VPS terminal:

```bash
cd ~/project-gecko && npm run auth:ibkr
```

This captures the session token to `data/ibkr-tokens.json`. The bot reads
that file at startup.

**Option B — temporarily open port 5000 to your home IP only:**

```bash
sudo ufw allow from <your-home-ip> to any port 5000 proto tcp
```

Then browse directly to `https://<your-vps-ip>:5000` from your machine.
Close the port again after: `sudo ufw delete allow from <your-home-ip> to any port 5000`.

### 4. Start everything under PM2

Once auth is captured:

```bash
cd ~/project-gecko

# Stop the foreground gateway if still running (Ctrl+C in its terminal).

pm2 start ecosystem.config.cjs
pm2 save
pm2 startup    # follow the printed `sudo` command to enable on boot
```

Verify:

```bash
pm2 status
pm2 logs gecko-bot --lines 50
pm2 logs ibkr-gateway --lines 50
```

### 5. Daily ops

```bash
pm2 logs gecko-bot --lines 100         # tail logs
pm2 restart gecko-bot                  # restart bot only
pm2 restart ibkr-gateway               # restart gateway (re-auth may be needed)
pm2 monit                              # ncurses dashboard

cd ~/project-gecko
npm run report                         # P&L attribution
npm run report -- --days=7             # last week
npm run trace                          # signal-by-signal audit
```

### 6. Updating the bot

```bash
cd ~/project-gecko
git pull
npm install
npm run build
pm2 restart gecko-bot
```

## Validation checklist before flipping LIVE_TRADING=true

- [ ] `pm2 status` shows both processes online for 24+ hours without restart loops
- [ ] `pm2 logs ibkr-gateway` shows no "session expired" messages in the last hour
- [ ] `npm run report` shows expected trade flow with brain conviction populated
- [ ] At least 5 days of LIVE_TRADING=false (dry-run) with signals firing
- [ ] Telegram alerts arriving on every signal accept/reject
- [ ] `df -h` shows >5GB free on disk
- [ ] Auto-backups enabled in your provider's console

## Troubleshooting

**Gateway keeps dying with "competing session":**
- Someone else (or another machine) logged into your IBKR account
- Log them out, restart: `pm2 restart ibkr-gateway`

**"No IBKR tokens" on bot start:**
- Run step 3 again — session token expired or got wiped
- Sessions die after ~24 hours of idle; the bot's tickle keepalive prevents this in normal ops

**Bot consuming all RAM:**
- `pm2 restart gecko-bot` will reset
- Inspect `pm2 logs` for memory-pressure indicators
- Consider bumping VPS to 4GB if memory_restart is firing daily

**Anthropic API rate-limited (HTTP 429):**
- Concurrency limiter in agent-brain.ts caps at 4 simultaneous calls
- If still hitting limits, raise to Anthropic's higher tier ($5 minimum, raises ceilings)

## VPS specs notes

Reference instance: 1 vCPU / 2GB RAM / 55GB SSD (Vultr, New Jersey).

For this workload:
- **CPU:** plenty. Bot is I/O bound on Claude calls and Schwab/IBKR API.
- **RAM:** tight. Java IBKR Gateway uses ~400MB, Node.js bot ~250-350MB,
  OS + buffers ~500MB. ~700MB headroom. Watch `free -h` after a week. If
  steady-state usage hits 1.8GB, upgrade to 4GB.
- **Disk:** plenty. Logs + outcomes.jsonl grow ~1-5MB/day.
- **Location:** excellent. NJ datacenter is ~5-15ms to IBKR (Stamford, CT)
  and AWS us-east-1 where Anthropic's API lives.

Total monthly: $8.99 server + ~$5-15 Anthropic API + $0 IBKR API + $0 Yahoo.
