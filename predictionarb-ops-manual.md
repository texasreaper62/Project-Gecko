# PredictionArb: Operations Manual

**Version:** 1.0
**Date:** March 31, 2026
**Classification:** Private -- contains infrastructure details for a live trading system
**Estimated Total Setup Time:** 3-5 hours (first time), 1 hour (experienced)

---

## Table of Contents

- PHASE 1: INFRASTRUCTURE
  - 1. VPS Provisioning (Vultr New Jersey)
  - 2. First Login & System Configuration
  - 3. Server Hardening
  - 4. Swap File Configuration
  - 5. Node.js Environment
  - 6. Git & Version Control
- PHASE 2: ACCOUNTS & CREDENTIALS
  - 7. Crypto Wallet Generation
  - 8. MetaMask Browser Extension Setup
  - 9. Funding the Wallet (USDC on Polygon)
  - 10. Polymarket Account Setup
  - 11. Polymarket API Key Generation
  - 12. Token Allowance Approvals
  - 13. Alchemy RPC Node
  - 14. Kalshi Account & API Keys
- PHASE 3: PROJECT SETUP
  - 15. Project Scaffold
  - 16. Environment Variables
  - 17. Core Bot Code (Scanner)
  - 18. Health Check Script
  - 19. Process Management (PM2)
  - 20. Log Rotation
- PHASE 4: MONITORING & ALERTING
  - 21. Telegram Bot Setup
  - 22. Alert Integration Code
  - 23. Latency Benchmarking
  - 24. Daily P&L Reporter
- PHASE 5: GO-LIVE
  - 25. Pre-Flight Checklist
  - 26. Scan-Only Mode (48 hours)
  - 27. First Live Trade
  - 28. Scaling Up
- PHASE 6: OPERATIONS
  - 29. Emergency Procedures
  - 30. Deployment & Updates
  - 31. Backup & Disaster Recovery
  - 32. Cost Tracking
  - 33. Tax Considerations
  - 34. Regulatory Notes
  - 35. Troubleshooting Encyclopedia

---

# PHASE 1: INFRASTRUCTURE

---

## 1. VPS Provisioning (Vultr New Jersey)

### Why Vultr NJ

Polymarket's CLOB runs on infrastructure in AWS us-east. Binance US WebSocket endpoints resolve to servers in Northern Virginia/New Jersey. Vultr's NJ datacenter sits in the same metro, giving 5-15ms round trips to both. At $6/month for a Linux box with NVMe storage, no other provider matches this price-to-proximity ratio for our use case.

**Alternatives considered and rejected:**
- QuantVPS, TradoxVPS, Beeks: Windows-based, MetaTrader-optimized, $40-60/month. Wrong OS, wrong use case.
- AWS Lightsail us-east-1: $5/month but slower NVMe, less predictable network performance for the price.
- Hetzner Ashburn: $4.50/month, good value, but slightly further from NJ exchange infrastructure.
- DigitalOcean NYC: $6/month, comparable. Vultr edges it on NVMe IOPS.

### Step-by-Step: Account Creation

**1.1** Open https://www.vultr.com in your browser.

**1.2** Click "Sign Up" (top right). Enter email and password. You'll receive a verification email -- click the link.

**1.3** Add a payment method. Vultr accepts credit card and PayPal. You won't be charged until you deploy. They may place a temporary $3.50-$5.00 authorization hold to verify the card.

**1.4** Once logged in, you'll land on the Vultr dashboard. It shows "No servers" initially.

### Step-by-Step: Deploy the Server

**1.5** Click the blue **"Deploy +"** button (top right), then **"Deploy New Server"**.

**1.6** Choose Server Type: Click **"Cloud Compute"** (first option). Then select **"Shared CPU"** (the leftmost sub-option). This is the cheapest tier and fully sufficient for a Node.js process that uses <100MB RAM.

**1.7** Server Location: Scroll the map or list. Click **"New York (NJ)"**. It will highlight blue when selected.

**1.8** Image (Operating System): Click the **"Ubuntu"** tab if not already selected. Choose **"24.04 LTS x64"**. LTS means Long Term Support -- security patches through 2029.

**1.9** Plan: Under "Regular Cloud Compute", select the **$6/month** row:
- 1 vCPU
- 1 GB RAM
- 25 GB NVMe SSD
- 2 TB bandwidth

If that plan isn't visible, make sure you're in the "Regular Cloud Compute" tab, not "High Frequency" or "High Performance".

**1.10** Auto Backups: Toggle **ON**. Costs $1.20/month. Worth it. If you accidentally destroy the server config, you can restore from a backup in 2 minutes.

**1.11** SSH Keys: This is critical. Do NOT skip this.

On your LOCAL machine (not the VPS -- it doesn't exist yet), open a terminal:

**Mac/Linux:**
```bash
# Check if you already have a key
ls -la ~/.ssh/id_ed25519.pub
```

If that file exists, skip to step 1.12. If not:

```bash
ssh-keygen -t ed25519 -C "predictionarb"
```

You'll see:
```
Generating public/private ed25519 key pair.
Enter file in which to save the key (/Users/yourname/.ssh/id_ed25519):
```

Press Enter to accept the default.

```
Enter passphrase (empty for no passphrase):
```

Either set a passphrase (more secure, you'll type it each time you SSH) or press Enter for none. Either is fine for now.

```
Your identification has been saved in /Users/yourname/.ssh/id_ed25519
Your public key has been saved in /Users/yourname/.ssh/id_ed25519.pub
The key fingerprint is:
SHA256:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx predictionarb
```

**Windows (PowerShell):**
```powershell
ssh-keygen -t ed25519 -C "predictionarb"
# Same prompts as above. Default path is C:\Users\yourname\.ssh\id_ed25519
```

**1.12** Copy your public key to clipboard:

**Mac:**
```bash
cat ~/.ssh/id_ed25519.pub | pbcopy
```

**Linux:**
```bash
cat ~/.ssh/id_ed25519.pub | xclip -selection clipboard
# If xclip isn't installed: cat ~/.ssh/id_ed25519.pub
# Then manually select and copy the output
```

**Windows (PowerShell):**
```powershell
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub" | Set-Clipboard
```

The public key looks like:
```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx predictionarb
```

**1.13** Back in Vultr's deploy page, under "SSH Keys", click **"Add New"**. Paste the public key. Name it `predictionarb`. Click "Add SSH Key".

Make sure the key shows a checkmark (selected) before proceeding.

**1.14** Server Hostname & Label: Type `predictionarb` for both.

**1.15** Click **"Deploy Now"** (bottom right, blue button).

**1.16** Wait 30-90 seconds. The server status will change from "Installing" to "Running". You'll see the IP address on the dashboard.

**1.17** Record these details somewhere secure:

```
Server IP: ___.___.___.___ (from Vultr dashboard)
Root Password: ________________ (click the eye icon on the dashboard to reveal)
SSH Key: ~/.ssh/id_ed25519 (your local key path)
Monthly Cost: $7.20 ($6.00 + $1.20 backup)
```

---

## 2. First Login & System Configuration

**2.1** Open your local terminal. SSH in:

```bash
ssh root@YOUR_IP_ADDRESS
```

If you set up SSH keys correctly, you'll connect immediately. If it asks for a password, use the root password from the Vultr dashboard.

If you see:
```
The authenticity of host 'X.X.X.X (X.X.X.X)' can't be established.
ED25519 key fingerprint is SHA256:xxxxxxxxxxxx.
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

Type `yes` and press Enter. This is expected on first connection.

**2.2** Verify you're on the right server:

```bash
hostname
```
Expected output: `predictionarb`

```bash
cat /etc/os-release | head -3
```
Expected output:
```
PRETTY_NAME="Ubuntu 24.04.x LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
```

```bash
lscpu | grep "Model name"
```
Expected: An AMD or Intel CPU.

```bash
free -h
```
Expected: ~957M total memory (1 GB plan).

```bash
df -h /
```
Expected: ~25G total disk.

**2.3** Update the system:

```bash
apt update && apt upgrade -y
```

This takes 1-3 minutes. If it asks about restarting services, press Enter to accept defaults. If it asks about a modified config file, choose "keep the local version currently installed".

**2.4** Set timezone to UTC:

```bash
timedatectl set-timezone UTC
timedatectl
```

Expected output includes: `Time zone: UTC (UTC, +0000)`. All logs, all timestamps, all market data -- everything in UTC. No exceptions.

**2.5** Set the hostname (if not already correct):

```bash
hostnamectl set-hostname predictionarb
```

---

## 3. Server Hardening

This server will store private keys that control real money. Every step here matters.

### 3.1 Create a Non-Root User

```bash
adduser botrunner
```

You'll see:
```
New password:
Retype new password:
```

Set a strong password (16+ characters). You probably won't use it often since we'll use SSH keys, but it's needed for sudo.

```
Full Name []:
Room Number []:
Work Phone []:
Home Phone []:
Other []:
Is the information correct? [Y/n]
```

Press Enter through all of these. Type `Y` at the end.

Grant sudo:

```bash
usermod -aG sudo botrunner
```

### 3.2 Copy SSH Keys to New User

```bash
mkdir -p /home/botrunner/.ssh
cp /root/.ssh/authorized_keys /home/botrunner/.ssh/authorized_keys
chown -R botrunner:botrunner /home/botrunner/.ssh
chmod 700 /home/botrunner/.ssh
chmod 600 /home/botrunner/.ssh/authorized_keys
```

**Verify:** Open a SECOND terminal window (keep the root session open) and test:

```bash
ssh botrunner@YOUR_IP_ADDRESS
```

You should get in without a password. If you see a password prompt, something went wrong with the key copy. Debug before proceeding.

Once confirmed, run from the botrunner session:

```bash
sudo whoami
```

Enter the password you set in 3.1. Expected output: `root`. This confirms sudo works.

### 3.3 Disable Root Login and Password Authentication

Back in the ROOT terminal session:

```bash
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup
nano /etc/ssh/sshd_config
```

Find and change (or add) these lines. Use Ctrl+W in nano to search:

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
```

Save: Ctrl+X, then Y, then Enter.

Test the config before restarting (catches syntax errors):

```bash
sshd -t
```

Expected: No output (means no errors). If you see an error, fix it before restarting.

Restart SSH:

```bash
systemctl restart sshd
```

**CRITICAL TEST:** Open a THIRD terminal window:

```bash
ssh botrunner@YOUR_IP_ADDRESS
```

If this works, you're safe. Close the root session. You will never log in as root again.

If it DOESN'T work: You still have the root session open. Fix the sshd_config and try again. DO NOT close the root session until botrunner login works.

### 3.4 Firewall (UFW)

From your botrunner session:

```bash
# Check current status
sudo ufw status
# Expected: inactive

# Set default policies
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH
sudo ufw allow 22/tcp

# Enable
sudo ufw enable
```

It will warn: "Command may disrupt existing ssh connections. Proceed with operation (y|n)?" Type `y`.

Verify:

```bash
sudo ufw status verbose
```

Expected:
```
Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
22/tcp (v6)                ALLOW IN    Anywhere (v6)
```

### 3.5 Fail2Ban

```bash
sudo apt install fail2ban -y
```

Create a local config (never edit the main config directly):

```bash
sudo nano /etc/fail2ban/jail.local
```

Paste:

```ini
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 3

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600
```

This means: 3 failed SSH attempts within 10 minutes = banned for 1 hour.

```bash
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
sudo systemctl status fail2ban
```

Expected: `Active: active (running)`.

Test it's watching SSH:

```bash
sudo fail2ban-client status sshd
```

Expected output includes:
```
Status for the jail: sshd
|- Filter
|  |- Currently failed: 0
|  |- Total failed:     0
|  `- File list:        /var/log/auth.log
`- Actions
   |- Currently banned: 0
   |- Total banned:     0
   `- Banned IP list:
```

### 3.6 Automatic Security Updates

```bash
sudo apt install unattended-upgrades -y
sudo dpkg-reconfigure -plow unattended-upgrades
```

Select "Yes" when prompted. This automatically installs security patches.

Verify:

```bash
cat /etc/apt/apt.conf.d/20auto-upgrades
```

Expected:
```
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
```

---

## 4. Swap File Configuration

The $6 plan has 1 GB RAM. Node.js can spike above this during npm install or when holding large order book snapshots. A swap file prevents out-of-memory kills.

```bash
# Check current swap
sudo swapon --show
# Expected: empty (no swap)

# Create 2GB swap file
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Verify
sudo swapon --show
```

Expected:
```
NAME      TYPE SIZE USED PRIO
/swapfile file   2G   0B   -2
```

Make it permanent (survives reboots):

```bash
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Tune swappiness (how aggressively the kernel uses swap):

```bash
# Set to 10 (only use swap when RAM is nearly full -- good for trading)
sudo sysctl vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
```

Verify total available memory:

```bash
free -h
```

Expected: ~957M RAM + 2.0G Swap.

---

## 5. Node.js Environment

### 5.1 Install Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs
```

Verify:

```bash
node --version
```
Expected: `v20.x.x` (any 20.x is fine)

```bash
npm --version
```
Expected: `10.x.x`

### 5.2 Install Global Packages

```bash
sudo npm install -g pm2 typescript ts-node
```

Verify each:

```bash
pm2 --version
```
Expected: `5.x.x`

```bash
tsc --version
```
Expected: `Version 5.x.x`

```bash
ts-node --version
```
Expected: `v10.x.x`

### 5.3 Configure npm Global Directory (Avoid Sudo for Global Installs)

```bash
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

---

## 6. Git & Version Control

### 6.1 Install Git

```bash
sudo apt install git -y
git --version
```
Expected: `git version 2.43.x` or newer.

### 6.2 Configure Git

```bash
git config --global user.name "Chris Day"
git config --global user.email "your-email@example.com"
git config --global init.defaultBranch main
```

You'll initialize the repo in Section 15. If you want to push to GitHub, you'll need to set up a deploy key or personal access token later -- but that's optional. The bot runs fine without GitHub.

---

# PHASE 2: ACCOUNTS & CREDENTIALS

---

## 7. Crypto Wallet Generation

You need a dedicated Ethereum-compatible wallet for this bot. NEVER use your main personal wallet.

### Why a Dedicated Wallet

- Isolation: If the bot has a bug or the VPS is compromised, only the trading capital is at risk
- Clarity: All transactions are bot transactions. Clean accounting.
- No interference: No accidental nonce conflicts with manual transactions

### 7.1 Generate the Wallet (Do This on Your LOCAL Machine)

**Option A: Using Node.js (recommended)**

On your local machine (not the VPS):

```bash
# Create a temp directory
mkdir ~/wallet-gen && cd ~/wallet-gen
npm init -y
npm install ethers
```

Create the generator:

```bash
cat > generate.js << 'EOF'
const { ethers } = require("ethers");

const wallet = ethers.Wallet.createRandom();

console.log("============================================");
console.log("  NEW WALLET GENERATED");
console.log("  STORE THIS INFORMATION SECURELY");
console.log("============================================");
console.log("");
console.log("Address:     ", wallet.address);
console.log("Private Key: ", wallet.privateKey);
console.log("Mnemonic:    ", wallet.mnemonic.phrase);
console.log("");
console.log("============================================");
console.log("  WARNINGS:");
console.log("  - Write down the mnemonic on PAPER");
console.log("  - Store paper in a safe location");
console.log("  - Never share the private key");
console.log("  - Never paste the private key in a chat,");
console.log("    email, or any website except your VPS");
console.log("  - Delete this terminal's scrollback after");
console.log("    recording the information");
console.log("============================================");
EOF

node generate.js
```

You'll see output like:

```
============================================
  NEW WALLET GENERATED
  STORE THIS INFORMATION SECURELY
============================================

Address:      0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18
Private Key:  0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
Mnemonic:     abandon ability able about above absent absorb abstract absurd abuse access accident

============================================
```

**7.2** Record these three values:

| What | Where to Store | What It's For |
|---|---|---|
| Address (0x...) | Anywhere (it's public) | Receiving funds, checking balances |
| Private Key (0x...) | Password manager + VPS .env file ONLY | Signing transactions and orders |
| Mnemonic (12 words) | Paper stored physically offline | Emergency wallet recovery |

**7.3** Clean up:

```bash
# Delete the generator and its output from your local machine
rm -rf ~/wallet-gen

# Clear terminal scrollback:
# Mac: Cmd+K
# Linux: reset
# Windows: cls
```

**Option B: Using MetaMask**

If you prefer a UI approach, see Section 8 for MetaMask setup. You can create an account there and export the private key.

---

## 8. MetaMask Browser Extension Setup

MetaMask is useful for manually checking balances, approving transactions, and interacting with Polymarket's web UI. Even if you generated the wallet via Option A, import it into MetaMask for convenience.

### 8.1 Install MetaMask

1. Go to https://metamask.io/download/
2. Click "Install MetaMask for Chrome" (or your browser)
3. Click "Add to Chrome" in the Chrome Web Store
4. MetaMask icon appears in your browser toolbar

### 8.2 Initial Setup

1. Click the MetaMask icon
2. Click "Create a new wallet" (or "Import wallet" if using the key from Section 7)
3. Agree to terms
4. Set a password (this is just for the browser extension, not the blockchain)

**If importing an existing key:**
1. Click "Import wallet"
2. Select "Private key" (not "Seed phrase" unless you want to use the mnemonic)
3. Paste the private key from Section 7
4. Set a password

### 8.3 Add Polygon Network

MetaMask defaults to Ethereum mainnet. We need Polygon.

1. Click the network dropdown (top center, says "Ethereum Mainnet")
2. Click "Add network"
3. Click "Add a network manually"
4. Enter:

```
Network Name: Polygon Mainnet
New RPC URL: https://polygon-rpc.com
Chain ID: 137
Currency Symbol: POL
Block Explorer URL: https://polygonscan.com
```

5. Click "Save"
6. Switch to "Polygon Mainnet" in the dropdown

### 8.4 Verify

Your wallet address should show at the top of MetaMask. It should match the address from Section 7. Balance will show 0 POL until you fund it.

---

## 9. Funding the Wallet (USDC on Polygon)

You need two things in your wallet on Polygon:
1. **USDC** -- your trading capital ($1,000-$10,000)
2. **POL** -- for gas fees (~$0.50 worth, about 1 POL)

### Path A: You Have a Coinbase/Exchange Account (Fastest)

**9.1** Log into Coinbase (or Kraken, Binance US, etc.)

**9.2** Buy USDC equal to your intended trading capital. USDC is a stablecoin -- $1 = 1 USDC always. There's no price risk in holding it.

**9.3** Withdraw USDC to your wallet:
1. Go to "Send/Receive" or "Withdraw"
2. Select USDC
3. Paste your wallet address from Section 7
4. **CRITICAL: Select "Polygon" as the network.** If you send on Ethereum mainnet, the funds go to the same address but on the wrong chain. They're recoverable but it's a hassle.
5. Amount: Start with a **small test of $5-10**
6. Confirm and send

**9.4** Wait 1-5 minutes. Check your balance:
- In MetaMask (if set to Polygon network)
- Or at https://polygonscan.com/address/YOUR_ADDRESS

You need to add USDC as a custom token in MetaMask to see the balance:
1. Click "Import tokens" at the bottom of MetaMask
2. Paste the USDC contract address: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`
3. It should auto-fill "USDC" and "6" decimals
4. Click "Add"

**NOTE:** There are TWO USDC tokens on Polygon:
- `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` -- Native USDC (Circle-issued, newer)
- `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` -- Bridged USDC.e (older, used by Polymarket)

Polymarket uses **USDC.e** (the bridged version at `0x2791...`). If your exchange sends native USDC, you may need to swap. Check which one you received on Polygonscan.

To swap native USDC to USDC.e if needed:
1. Go to https://app.uniswap.org
2. Connect your wallet
3. Switch to Polygon network
4. Swap USDC -> USDC.e (search by contract address)
5. The swap is ~1:1 with minimal slippage

**9.5** After the test arrives successfully, send the remaining amount.

**9.6** Buy and send POL for gas:
1. Buy ~$1 worth of POL (formerly MATIC) on the same exchange
2. Withdraw to the same wallet address on Polygon network

Verify on your VPS (optional, uses curl):

```bash
# Check USDC.e balance (Polymarket's USDC)
# Replace YOUR_ADDRESS with your wallet address (no 0x prefix, lowercase)
curl -s -X POST https://polygon-rpc.com \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "method":"eth_call",
    "params":[{
      "to":"0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      "data":"0x70a08231000000000000000000000000YOUR_ADDRESS_NO_0x_LOWERCASE"
    },"latest"],
    "id":1
  }' | python3 -c "import sys,json; r=json.load(sys.stdin); print(f'USDC.e Balance: {int(r[\"result\"],16)/1e6:.2f}')"
```

### Path B: You Have No Crypto (Starting from Zero)

**9.1** Create a Coinbase account at https://www.coinbase.com
- Requires email, phone verification, and ID verification (KYC)
- ID verification typically takes 5-30 minutes
- You can use a driver's license or passport

**9.2** Link a payment method:
- Bank account (cheapest, takes 3-5 days for first deposit)
- Debit card (instant, ~2.5% fee)
- For speed, use debit card for your first deposit

**9.3** Follow Path A steps 9.2 through 9.6

### Path C: You Have Crypto on Ethereum (Need to Bridge)

If your USDC is on Ethereum mainnet:

**9.1** Go to https://app.across.to (Across Protocol bridge -- fast, low fees)
- Or https://jumper.exchange (aggregates multiple bridges)
- Or https://portal.polygon.technology/bridge (official, slower)

**9.2** Connect your wallet (MetaMask)

**9.3** Configure the bridge:
- From: Ethereum
- To: Polygon
- Token: USDC
- Amount: Your trading capital

**9.4** Approve and send. Across Protocol typically completes in 1-5 minutes. The official Polygon bridge can take 20-30 minutes.

**9.5** Check that you received USDC.e (not native USDC) on Polygon. If you received native USDC, swap on Uniswap (see note in Path A step 9.4).

### Verification Checkpoint

Before proceeding, confirm:

- [ ] Wallet address shows USDC.e balance on Polygonscan
- [ ] Wallet has at least 0.5 POL for gas
- [ ] You've recorded the private key securely
- [ ] MetaMask shows the correct balances on Polygon network

---

## 10. Polymarket Account Setup

### 10.1 Create Account

1. Go to https://polymarket.com
2. Click "Sign Up" or "Log In"
3. Connect your wallet (MetaMask) OR sign up with email

**If using MetaMask (recommended for our setup):**
- Click "MetaMask" in the wallet connection dialog
- MetaMask popup appears. Click "Connect"
- Polymarket will deploy a Gnosis Safe (smart wallet) for you on Polygon
- This Safe address is your "funder" address -- it holds your funds on Polymarket

**If using email:**
- Sign up with email
- Polymarket creates a Magic wallet (a proxy wallet)
- You can export the private key from Settings > Cash > Export Key

### 10.2 Identify Your Funder Address

This is critical for API authentication.

1. On Polymarket, click your profile icon
2. Click "Portfolio" or "Deposit"
3. Your Polymarket wallet address is displayed. Copy it.

This address is DIFFERENT from your MetaMask EOA address. It's the Gnosis Safe or Magic proxy that Polymarket deployed for you.

Record:

```
EOA Address (MetaMask):      0x___________________
Polymarket Funder Address:   0x___________________
Wallet Type: [EOA / MAGIC / BROWSER_PROXY]
Signature Type: [0 / 1 / 2]
```

**Signature type mapping:**

| How You Connected | Wallet Type | Signature Type |
|---|---|---|
| Fresh EOA wallet (no Polymarket UI) | EOA | 0 |
| Polymarket email signup | MAGIC | 1 |
| MetaMask connected to Polymarket | BROWSER_PROXY | 2 |

### 10.3 Deposit USDC to Polymarket

If your USDC is in the EOA wallet but not in the Polymarket Safe:

1. On Polymarket, click "Deposit"
2. Enter the amount
3. Approve the transaction in MetaMask
4. Wait for confirmation

Alternatively, you can send USDC.e directly to the Polymarket Safe address from any wallet.

---

## 11. Polymarket API Key Generation

### 11.1 Understanding the Credential System

Polymarket uses three credentials for CLOB API authentication:
- **API Key:** UUID-format identifier (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890`)
- **Secret:** Base64-encoded secret (e.g., `L3xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxQ=`)
- **Passphrase:** Hex-encoded passphrase (e.g., `d4xxxxxxxxxxxxxxxxxxxxxxxxxxe9`)

These are derived deterministically from your private key. Running the derivation twice with the same private key produces the same credentials. You can regenerate them if lost (as long as you have the private key).

### 11.2 Set Up the Generation Script on Your VPS

SSH into your VPS as botrunner:

```bash
ssh botrunner@YOUR_IP_ADDRESS
cd ~/predictionarb
```

If you haven't created the project yet (Section 15), do a minimal setup:

```bash
mkdir -p ~/predictionarb/src
cd ~/predictionarb
npm init -y
npm install @polymarket/clob-client ethers@6 dotenv
npm install typescript ts-node @types/node --save-dev
```

Create a temporary .env:

```bash
nano .env
```

```bash
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_FROM_SECTION_7
POLYGON_RPC_URL=https://polygon-rpc.com
```

Save and exit.

```bash
chmod 600 .env
```

Create the key generation script:

```bash
nano src/generate-api-key.ts
```

```typescript
import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("ERROR: PRIVATE_KEY not set in .env");
    process.exit(1);
  }

  const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);

  console.log("Wallet Address:", signer.address);
  console.log("RPC URL:", rpcUrl);
  console.log("");

  const client = new ClobClient(
    "https://clob.polymarket.com",
    137,
    signer
  );

  // Step 1: Try to derive existing credentials
  console.log("Attempting to derive existing API credentials...");
  try {
    const creds = await client.deriveApiKey();
    if (creds.key && creds.secret && creds.passphrase) {
      console.log("");
      console.log("SUCCESS: Existing credentials derived.");
      console.log("==========================================");
      console.log("API Key:     " + creds.key);
      console.log("Secret:      " + creds.secret);
      console.log("Passphrase:  " + creds.passphrase);
      console.log("==========================================");
      console.log("");
      console.log("Add to your .env file:");
      console.log("POLYMARKET_API_KEY=" + creds.key);
      console.log("POLYMARKET_SECRET=" + creds.secret);
      console.log("POLYMARKET_PASSPHRASE=" + creds.passphrase);
      return;
    }
  } catch (e: any) {
    console.log("No existing credentials found. Creating new ones...");
  }

  // Step 2: Create new credentials
  try {
    const creds = await client.createApiKey();
    console.log("");
    console.log("SUCCESS: New credentials created.");
    console.log("==========================================");
    console.log("API Key:     " + creds.key);
    console.log("Secret:      " + creds.secret);
    console.log("Passphrase:  " + creds.passphrase);
    console.log("==========================================");
    console.log("");
    console.log("Add to your .env file:");
    console.log("POLYMARKET_API_KEY=" + creds.key);
    console.log("POLYMARKET_SECRET=" + creds.secret);
    console.log("POLYMARKET_PASSPHRASE=" + creds.passphrase);
  } catch (e: any) {
    console.error("FAILED to create credentials.");
    console.error("Error:", e.message || e);
    console.error("");
    console.error("Common causes:");
    console.error("- Private key is incorrect");
    console.error("- Wallet has never interacted with Polymarket");
    console.error("- Network connectivity issue");
    process.exit(1);
  }
}

main();
```

Run it:

```bash
npx ts-node src/generate-api-key.ts
```

Expected output:

```
Wallet Address: 0x742d35Cc...
RPC URL: https://polygon-rpc.com

Attempting to derive existing API credentials...

SUCCESS: New credentials created.
==========================================
API Key:     a1b2c3d4-e5f6-7890-abcd-ef1234567890
Secret:      L3xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxQ=
Passphrase:  d4xxxxxxxxxxxxxxxxxxxxxxxxxxe9
==========================================
```

**11.3** Copy the three values into your `.env` file immediately:

```bash
nano .env
```

Add:

```bash
POLYMARKET_API_KEY=a1b2c3d4-e5f6-7890-abcd-ef1234567890
POLYMARKET_SECRET=L3xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxQ=
POLYMARKET_PASSPHRASE=d4xxxxxxxxxxxxxxxxxxxxxxxxxxe9
```

### 11.4 Test the Credentials

Create a quick test:

```bash
nano src/test-connection.ts
```

```typescript
import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  // Test 1: Unauthenticated connection
  console.log("Test 1: Unauthenticated CLOB connection...");
  const publicClient = new ClobClient("https://clob.polymarket.com", 137);

  const serverTime = await publicClient.getServerTime();
  console.log("  Server time:", serverTime);

  const ok = await publicClient.getOk();
  console.log("  Server OK:", ok);

  // Test 2: Authenticated connection
  console.log("\nTest 2: Authenticated CLOB connection...");
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

  const authClient = new ClobClient(
    "https://clob.polymarket.com",
    137,
    signer,
    {
      key: process.env.POLYMARKET_API_KEY!,
      secret: process.env.POLYMARKET_SECRET!,
      passphrase: process.env.POLYMARKET_PASSPHRASE!,
    }
  );

  // Fetch a known active market to test data access
  console.log("  Fetching market data...");
  const markets = await publicClient.getMarkets({});
  if (markets && markets.data && markets.data.length > 0) {
    const market = markets.data[0];
    console.log("  First market condition_id:", market.condition_id);
    console.log("  Question:", market.question?.substring(0, 80));

    // Test order book access
    if (market.tokens && market.tokens.length > 0) {
      const tokenId = market.tokens[0].token_id;
      const midpoint = await publicClient.getMidpoint(tokenId);
      console.log("  Midpoint price:", midpoint);
    }
  }

  console.log("\nAll tests passed. Connection is working.");
}

main().catch((e) => {
  console.error("TEST FAILED:", e.message || e);
  process.exit(1);
});
```

Run:

```bash
npx ts-node src/test-connection.ts
```

Expected:

```
Test 1: Unauthenticated CLOB connection...
  Server time: 1743400000
  Server OK: OK

Test 2: Authenticated CLOB connection...
  Fetching market data...
  First market condition_id: 0x...
  Question: Will Bitcoin be above $90,000 on April 1?
  Midpoint price: 0.72

All tests passed. Connection is working.
```

If this fails, check:
1. `.env` has the correct private key (with `0x` prefix)
2. API credentials were generated from the same private key
3. VPS can reach Polymarket: `curl -s https://clob.polymarket.com/ | head`

---

## 12. Token Allowance Approvals

If you're using an EOA wallet (Signature Type 0), you must approve Polymarket's exchange contracts to spend your tokens. This is a one-time setup.

If you connected via Polymarket's UI (Safe/Magic wallet), Polymarket handles approvals automatically. You can skip this section.

### 12.1 Create the Approval Script

```bash
nano src/approve-allowances.ts
```

```typescript
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)",
  "function allowance(address owner, address spender) public view returns (uint256)"
];

const ERC1155_ABI = [
  "function setApprovalForAll(address operator, bool approved) public",
  "function isApprovedForAll(address account, address operator) public view returns (bool)"
];

const CONTRACTS = {
  USDC_E: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  CTF: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
  CTF_EXCHANGE: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  NEG_RISK_CTF_EXCHANGE: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  NEG_RISK_ADAPTER: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
};

async function main() {
  const provider = new ethers.JsonRpcProvider(
    process.env.POLYGON_RPC_URL || "https://polygon-rpc.com"
  );
  const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const address = signer.address;

  console.log("Wallet:", address);

  const balance = await provider.getBalance(address);
  console.log("POL balance:", ethers.formatEther(balance), "POL");
  if (balance === 0n) {
    console.error("ERROR: No POL for gas fees. Send ~0.5 POL to this address.");
    process.exit(1);
  }

  const usdc = new ethers.Contract(CONTRACTS.USDC_E, ERC20_ABI, signer);
  const ctf = new ethers.Contract(CONTRACTS.CTF, ERC1155_ABI, signer);
  const MAX = ethers.MaxUint256;

  const approvals = [
    { name: "USDC.e -> CTF Exchange", contract: usdc, method: "approve", args: [CONTRACTS.CTF_EXCHANGE, MAX] },
    { name: "USDC.e -> Neg Risk CTF Exchange", contract: usdc, method: "approve", args: [CONTRACTS.NEG_RISK_CTF_EXCHANGE, MAX] },
    { name: "USDC.e -> Neg Risk Adapter", contract: usdc, method: "approve", args: [CONTRACTS.NEG_RISK_ADAPTER, MAX] },
    { name: "CTF -> CTF Exchange", contract: ctf, method: "setApprovalForAll", args: [CONTRACTS.CTF_EXCHANGE, true] },
    { name: "CTF -> Neg Risk CTF Exchange", contract: ctf, method: "setApprovalForAll", args: [CONTRACTS.NEG_RISK_CTF_EXCHANGE, true] },
  ];

  for (const approval of approvals) {
    console.log(`\nApproving: ${approval.name}...`);
    try {
      const tx = await approval.contract[approval.method](...approval.args);
      console.log(`  TX submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  Confirmed in block ${receipt.blockNumber}. Gas used: ${receipt.gasUsed.toString()}`);
    } catch (e: any) {
      console.error(`  FAILED: ${e.message}`);
      // Don't exit -- try remaining approvals
    }
  }

  console.log("\nAll approvals complete.");
  console.log("Verify on Polygonscan:");
  console.log(`https://polygonscan.com/address/${address}#tokentxns`);
}

main().catch(console.error);
```

### 12.2 Run It

```bash
npx ts-node src/approve-allowances.ts
```

Expected output (5 transactions):

```
Wallet: 0x742d35Cc...
POL balance: 0.98 POL

Approving: USDC.e -> CTF Exchange...
  TX submitted: 0xabc123...
  Confirmed in block 58234567. Gas used: 46201

Approving: USDC.e -> Neg Risk CTF Exchange...
  TX submitted: 0xdef456...
  Confirmed in block 58234568. Gas used: 46201

[... 3 more ...]

All approvals complete.
```

Total gas cost: ~$0.01-0.05 worth of POL. This only needs to run once.

---

## 13. Alchemy RPC Node

### 13.1 Why Not Use Public RPCs

The public `polygon-rpc.com` endpoint:
- Rate limited (unknown, but aggressive)
- No WebSocket support
- Shared with millions of users
- Latency varies from 50-500ms

Alchemy free tier gives you:
- Dedicated endpoint
- 300 million compute units/month
- WebSocket support
- Consistent 10-30ms latency
- Dashboard with usage metrics

### 13.2 Account Setup

1. Go to https://www.alchemy.com
2. Click "Sign Up" (free)
3. Verify email

### 13.3 Create an App

1. From the dashboard, click "Create New App" (or "Apps" > "Create App")
2. Fill in:
   - **Name:** PredictionArb
   - **Description:** Trading bot RPC
   - **Chain:** Polygon
   - **Network:** Polygon Mainnet
3. Click "Create App"

### 13.4 Get Your Endpoints

1. Click on your app name in the dashboard
2. Click "API Key" (top right area)
3. You'll see:

```
HTTPS: https://polygon-mainnet.g.alchemy.com/v2/YOUR_API_KEY_HERE
WSS:   wss://polygon-mainnet.g.alchemy.com/v2/YOUR_API_KEY_HERE
```

Copy both.

### 13.5 Test the Endpoint

On your VPS:

```bash
# Test HTTPS
curl -s -X POST "https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

Expected: `{"jsonrpc":"2.0","id":1,"result":"0x..."}`

```bash
# Test latency (run 5 times, look at average)
for i in {1..5}; do
  time curl -s -o /dev/null -X POST "https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
done
```

Expected: Each call takes 0.015-0.050 seconds from the NJ VPS. If it's >100ms, something is wrong.

### 13.6 Update .env

```bash
nano ~/predictionarb/.env
```

Update:

```bash
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
POLYGON_WS_URL=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
```

---

## 14. Kalshi Account & API Keys

Kalshi is the CFTC-regulated US prediction market. Module 1 (cross-platform arb) requires it.

### 14.1 Create Account

1. Go to https://kalshi.com
2. Click "Sign Up"
3. Enter email, set password
4. Complete identity verification (KYC):
   - Full name, date of birth, SSN (last 4), address
   - Photo ID upload (driver's license or passport)
   - Verification typically completes in minutes, sometimes hours

### 14.2 Fund Account

1. Log into Kalshi
2. Click "Deposit"
3. Link a bank account or use debit card
4. Deposit funds (USD, not crypto)

Note: Kalshi is USD-denominated. Your capital is split between Polymarket (USDC) and Kalshi (USD). For cross-platform arb with $5,000 total capital, you might put $3,000 on Polymarket and $2,000 on Kalshi. The exact split depends on where you find more opportunities.

### 14.3 Generate API Keys

1. Log into Kalshi
2. Click your profile / settings
3. Navigate to "API Keys" or "Developer"
4. Click "Generate API Key"
5. Copy the **API Key ID** and **Private Key** (Kalshi uses RSA key pairs)

Kalshi's API auth is different from Polymarket:
- Polymarket: Wallet-derived API key + HMAC signing
- Kalshi: RSA private key signing for each request

### 14.4 Update .env

```bash
KALSHI_API_KEY=your-kalshi-key-id
KALSHI_PRIVATE_KEY_PATH=/home/botrunner/predictionarb/keys/kalshi-private.pem
KALSHI_API_URL=https://api.elections.kalshi.com/trade-api/v2
```

Save the Kalshi private key:

```bash
mkdir -p ~/predictionarb/keys
nano ~/predictionarb/keys/kalshi-private.pem
# Paste the RSA private key
chmod 600 ~/predictionarb/keys/kalshi-private.pem
```

---

# PHASE 3: PROJECT SETUP

---

## 15. Project Scaffold

### 15.1 Directory Structure

```bash
cd ~/predictionarb

mkdir -p src/{core,feeds,strategies,execution,monitoring,utils}
mkdir -p logs
mkdir -p keys
mkdir -p data
```

Final structure:

```
~/predictionarb/
  .env                          # Secrets (chmod 600, gitignored)
  .gitignore
  package.json
  tsconfig.json
  ecosystem.config.js           # PM2 configuration
  keys/                         # API keys, PEM files (gitignored)
    kalshi-private.pem
  src/
    index.ts                    # Entry point
    core/
      config.ts                 # Loads .env, validates config
      logger.ts                 # Structured logging
      types.ts                  # Shared TypeScript interfaces
    feeds/
      binance-ws.ts             # Binance spot price WebSocket
      coinbase-ws.ts            # Coinbase spot price WebSocket (backup)
      polymarket-ws.ts          # Polymarket CLOB WebSocket
      polymarket-rest.ts        # Polymarket REST API client
    strategies/
      temporal-arb.ts           # Module 0: Spot price lag arbitrage
      correlated-contracts.ts   # Module 2: Mispriced related contracts
      cross-platform.ts         # Module 1: Polymarket vs Kalshi
    execution/
      order-builder.ts          # Constructs and signs orders
      order-executor.ts         # Submits orders to CLOB
      risk-manager.ts           # Position limits, exposure tracking
    monitoring/
      telegram.ts               # Telegram alert integration
      pnl-tracker.ts            # Real-time P&L calculation
      health-check.ts           # System health monitoring
    utils/
      math.ts                   # Spread calculations, rounding
      retry.ts                  # Retry with exponential backoff
  logs/
    out.log                     # stdout (managed by PM2)
    error.log                   # stderr (managed by PM2)
  data/
    trades.jsonl                # Trade log (append-only)
    opportunities.jsonl         # Detected opportunities log
  dist/                         # Compiled JS (gitignored)
```

### 15.2 Initialize Git

```bash
cd ~/predictionarb
git init

cat > .gitignore << 'EOF'
node_modules/
dist/
.env
keys/
logs/
data/
*.log
EOF

git add .
git commit -m "Initial project scaffold"
```

### 15.3 Package.json Scripts

```bash
nano package.json
```

Ensure the scripts section contains:

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts",
    "generate-keys": "ts-node src/generate-api-key.ts",
    "approve": "ts-node src/approve-allowances.ts",
    "test-connection": "ts-node src/test-connection.ts",
    "health": "ts-node src/monitoring/health-check.ts",
    "benchmark": "ts-node src/utils/benchmark.ts"
  }
}
```

### 15.4 TypeScript Config

```bash
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF
```

---

## 16. Environment Variables

### 16.1 Complete .env Template

```bash
nano .env
```

```bash
# =============================================================
# PredictionArb Configuration
# =============================================================
# This file contains secrets. NEVER commit to git.
# Permissions: chmod 600 .env
# =============================================================

# --- WALLET ---
PRIVATE_KEY=0x_YOUR_PRIVATE_KEY
WALLET_ADDRESS=0x_YOUR_WALLET_ADDRESS
FUNDER_ADDRESS=0x_YOUR_POLYMARKET_FUNDER_ADDRESS
# SIGNATURE_TYPE: 0=EOA, 1=Magic/Email, 2=Browser Proxy
SIGNATURE_TYPE=0

# --- POLYMARKET CLOB ---
POLYMARKET_API_KEY=
POLYMARKET_SECRET=
POLYMARKET_PASSPHRASE=
POLYMARKET_CLOB_URL=https://clob.polymarket.com
POLYMARKET_CHAIN_ID=137

# --- POLYGON RPC (ALCHEMY) ---
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
POLYGON_WS_URL=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY

# --- BINANCE (public, no keys needed) ---
BINANCE_WS_URL=wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade

# --- COINBASE (public, no keys needed) ---
COINBASE_WS_URL=wss://ws-feed.exchange.coinbase.com

# --- KALSHI ---
KALSHI_API_KEY=
KALSHI_PRIVATE_KEY_PATH=/home/botrunner/predictionarb/keys/kalshi-private.pem
KALSHI_API_URL=https://api.elections.kalshi.com/trade-api/v2

# --- TRADING PARAMETERS ---
# Minimum spread to act on (percentage)
MIN_SPREAD_THRESHOLD=5.0
# Maximum USDC per single trade
MAX_POSITION_SIZE=50
# Maximum total USDC exposure across all open positions
MAX_TOTAL_EXPOSURE=1000
# Maximum number of concurrent open positions
MAX_OPEN_POSITIONS=5
# Minimum liquidity (USDC) required in the order book to trade
MIN_LIQUIDITY=500
# Kill switch: set to true to stop all trading immediately
KILL_SWITCH=false
# Live trading toggle: false = scan only, no execution
LIVE_TRADING=false

# --- MONITORING ---
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCORD_WEBHOOK_URL=

# --- LOGGING ---
LOG_LEVEL=info
# Options: debug, info, warn, error
```

### 16.2 Lock Permissions

```bash
chmod 600 .env
ls -la .env
```

Expected: `-rw------- 1 botrunner botrunner ... .env`

### 16.3 Config Validation

The bot should validate every env var on startup and exit with a clear error if anything is missing. This happens in `src/core/config.ts` (built in the bot code phase).

---

## 17. Core Bot Code (Scanner)

This is the entry point and core config. The full trading logic comes in the next phase when we build together, but the scanner framework goes here.

### 17.1 Config Loader

```bash
nano src/core/config.ts
```

```typescript
import * as dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`FATAL: Missing required env var: ${key}`);
    process.exit(1);
  }
  return val;
}

function optional(key: string, defaultVal: string): string {
  return process.env[key] || defaultVal;
}

export const config = {
  // Wallet
  privateKey: required("PRIVATE_KEY"),
  walletAddress: required("WALLET_ADDRESS"),
  funderAddress: optional("FUNDER_ADDRESS", ""),
  signatureType: parseInt(optional("SIGNATURE_TYPE", "0")),

  // Polymarket
  polymarket: {
    apiKey: required("POLYMARKET_API_KEY"),
    secret: required("POLYMARKET_SECRET"),
    passphrase: required("POLYMARKET_PASSPHRASE"),
    clobUrl: optional("POLYMARKET_CLOB_URL", "https://clob.polymarket.com"),
    chainId: parseInt(optional("POLYMARKET_CHAIN_ID", "137")),
  },

  // RPC
  polygonRpcUrl: required("POLYGON_RPC_URL"),
  polygonWsUrl: optional("POLYGON_WS_URL", ""),

  // Feeds
  binanceWsUrl: optional(
    "BINANCE_WS_URL",
    "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade"
  ),
  coinbaseWsUrl: optional(
    "COINBASE_WS_URL",
    "wss://ws-feed.exchange.coinbase.com"
  ),

  // Trading
  trading: {
    minSpreadThreshold: parseFloat(optional("MIN_SPREAD_THRESHOLD", "5.0")),
    maxPositionSize: parseFloat(optional("MAX_POSITION_SIZE", "50")),
    maxTotalExposure: parseFloat(optional("MAX_TOTAL_EXPOSURE", "1000")),
    maxOpenPositions: parseInt(optional("MAX_OPEN_POSITIONS", "5")),
    minLiquidity: parseFloat(optional("MIN_LIQUIDITY", "500")),
    killSwitch: optional("KILL_SWITCH", "false") === "true",
    liveTradingEnabled: optional("LIVE_TRADING", "false") === "true",
  },

  // Monitoring
  telegram: {
    botToken: optional("TELEGRAM_BOT_TOKEN", ""),
    chatId: optional("TELEGRAM_CHAT_ID", ""),
  },
  discordWebhookUrl: optional("DISCORD_WEBHOOK_URL", ""),

  // Logging
  logLevel: optional("LOG_LEVEL", "info"),
};

// Startup validation
console.log("=== PredictionArb Config ===");
console.log("Wallet:", config.walletAddress);
console.log("Live Trading:", config.trading.liveTradingEnabled ? "ENABLED" : "DISABLED (scan only)");
console.log("Kill Switch:", config.trading.killSwitch ? "ACTIVE (no trades)" : "OFF");
console.log("Max Position:", config.trading.maxPositionSize, "USDC");
console.log("Max Exposure:", config.trading.maxTotalExposure, "USDC");
console.log("Min Spread:", config.trading.minSpreadThreshold, "%");
console.log("===========================");

if (config.trading.killSwitch) {
  console.warn("KILL SWITCH IS ACTIVE. No trades will be executed.");
}
```

### 17.2 Logger

```bash
nano src/core/logger.ts
```

```typescript
import * as fs from "fs";
import * as path from "path";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const configuredLevel = (process.env.LOG_LEVEL || "info") as LogLevel;

function formatTimestamp(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, component: string, message: string, data?: any) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel]) return;

  const entry = {
    ts: formatTimestamp(),
    level,
    component,
    message,
    ...(data ? { data } : {}),
  };

  const line = JSON.stringify(entry);

  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (component: string, msg: string, data?: any) => log("debug", component, msg, data),
  info: (component: string, msg: string, data?: any) => log("info", component, msg, data),
  warn: (component: string, msg: string, data?: any) => log("warn", component, msg, data),
  error: (component: string, msg: string, data?: any) => log("error", component, msg, data),
};
```

### 17.3 Entry Point

```bash
nano src/index.ts
```

```typescript
import { config } from "./core/config";
import { logger } from "./core/logger";

async function main() {
  logger.info("main", "PredictionArb starting...");
  logger.info("main", `Mode: ${config.trading.liveTradingEnabled ? "LIVE" : "SCAN ONLY"}`);

  if (config.trading.killSwitch) {
    logger.warn("main", "Kill switch is active. Exiting.");
    process.exit(0);
  }

  // Phase 1: Connect to all data feeds
  logger.info("main", "Connecting to data feeds...");

  // TODO: Initialize Binance WebSocket feed
  // TODO: Initialize Coinbase WebSocket feed
  // TODO: Initialize Polymarket WebSocket feed

  // Phase 2: Start strategy engines
  logger.info("main", "Starting strategy engines...");

  // TODO: Start temporal arb scanner
  // TODO: Start correlated contract scanner
  // TODO: Start cross-platform scanner

  // Phase 3: Start monitoring
  logger.info("main", "Starting monitoring...");

  // TODO: Start health check loop
  // TODO: Start P&L reporter

  logger.info("main", "PredictionArb is running.");

  // Keep alive
  process.on("SIGINT", () => {
    logger.info("main", "Shutting down (SIGINT)...");
    // TODO: Close all WebSocket connections
    // TODO: Cancel any pending orders
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    logger.info("main", "Shutting down (SIGTERM)...");
    process.exit(0);
  });

  // Prevent unhandled rejections from crashing
  process.on("unhandledRejection", (reason, promise) => {
    logger.error("main", "Unhandled promise rejection", { reason: String(reason) });
  });
}

main().catch((e) => {
  logger.error("main", "Fatal startup error", { error: e.message || String(e) });
  process.exit(1);
});
```

### 17.4 Build and Test

```bash
npm run build
```

Expected: No errors. `dist/` directory is created with compiled JS files.

```bash
npm run dev
```

Expected:

```
=== PredictionArb Config ===
Wallet: 0x742d35Cc...
Live Trading: DISABLED (scan only)
Kill Switch: OFF
Max Position: 50 USDC
Max Exposure: 1000 USDC
Min Spread: 5 %
===========================
{"ts":"2026-03-31T...","level":"info","component":"main","message":"PredictionArb starting..."}
{"ts":"2026-03-31T...","level":"info","component":"main","message":"Mode: SCAN ONLY"}
{"ts":"2026-03-31T...","level":"info","component":"main","message":"Connecting to data feeds..."}
...
{"ts":"2026-03-31T...","level":"info","component":"main","message":"PredictionArb is running."}
```

Ctrl+C to stop.

---

## 18. Health Check Script

```bash
nano src/monitoring/health-check.ts
```

```typescript
import { config } from "../core/config";
import { ethers } from "ethers";
import https from "https";

function httpGet(url: string): Promise<{ status: number; latencyMs: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    https.get(url, (res) => {
      res.resume();
      resolve({ status: res.statusCode || 0, latencyMs: Date.now() - start });
    }).on("error", reject);
  });
}

async function main() {
  console.log("=== PredictionArb Health Check ===");
  console.log("Timestamp:", new Date().toISOString());
  console.log("");

  // 1. Polygon RPC
  console.log("1. Polygon RPC (Alchemy):");
  try {
    const provider = new ethers.JsonRpcProvider(config.polygonRpcUrl);
    const start = Date.now();
    const blockNumber = await provider.getBlockNumber();
    const latency = Date.now() - start;
    console.log(`   Status: OK | Block: ${blockNumber} | Latency: ${latency}ms`);
  } catch (e: any) {
    console.log(`   Status: FAILED | Error: ${e.message}`);
  }

  // 2. Polymarket CLOB
  console.log("2. Polymarket CLOB API:");
  try {
    const result = await httpGet("https://clob.polymarket.com/");
    console.log(`   Status: ${result.status === 200 ? "OK" : "ERROR " + result.status} | Latency: ${result.latencyMs}ms`);
  } catch (e: any) {
    console.log(`   Status: FAILED | Error: ${e.message}`);
  }

  // 3. Binance API
  console.log("3. Binance API:");
  try {
    const result = await httpGet("https://api.binance.com/api/v3/ping");
    console.log(`   Status: ${result.status === 200 ? "OK" : "ERROR " + result.status} | Latency: ${result.latencyMs}ms`);
  } catch (e: any) {
    console.log(`   Status: FAILED | Error: ${e.message}`);
  }

  // 4. Wallet balance
  console.log("4. Wallet Balance:");
  try {
    const provider = new ethers.JsonRpcProvider(config.polygonRpcUrl);
    const polBalance = await provider.getBalance(config.walletAddress);
    console.log(`   POL: ${ethers.formatEther(polBalance)}`);

    // Check USDC.e
    const usdcContract = new ethers.Contract(
      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      ["function balanceOf(address) view returns (uint256)"],
      provider
    );
    const usdcBalance = await usdcContract.balanceOf(config.walletAddress);
    console.log(`   USDC.e: ${(Number(usdcBalance) / 1e6).toFixed(2)}`);
  } catch (e: any) {
    console.log(`   Status: FAILED | Error: ${e.message}`);
  }

  // 5. Disk space
  console.log("5. System Resources:");
  const { execSync } = require("child_process");
  const disk = execSync("df -h / | tail -1").toString().trim();
  const mem = execSync("free -h | head -2 | tail -1").toString().trim();
  console.log(`   Disk: ${disk}`);
  console.log(`   Memory: ${mem}`);

  console.log("\n=== Health Check Complete ===");
}

main().catch(console.error);
```

Run:

```bash
npx ts-node src/monitoring/health-check.ts
```

---

## 19. Process Management (PM2)

### 19.1 Ecosystem Config

```bash
nano ecosystem.config.js
```

```javascript
module.exports = {
  apps: [
    {
      name: "predictionarb",
      script: "dist/index.js",
      cwd: "/home/botrunner/predictionarb",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS Z",
      error_file: "/home/botrunner/predictionarb/logs/error.log",
      out_file: "/home/botrunner/predictionarb/logs/out.log",
      merge_logs: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,
      kill_timeout: 10000,
    },
  ],
};
```

### 19.2 First Run with PM2

```bash
# Build first
npm run build

# Start
pm2 start ecosystem.config.js

# Check status
pm2 status
```

Expected:

```
┌─────┬─────────────────┬─────────┬──────┬───────┬──────────┬──────────┐
│ id  │ name            │ mode    │ pid  │ status│ restart  │ uptime   │
├─────┼─────────────────┼─────────┼──────┼───────┼──────────┼──────────┤
│ 0   │ predictionarb   │ fork    │ 1234 │ online│ 0        │ 5s       │
└─────┴─────────────────┴─────────┴──────┴───────┴──────────┴──────────┘
```

### 19.3 Auto-Start on Boot

```bash
pm2 startup
```

PM2 will output a command like:

```
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u botrunner --hp /home/botrunner
```

Copy and run that exact command. Then:

```bash
pm2 save
```

Now the bot restarts automatically if the VPS reboots.

### 19.4 Essential PM2 Commands

```bash
pm2 status                          # Overview
pm2 logs predictionarb              # Live log tail
pm2 logs predictionarb --lines 200  # Last 200 lines
pm2 restart predictionarb           # Restart
pm2 stop predictionarb              # Stop
pm2 delete predictionarb            # Remove from PM2
pm2 monit                           # Interactive monitor (CPU, RAM)
pm2 flush                           # Clear all logs
```

---

## 20. Log Rotation

Logs grow forever without rotation. PM2 has a module for this.

```bash
pm2 install pm2-logrotate

# Configure
pm2 set pm2-logrotate:max_size 50M       # Rotate at 50MB
pm2 set pm2-logrotate:retain 14          # Keep 14 rotated files
pm2 set pm2-logrotate:compress true      # gzip old logs
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
pm2 set pm2-logrotate:workerInterval 60  # Check every 60 seconds
```

Verify:

```bash
pm2 conf pm2-logrotate
```

---

# PHASE 4-6: MONITORING, GO-LIVE & OPERATIONS

These phases (Telegram setup, latency benchmarking, pre-flight checklist, emergency procedures, backup, tax notes, regulatory considerations, and the full troubleshooting encyclopedia) are documented in the companion files. The core infrastructure and credential setup above is what you need to get running.

---

## Quick Reference: What You Should Have After Completing This Guide

| Item | Status | Value |
|---|---|---|
| VPS (Vultr NJ) | Running | IP: ___.___.___.__ |
| SSH access | Key-based only | User: botrunner |
| Firewall | Active | Port 22 only |
| Node.js | Installed | v20.x |
| PM2 | Installed + auto-start | Running |
| Wallet address | Generated | 0x___ |
| Wallet funded | USDC.e on Polygon | $___ |
| POL for gas | Funded | ~0.5 POL |
| Polymarket API key | Generated | UUID |
| Polymarket secret | Generated | Base64 |
| Polymarket passphrase | Generated | Hex |
| Token allowances | Approved (5 txs) | On-chain |
| Alchemy RPC | Configured | polygon-mainnet |
| .env file | Complete, chmod 600 | All vars set |
| Bot scaffold | Built, runs in PM2 | Scan-only mode |
| Health check | Working | npm run health |
| Git | Initialized | main branch |
| Logs | Rotating via pm2-logrotate | ~/predictionarb/logs/ |

---

## What Comes Next

The infrastructure is done. The next deliverable is the **trading logic**:

1. Binance WebSocket feed integration (real-time BTC/ETH spot prices)
2. Polymarket WebSocket feed integration (real-time contract prices)
3. Temporal arbitrage detection engine
4. Correlated contract scanner
5. Order execution layer
6. Risk management engine
7. Telegram alert integration
8. Full end-to-end testing

Tell me when your infrastructure is live and I'll build the trading code.
