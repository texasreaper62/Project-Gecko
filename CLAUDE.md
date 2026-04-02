# CLAUDE.md -- Project Gecko

## Identity

You are building **Project Gecko**, a prediction market arbitrage trading bot. The operator is Chris Day. This is a live trading system that will handle real money. Precision matters. Do not guess. Do not hallucinate API endpoints, parameters, or behavior. If you are unsure about an SDK method or API response shape, say so and look it up before writing code.

## Repository

- **Repo:** `texasreaper62/Project-Gecko`
- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 20 LTS
- **Target:** Ubuntu 24.04 VPS (Vultr NJ datacenter)
- **Process Manager:** PM2

## What This System Does

Project Gecko runs three arbitrage strategies on prediction markets:

**Module 0 -- Temporal Arbitrage (PRIMARY)**
Polymarket offers 5-minute and 15-minute crypto prediction contracts (e.g., "Will BTC be above $X in 15 minutes?"). These contracts reprice slower than spot markets. When Binance/Coinbase spot price confirms a directional move but Polymarket's contract hasn't caught up, the contract is mispriced. Buy the underpriced side.

**Module 1 -- Cross-Platform Arbitrage**
When the same event trades on Polymarket and Kalshi, price discrepancies create risk-free arb. Buy YES on the cheap platform, buy NO on the expensive platform. If combined cost < $1.00, profit is guaranteed regardless of outcome.

**Module 2 -- Correlated Contract Mispricing**
Within Polymarket, related contracts in multi-outcome events should sum to 100%. When they don't (e.g., all candidates in an election sum to 105%), buy the underpriced combination.

## Architecture

```
src/
  index.ts                    # Entry point, orchestrates startup
  core/
    config.ts                 # Loads .env, validates, exports typed config
    logger.ts                 # Structured JSON logging to stdout
    types.ts                  # All shared interfaces and types
  feeds/
    binance-ws.ts             # BTC/ETH spot price via WebSocket
    coinbase-ws.ts            # BTC/ETH spot price via WebSocket (backup feed)
    polymarket-ws.ts          # Polymarket CLOB market data WebSocket
    polymarket-rest.ts        # Polymarket CLOB REST client (markets, orderbook, pricing)
    feed-aggregator.ts        # Merges all feeds into unified price state
  strategies/
    temporal-arb.ts           # Module 0: spot-vs-contract lag detection
    correlated-contracts.ts   # Module 2: multi-outcome sum checker
    cross-platform.ts         # Module 1: Polymarket vs Kalshi spread
    strategy-types.ts         # Interfaces for opportunities and signals
  execution/
    order-builder.ts          # Constructs Polymarket CLOB orders (EIP-712 signed)
    order-executor.ts         # Submits orders, handles retries, confirms fills
    risk-manager.ts           # Position limits, exposure caps, kill switch
    position-tracker.ts       # Tracks open positions, cost basis, unrealized P&L
  monitoring/
    telegram.ts               # Send alerts via Telegram Bot API
    discord.ts                # Send alerts via Discord webhook
    pnl-tracker.ts            # Realized + unrealized P&L calculation
    health-check.ts           # Checks all dependencies, reports status
    daily-report.ts           # Midnight UTC summary of activity
  utils/
    math.ts                   # Spread calc, probability math, rounding
    retry.ts                  # Exponential backoff wrapper
    ws-manager.ts             # Generic WebSocket with auto-reconnect
    time.ts                   # UTC timestamp helpers
```

## Tech Stack & Dependencies

```json
{
  "dependencies": {
    "@polymarket/clob-client": "latest",
    "@polymarket/order-utils": "latest",
    "ethers": "^6",
    "ws": "^8",
    "dotenv": "^16"
  },
  "devDependencies": {
    "typescript": "^5",
    "ts-node": "^10",
    "@types/node": "^20",
    "@types/ws": "^8"
  }
}
```

Do NOT add dependencies unless strictly necessary. No Express, no database, no ORM. This is a single-process bot, not a web application.

## External APIs

### Polymarket CLOB API

- **Base URL:** `https://clob.polymarket.com`
- **Chain:** Polygon (chain ID 137)
- **SDK:** `@polymarket/clob-client` (TypeScript)
- **Auth:** API Key + Secret + Passphrase (derived from wallet private key via SDK)
- **Docs:** https://docs.polymarket.com/developers/CLOB/introduction

**Key endpoints we use:**
- `GET /markets` -- list all markets
- `GET /midpoint?token_id=X` -- midpoint price for a token
- `GET /price?token_id=X&side=BUY` -- best available price
- `GET /book?token_id=X` -- full order book
- `POST /order` -- place a single order (requires L2 header / API auth)
- `DELETE /order` -- cancel an order
- `GET /data/orders` -- get active orders
- WebSocket `wss://ws-subscriptions-clob.polymarket.com/ws/market` -- real-time price and order book updates

**Gamma API (market discovery, no auth needed):**
- `GET https://gamma-api.polymarket.com/events?closed=false&limit=50&offset=0` -- active events
- `GET https://gamma-api.polymarket.com/markets?active=true` -- active markets

**Rate Limits:**
- General: 5000 req/10s
- `/book`: 200 req/10s
- `/price`: 200 req/10s
- `POST /order`: 240/s burst, 40/s sustained
- `DELETE /order`: 240/s burst, 40/s sustained
- Gamma `/events`: 100 req/10s
- Gamma `/markets`: 125 req/10s

**Order Types:**
- `GTC` (Good-Til-Cancelled) -- limit order, rests on book
- `FOK` (Fill-Or-Kill) -- market order, fill entirely or cancel
- `FAK` (Fill-And-Kill) -- market order, fill what's available, cancel rest
- `GTD` (Good-Til-Date) -- limit with expiration

**Token IDs:** Every market has two token IDs (YES and NO). Get them from the market object's `tokens` array. `tokens[0]` is YES, `tokens[1]` is NO.

**CRITICAL: Polymarket uses USDC.e on Polygon:**
- USDC.e contract: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- 6 decimal places (1 USDC = 1000000 units)

**Neg Risk Markets:** Multi-outcome events (elections, etc.) use the Neg Risk system. These have `neg_risk: true` in the market data. They use different exchange contracts:
- CTF Exchange: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- Neg Risk CTF Exchange: `0xC5d563A36AE78145C45a50134d48A1215220f80a`
- Neg Risk Adapter: `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`

### Binance WebSocket

- **URL:** `wss://stream.binance.com:9443/ws/btcusdt@trade`
- **Combined:** `wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade`
- **No auth required** for public streams
- **Message format:**
```json
{
  "e": "trade",
  "E": 1672000000000,
  "s": "BTCUSDT",
  "t": 123456789,
  "p": "42150.50",
  "q": "0.001",
  "T": 1672000000000,
  "m": true
}
```
- `p` = price (string), `q` = quantity (string), `T` = trade time (ms), `m` = buyer is maker

### Coinbase WebSocket

- **URL:** `wss://ws-feed.exchange.coinbase.com`
- **No auth required** for public channels
- **Subscribe message:**
```json
{
  "type": "subscribe",
  "channels": [
    { "name": "ticker", "product_ids": ["BTC-USD", "ETH-USD"] }
  ]
}
```
- **Ticker message format:**
```json
{
  "type": "ticker",
  "product_id": "BTC-USD",
  "price": "42150.50",
  "time": "2026-03-31T12:00:00.000000Z"
}
```

### Kalshi API

- **Base URL:** `https://api.elections.kalshi.com/trade-api/v2`
- **Auth:** RSA key signing per request
- **Docs:** https://trading-api.readme.io/reference
- Module 1 only. Build Polymarket modules first.

### Telegram Bot API

- **URL:** `https://api.telegram.org/bot{TOKEN}/sendMessage`
- **Payload:** `{ "chat_id": "...", "text": "...", "parse_mode": "HTML" }`

## Coding Standards

### TypeScript

- `strict: true` in tsconfig.json. No `any` types except where interfacing with untyped SDK responses, and even then wrap in a typed function immediately.
- Every function has explicit return types.
- Every interface lives in `types.ts` or the module's own `*-types.ts` file.
- Use `readonly` on properties that should not mutate after construction.

### Error Handling

- Every WebSocket connection MUST have auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 60s).
- Every HTTP request MUST have a timeout (10s default) and retry logic (3 attempts).
- Every `async` function MUST have try/catch. Unhandled rejections crash PM2 and restart the process, which disrupts open positions.
- Log the full error context: what was attempted, what failed, what the system will do next.

### Logging

All logs are structured JSON to stdout. PM2 captures them. Format:

```json
{"ts":"2026-03-31T12:00:00.000Z","level":"info","component":"binance-ws","message":"Connected","data":{}}
```

Log levels: `debug`, `info`, `warn`, `error`. Default level is `info`.

**What to log:**
- Every WebSocket connect, disconnect, reconnect
- Every opportunity detected (with full spread details)
- Every order submitted (with params)
- Every order filled or rejected (with response)
- Every error (with context)
- Every config change or kill switch activation

**What NOT to log:**
- Every raw price tick (too noisy at debug level, never at info)
- Credentials or private keys (NEVER, not even partial)

### Naming Conventions

- Files: `kebab-case.ts`
- Interfaces: `PascalCase`, prefixed with `I` only if it clashes with a class name
- Types: `PascalCase`
- Functions: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Env vars: `UPPER_SNAKE_CASE`

### No Over-Engineering

- No dependency injection framework
- No event bus library (use simple callbacks or EventEmitter from Node stdlib)
- No database (append to JSONL files in `data/`)
- No web server or REST API (monitor via Telegram and PM2 logs)
- No class hierarchies deeper than one level
- If a function is under 50 lines and only used once, inline it

## Configuration (.env)

The bot reads all config from `.env` via `dotenv`. The `config.ts` module validates every required variable on startup and exits with a clear error if anything is missing.

```bash
# Wallet
PRIVATE_KEY=0x...
WALLET_ADDRESS=0x...
FUNDER_ADDRESS=0x...           # Polymarket Safe/proxy address
SIGNATURE_TYPE=0               # 0=EOA, 1=Magic, 2=Browser Proxy

# Polymarket
POLYMARKET_API_KEY=
POLYMARKET_SECRET=
POLYMARKET_PASSPHRASE=
POLYMARKET_CLOB_URL=https://clob.polymarket.com
POLYMARKET_CHAIN_ID=137

# Polygon RPC
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/KEY
POLYGON_WS_URL=wss://polygon-mainnet.g.alchemy.com/v2/KEY

# Feeds
BINANCE_WS_URL=wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade
COINBASE_WS_URL=wss://ws-feed.exchange.coinbase.com

# Kalshi (Module 1, optional until implemented)
KALSHI_API_KEY=
KALSHI_PRIVATE_KEY_PATH=
KALSHI_API_URL=https://api.elections.kalshi.com/trade-api/v2

# Trading
MIN_SPREAD_THRESHOLD=5.0       # Minimum spread % to act
MAX_POSITION_SIZE=50           # Max USDC per trade
MAX_TOTAL_EXPOSURE=1000        # Max total USDC in open positions
MAX_OPEN_POSITIONS=5           # Max concurrent positions
MIN_LIQUIDITY=500              # Min orderbook depth (USDC) to trade
KILL_SWITCH=false              # Emergency stop
LIVE_TRADING=false             # false = scan only, true = execute trades

# Monitoring
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCORD_WEBHOOK_URL=

# Logging
LOG_LEVEL=info
```

## Build Order

Build in this exact sequence. Each step must compile and run before moving to the next.

### Step 1: Core Framework
1. `src/core/types.ts` -- all shared interfaces
2. `src/core/config.ts` -- env loading and validation
3. `src/core/logger.ts` -- structured JSON logger
4. `src/index.ts` -- entry point skeleton (starts, logs, stays alive)
5. Verify: `npm run build && npm run dev` starts without errors

### Step 2: WebSocket Infrastructure
6. `src/utils/ws-manager.ts` -- generic WebSocket wrapper with auto-reconnect, heartbeat, backoff
7. `src/utils/retry.ts` -- HTTP retry wrapper with exponential backoff
8. `src/utils/time.ts` -- UTC timestamp helpers
9. `src/utils/math.ts` -- spread calculation, probability math

### Step 3: Data Feeds
10. `src/feeds/binance-ws.ts` -- connects to Binance, emits BTC/ETH prices
11. `src/feeds/coinbase-ws.ts` -- connects to Coinbase, emits BTC/ETH prices
12. `src/feeds/polymarket-rest.ts` -- fetches active markets, order books, prices
13. `src/feeds/polymarket-ws.ts` -- subscribes to real-time price updates for target markets
14. `src/feeds/feed-aggregator.ts` -- merges spot and prediction market prices into unified state
15. Wire feeds into `index.ts`. Verify: bot connects to all feeds and logs prices.

### Step 4: Strategy Engines
16. `src/strategies/strategy-types.ts` -- opportunity interface, signal types
17. `src/strategies/temporal-arb.ts` -- Module 0. Compares spot price momentum to Polymarket contract prices. Detects when contracts lag spot by more than MIN_SPREAD_THRESHOLD.
18. `src/strategies/correlated-contracts.ts` -- Module 2. Fetches all markets in multi-outcome events. Checks if YES prices across all outcomes sum to != 1.00. Flags mispricing.
19. Wire strategies into `index.ts`. Verify: bot detects and logs opportunities (no execution yet).

### Step 5: Execution Layer
20. `src/execution/risk-manager.ts` -- checks position limits, exposure caps, kill switch before every trade
21. `src/execution/order-builder.ts` -- constructs and signs Polymarket CLOB orders using the SDK
22. `src/execution/order-executor.ts` -- submits orders, handles retries, logs results
23. `src/execution/position-tracker.ts` -- tracks open positions, cost basis, P&L
24. Wire execution into strategies. Verify: with LIVE_TRADING=false, strategies detect and log but don't execute. With LIVE_TRADING=true and a tiny MAX_POSITION_SIZE, execute a real trade.

### Step 6: Monitoring
25. `src/monitoring/telegram.ts` -- sends formatted alerts
26. `src/monitoring/discord.ts` -- sends formatted alerts
27. `src/monitoring/pnl-tracker.ts` -- calculates and reports P&L
28. `src/monitoring/health-check.ts` -- checks all services, wallet balance, reports
29. `src/monitoring/daily-report.ts` -- sends midnight UTC summary
30. Wire monitoring into `index.ts`.

### Step 7: Cross-Platform (Module 1)
31. `src/feeds/kalshi-rest.ts` -- Kalshi market data client
32. `src/strategies/cross-platform.ts` -- compares Polymarket vs Kalshi prices for matching events
33. Event matching logic (fuzzy matching of market questions between platforms)

## Strategy Logic Details

### Module 0: Temporal Arbitrage

```
EVERY 100ms:
  1. Get latest BTC spot price from Binance (and confirm with Coinbase)
  2. Get latest Polymarket contract prices for active 5m/15m BTC markets
  3. Calculate implied probability from spot price momentum:
     - If BTC is at $90,500 and trending up at $50/min
     - And the contract asks "BTC above $90,400 in 15 min?"
     - Then true probability is very high (>85%)
  4. Compare to Polymarket's displayed probability
  5. If delta > MIN_SPREAD_THRESHOLD:
     - Log the opportunity
     - If LIVE_TRADING=true and risk checks pass:
       - Buy the underpriced contract (YES if true prob > market prob)
       - Use FAK order type for immediate fill
       - Track the position
```

**Key constraint:** Only act when BOTH Binance AND Coinbase confirm the price direction. Single-feed signals are not reliable.

**Market discovery:** Scan Polymarket for markets tagged with crypto, specifically those with short duration (5m, 15m). These are found via the Gamma API by filtering events for crypto-related tags and active status.

### Module 2: Correlated Contract Mispricing

```
EVERY 60 seconds:
  1. Fetch all active events from Gamma API
  2. For each event with multiple markets (neg_risk events):
     a. Get the YES price for each outcome
     b. Sum all YES prices
     c. If sum > 1.00 + threshold: SELL opportunity (prices too high)
     d. If sum < 1.00 - threshold: BUY opportunity (prices too low)
  3. For buy opportunities:
     - Buy YES on the most underpriced outcome
  4. For sell opportunities:
     - This requires holding tokens to sell. Skip unless we already hold.
```

### Risk Management Rules

These are hard-coded, not configurable via .env (to prevent accidental override):

1. **Never risk more than MAX_POSITION_SIZE on a single trade** (default $50)
2. **Never exceed MAX_TOTAL_EXPOSURE across all open positions** (default $1000)
3. **Never hold more than MAX_OPEN_POSITIONS concurrent positions** (default 5)
4. **Never trade a market with less than MIN_LIQUIDITY in the order book** (default $500)
5. **If KILL_SWITCH is true, cancel all open orders and refuse new trades**
6. **If any WebSocket feed has been disconnected for >30 seconds, pause all trading**
7. **If the wallet USDC.e balance drops below 10% of starting balance, activate kill switch automatically**
8. **Log every risk check decision (pass or fail) with the reason**

## Data Persistence

No database. Use append-only JSONL (one JSON object per line) files:

- `data/trades.jsonl` -- every executed trade
- `data/opportunities.jsonl` -- every detected opportunity (whether traded or not)
- `data/daily-summary.jsonl` -- daily P&L snapshots

Format for trades:

```json
{"ts":"2026-03-31T12:00:00Z","market":"0x...","side":"BUY","tokenId":"...","price":0.42,"size":50,"orderId":"...","status":"filled","fillPrice":0.42,"fees":0,"pnl":null}
```

## Testing

There is no test framework. Testing is done by:

1. `npm run build` -- compiles without errors
2. `npm run dev` -- runs with LIVE_TRADING=false, connects to all feeds, logs opportunities
3. Manual inspection of logs over 24-48 hours
4. First live trade with MAX_POSITION_SIZE=10 (ten dollars)

If you want to add a test framework later, use Vitest. But do not add it during initial build.

## Deployment

```bash
# On the VPS as botrunner:
cd ~/predictionarb
git pull origin main
npm install
npm run build
pm2 restart predictionarb
pm2 logs predictionarb --lines 20
```

## Things You Must NOT Do

- Do NOT use `console.log` directly. Use the logger.
- Do NOT store state in global variables. Use the config object and typed state containers.
- Do NOT use `setTimeout` for recurring tasks. Use `setInterval` or a proper scheduling loop with drift correction.
- Do NOT catch errors and silently ignore them. Log every error.
- Do NOT import from `dist/`. Always import from `src/` using relative paths.
- Do NOT use `require()`. Use ESM-style `import`.
- Do NOT add a web framework (Express, Fastify, etc.).
- Do NOT add a database.
- Do NOT hardcode any URL, key, or parameter that's in .env.
- Do NOT use `any` without immediately casting to a specific type.
- Do NOT write Python. This entire project is TypeScript.
- Do NOT write code that you cannot verify compiles. Run `npm run build` after significant changes.
- Do NOT log private keys, secrets, or credentials at any log level.
- Do NOT assume an API response shape without checking the SDK types or docs. If unsure, add a runtime check.
- Do NOT use em dashes in comments, logs, or documentation.

## Context Files

The following files in this repo contain detailed context:

- `docs/ops-manual.md` -- full infrastructure setup guide (VPS, wallet, API keys, PM2)
- `docs/research.md` -- market research on prediction market arbitrage (academic papers, documented bot successes, competitive landscape)
- `CLAUDE.md` -- this file

## When You Get Stuck

1. Check Polymarket SDK source: https://github.com/Polymarket/clob-client
2. Check Polymarket Python client for reference implementations: https://github.com/Polymarket/py-clob-client
3. Check Polymarket Rust client: https://github.com/Polymarket/rs-clob-client
4. Check Polymarket docs: https://docs.polymarket.com
5. If an SDK method doesn't exist or behaves differently than expected, tell me. Do not invent a workaround.
