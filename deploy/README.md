# Deploying Gecko to a VPS

Tested on Vultr Cloud Compute (Ubuntu 24.04 LTS), New Jersey region.
Should work on any Ubuntu 22.04+ VPS with at least 1 vCPU / 2GB RAM.

## TL;DR

```bash
# On the VPS (as root or a sudo user):
curl -fsSL https://raw.githubusercontent.com/texasreaper62/Project-Gecko/claude/dazzling-pasteur-aerOX/deploy/setup.sh | bash

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
ssh root@45.77.220.39   # or your IP
```

### 1. Run the bootstrap

```bash
curl -fsSL https://raw.githubusercontent.com/texasreaper62/Project-Gecko/claude/dazzling-pasteur-aerOX/deploy/setup.sh | bash
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

IBKR's Gateway requires a browser-based login the first time AND after every gateway restart (the session lives in the Java process's memory and dies with it).

**Important: log out of IBKR everywhere first.** Website, IBKR Mobile, TWS desktop. IBKR allows only one active session per account, and a leftover session on the website will cause "Authorization failed" on the gateway login. Wait ~2 minutes after logging out before retrying.

**Option A — SSH tunnel from your laptop (recommended):**

If the gateway isn't already running under PM2 (first-time install), start it manually first. If it IS running under PM2, skip the foreground start — PM2's instance is on port 5000 already.

```bash
# On your laptop, NOT the VPS:
ssh -L 5000:localhost:5000 root@45.77.220.39
```

Leave that terminal open. Don't type anything else in it — it's just holding the tunnel.

In your laptop's browser, open `https://localhost:5000`:
1. Cert warning → Advanced → Proceed to localhost (unsafe)
2. Toggle **Live** vs **Paper** to match your account type (top-right of the login form)
3. Enter IBKR username + password
4. Approve 2FA if prompted (SMS code or IBKR Key push)
5. **Wait until the page shows "Client login succeeds"** — don't proceed until you see that exact message.

From a separate SSH session on the VPS:

```bash
cd ~/project-gecko && npm run auth:ibkr
```

Press Enter at the prompt. The CLI tickles the gateway and persists the session
sentinel to `data/ibkr-tokens.json`. The bot reads that on startup.

Verify with a direct curl (note: **GET, not POST** — POST returns Akamai HTML "Bad Request"):

```bash
curl -k -sS https://localhost:5000/v1/api/tickle | head -c 400
```

Should return JSON starting with `{"session":"..."` and include `"authenticated":true`.

**Option B — temporarily open port 5000 to your home IP only:**

```bash
sudo ufw allow from <your-home-ip> to any port 5000 proto tcp
```

Then browse directly to `https://45.77.220.39:5000` from your machine.
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
- [ ] Auto-backups enabled in Vultr console (you have this)

## Troubleshooting

**Bot logs `FATAL: IBKR session not authenticated` in a tight restart loop:**
- The gateway has no active session. Either (a) you restarted the gateway and didn't re-login, (b) the session timed out (6 min idle), or (c) browser login was never completed cleanly.
- Fix: `pm2 stop gecko-bot` (stop the bleed), then redo Step 3 above (tunnel + browser login + `npm run auth:ibkr`), then `pm2 start gecko-bot`.

**curl to `https://localhost:5000/v1/api/tickle` returns HTML "Bad Request" / "errors.edgesuite.net":**
- Two possible causes:
  1. You used `-X POST`. The endpoint requires GET — IBKR's Akamai edge rejects POST on `/tickle`, `/iserver/auth/status`, and `/iserver/reauthenticate`. Remove the `-X POST`.
  2. The gateway has no active session (per the previous item). Redo browser login.

**Gateway log shows "competing session" or login UI says "Another session is active":**
- You're logged into IBKR somewhere else (website, IBKR Mobile, TWS). Log out of all of them, wait ~2 minutes, then redo the gateway login.

**Gateway login form returns "Authorization failed" even with correct creds:**
- Almost always a session conflict (see previous). If you just logged into the IBKR website to verify credentials, that website session is now blocking the gateway. Log out of the website first.
- Confirm credentials independently at `https://www.interactivebrokers.com/sso/Login`. If that fails too, it's an IBKR account problem, not ours.

**Bot crashes with `IBKR GET /portfolio//summary: HTTP 401`** (note the empty path component):
- This means `getAccountSnapshot()` was called before `broker.start()` resolved the account ID. `src/index.ts` is supposed to call `broker.start()` immediately after `createBroker()` — verify that ordering hasn't regressed.

**`npm run build` fails with `tsc: not found` or imports can't be resolved:**
- Dev deps weren't installed. The bot runs via `tsx` (devDependency) and builds via `tsc` (devDependency). Don't use `npm ci --omit=dev`. Run `npm install` and rebuild.

**`src/data/*.ts` files keep getting dropped from commits:**
- Check `.gitignore`. The `data/` entry must be anchored to repo root as `/data/`, otherwise it matches `src/data/` too.

**Bot consuming all RAM:**
- `pm2 restart gecko-bot` will reset
- Inspect `pm2 logs` for memory-pressure indicators
- Bump VPS RAM if `memory_restart` fires daily (current 8 GB box has plenty of headroom)

**Anthropic API rate-limited (HTTP 429):**
- Concurrency limiter in agent-brain.ts caps at 4 simultaneous calls
- If still hitting limits, raise to Anthropic's higher tier ($5 minimum, raises ceilings)

## VPS specs notes

Current Vultr instance: **Gecko-Prod, 2 vCPU / 8 GB RAM / 50 GB SSD / New Jersey, $8.99/mo.**

For our workload:
- **CPU:** plenty. Bot is I/O bound on Claude calls and IBKR API.
- **RAM:** comfortable. Java IBKR Gateway uses ~400MB, Node.js bot ~250-350MB,
  OS + buffers ~500MB. Plenty of headroom on 8 GB.
- **Disk:** plenty. Logs + outcomes.jsonl grow ~1-5MB/day.
- **Location:** excellent. NJ datacenter is ~5-15ms to IBKR (Stamford, CT)
  and AWS us-east-1 where Anthropic's API lives.

Total monthly: $8.99 server + ~$5-15 Anthropic API + $0 IBKR API + $0 Yahoo.
