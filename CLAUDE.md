# CLAUDE.md -- Gecko (Equity + Option Day Trading Bot)

## Identity

You are working on **Gecko**, a personal day-trading bot for US equities and short-dated options, executing through the Charles Schwab Trader API. The operator is Chris Day. This is a live trading system that will handle real money on a $2-10k account. Precision matters. Do not guess. Do not hallucinate endpoints, parameters, or behavior. If you are unsure about an SDK method or API response shape, say so and verify against current docs before writing code.

## Repository

- **Repo:** `texasreaper62/Project-Gecko`
- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 20 LTS (developer uses 22.x; both work)
- **Process manager (deployment):** PM2 on a Linux VPS. Live as of May 22 2026 on Vultr (Gecko-Prod, 45.77.220.39, NJ, Ubuntu 24.04, 2 vCPU / 8 GB RAM / 50 GB SSD).
- **Primary broker:** Interactive Brokers (IBKR) via Client Portal Web API.
  Operator has committed to IBKR. Schwab code stays in the repo as a fallback
  during IBKR account onboarding and can be deleted once IBKR is validated.
- **Active branch:** `claude/dazzling-pasteur-aerOX` (formerly `claude/june-trading-strategy-GOVeW`; merged via PR #2).
- **Previous incarnation:** The `main` branch originally held a Polymarket prediction-market arbitrage bot. That project is shelved; this repo is now the equity/option trading system, and `main` was fast-forwarded over it via PR #2.

## What this system does

Three layers stacked into one bot:

**Engine A -- Opening Range Breakout (equities, the workhorse)**
Premarket scanner finds liquid stocks gapping >2% on news. After 9:30 ET open, the 9:30-9:45 ET high/low defines the opening range. Long breakouts above range high (or short below range low) with stop at the opposite side or VWAP, take profit at 2R, time-stop 11:30 ET. Risk 1% of account per trade.

**Engine B -- 0DTE SPY options (the amplifier)**
Triggers only on strong-trend mornings (SPY moved >1% in first 60 min with breadth confirming). Buys ATM 0DTE SPY calls/puts on pullback to 5-min VWAP. Hard limit: 1-2 contracts per trade, max 2 trades/day. Exit at +50% or -50% or 14:00 ET.

**Intelligence layer**
- **LLM premarket classifier (Anthropic Claude API):** scores premarket gappers 0-10 for ORB setup quality given news context. Filters universe down to top N candidates. Cheap (~$3/day), runs async, doesn't block execution.
- **Self-tuner:** after every N closed trades, recomputes win rates per setup bucket (gap size, VIX regime, time of day) and adjusts thresholds within bounds.

Critical context: the operator needs to grow a $2-10k account in the **June 4 - June 12, 2026** window to fund a SpaceX IPO position. The SEC eliminated the $25k PDT minimum effective June 4, 2026 (confirmed: SEC approval April 14, 2026, FINRA filing FINRA-2025-017). Schwab's deadline to implement is October 20, 2027 -- they may not enable day-one. **This bot is built to take advantage of the rule change, but the operator must confirm Schwab has implemented before running unrestricted day trades.**

## Architecture

```
src/
  index.ts                          # Entry point, orchestrates startup
  core/
    config.ts                       # Loads .env, validates, exports typed AppConfig
    logger.ts                       # Structured JSON logging to stdout
    types.ts                        # Shared interfaces (Instrument, Order, Position, etc.)
  brokers/
    broker.ts                       # Broker interface (broker-agnostic surface)
    factory.ts                      # createBroker(config) picks IBKR or Schwab
    ibkr/                           # Primary broker (live in production)
      auth.ts                       # Session held by local clientportal.gw; tickle every 60s
      auth-cli.ts                   # `npm run auth:ibkr` — captures session after browser login
      rest.ts                       # REST: accounts, portfolio, orders, contracts, chains
      stream.ts                     # WebSocket: market data + account activity
      broker.ts                     # Implements Broker over rest + stream
      types.ts                      # IBKR request/response shapes
    schwab/                         # Fallback, not currently wired into production
      auth.ts                       # OAuth 2.0 + 7-day refresh-token loop
      auth-cli.ts                   # `npm run auth` — initial browser handoff
      rest.ts                       # REST: orders, accounts, balances, chains, price history
      stream.ts                     # WebSocket: LEVELONE_EQUITIES/OPTIONS, ACCT_ACTIVITY
      broker.ts                     # Implements Broker over rest + stream
      types.ts                      # Schwab request/response shapes
  data/
    historical.ts                   # HistoricalBars: SchwabRest pricehistory wrapper, JSONL cache under data/bars/
    quote-cache.ts                  # In-memory last-price cache by equity ticker or OSI option symbol
    yahoo-historical.ts             # Public Yahoo chart endpoint fetcher, cached under data/bars-yahoo/
  scanner/
    premarket.ts                    # Daily 9:00 ET gap scanner (universe construction)
    options-chain.ts                # 0DTE SPY chain monitor
  intelligence/
    llm-classifier.ts               # Claude API premarket setup scorer (Sonnet 4.6 default)
    agent-brain.ts                  # Per-trade Claude validator with market context (Opus 4.7)
    anthropic-cost-tracker.ts       # Token accounting + per-day spend report
    self-tuner.ts                   # Threshold adjuster from realized outcomes + drift detection
    walk-forward.ts                 # Out-of-sample parameter optimizer
    confluence.ts                   # Multi-signal high-accuracy gating
    multi-tf.ts                     # Multi-timeframe validator (1m/5m/15m/60m)
    regime-detector.ts              # SPY/VIX regime tags for adaptive sizing
    sector-strength.ts              # Sector ETF strength tracker
    market-internals.ts             # SPY/VIX + breadth proxies for engine triggers
    economic-calendar.ts            # FOMC/CPI/NFP awareness (skip ORB on macro days)
    news-reader.ts                  # Headline ingest for the classifier
    pattern-matcher.ts              # Worst-trade memory for the brain's self-correction prompt
  strategies/
    base.ts                         # Shared Strategy interface
    orb.ts                          # Engine A: Opening Range Breakout (the workhorse)
    dte0-spy.ts                     # Engine B: 0DTE SPY scalp
    mean-reversion.ts               # Engine C: SPY/QQQ pullback to VWAP
    earnings-catalyst.ts            # Earnings reaction setups
    pairs-trader.ts                 # Pairs reversion (not currently enabled)
  execution/
    order-builder.ts                # Order shape construction (equity + option)
    order-router.ts                 # Submit + monitor; conviction sizing; confluence gating
    position-tracker.ts             # Open positions, cost basis, real-time P&L
    position-monitor.ts             # 2s tick loop: stops, take-profits, time-stops, trail-to-breakeven
    fill-watcher.ts                 # ACCT_ACTIVITY consumer; routes fills to tuner
  risk/
    risk-manager.ts                 # Per-trade size limit, buying power, kill switch
    daily-stop.ts                   # Account-level loss limit (halt all trading)
    pdt-tracker.ts                  # Day-trade counter (kept post-rule-change as safety)
    position-sizer.ts               # 1%-risk-per-trade math
    conviction-sizer.ts             # Per-strategy adaptive tier (low/med/high) from win rate
    kelly-sizer.ts                  # Kelly-criterion sizing for the conviction tiers
  backtest/
    runner.ts                       # Event-driven simulator using HistoricalBars
    backtest-cli.ts                 # `npm run backtest` (Schwab data path)
    backtest-yahoo-cli.ts           # `npm run backtest:yahoo` (no-auth Yahoo path)
    metrics.ts                      # Sharpe, max DD, win rate, R-multiple distribution
    catalyst-test.ts                # SPY 8:30 catalyst-day empirical test
    microscalper-test.ts            # SPY 1-min microscalper signal validity
  shadow/
    replay.ts                       # Historical bars -> shadow ticks
    shadow-broker.ts                # Broker stub for the replay path
    shadow-cli.ts                   # `npm run shadow` end-to-end pipeline replay
    stress-tests.ts                 # `npm run stress` unit checks across sizing/risk/confluence
  monitoring/
    telegram.ts                     # Telegram Bot API alerts
    discord.ts                      # Discord webhook alerts
    daily-report-cli.ts             # `npm run report` P&L attribution dashboard
    trace-cli.ts                    # `npm run trace` per-signal gate audit
  utils/
    ws-manager.ts                   # Generic WebSocket with auto-reconnect (broker-agnostic)
    retry.ts                        # HTTP retry with exponential backoff
    rate-limiter.ts                 # Token-bucket limiter
    persistence.ts                  # JSONL append/read for trades, signals, outcomes
    time.ts                         # ET-aware timestamps and market-hours helpers
    math.ts                         # R-multiple, position sizing, VWAP, ATR

deploy/
  setup.sh                          # Idempotent Ubuntu 24.04 bootstrap (Node, Java, PM2, gateway)
  README.md                         # Step-by-step deploy walkthrough
ecosystem.config.cjs                # PM2 process definitions (ibkr-gateway + gecko-bot)
```

## Tech stack and dependencies

Minimal stable surface:

```json
{
  "dependencies": {
    "dotenv": "^16",
    "ws": "^8"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/ws": "^8",
    "tsx": "^4",
    "typescript": "^5"
  }
}
```

Likely additions during build:
- `@anthropic-ai/sdk` -- Claude API for the LLM classifier
- `schwab-client-js` (slimandslam, MIT, v1.1.3) -- known-good TypeScript wrapper for Schwab REST + OAuth + Streaming. Evaluated alternative to hand-rolling. Use only if it covers our needs cleanly; otherwise wrap the Schwab API directly.
- `zod` -- runtime validation of Schwab API responses (recommended given Schwab's untyped JSON)

Do NOT add a web framework, database, ORM, or test framework during initial build.

## External APIs

### Interactive Brokers Client Portal Web API (primary)

- **Base URL:** `https://localhost:5000/v1/api` (the local Java gateway proxies to IBKR).
- **Gateway binary:** `clientportal.gw` from `https://download2.interactivebrokers.com/portal/clientportal.gw.zip`. Java 17 JRE required. Listens on port 5000 by default; configurable in `root/conf.yaml`.
- **Auth model:** **gateway holds the session in-process.** Bot does NOT send a real OAuth bearer. After the operator does a one-time browser login at `https://localhost:5000` (and sees "Client login succeeds"), the gateway maintains an authenticated channel to IBKR. The bot just calls `/v1/api/*` and the gateway adds the right credentials on outgoing requests.
- **Session lifetime:** dies after **~6 minutes of inactivity** if not tickled. Hard daily cap of ~24 hours; resets at midnight of the IBKR server's nearest timezone (ET for us).
- **`/tickle` — MUST be GET, not POST.** Despite IBKR's reference listing POST, the Akamai edge returns HTML "Bad Request" on POST. Same goes for `/iserver/auth/status` and `/iserver/reauthenticate`. This is the single most painful gotcha in the whole IBKR layer.
- **`/iserver/accounts`** returns the list of trading accounts. **First call MUST be `/iserver/accounts` followed by `POST /iserver/account` with `{ acctId }` to "select" before any `/portfolio/{id}/*` calls work.** `IbkrBroker.start()` does this — and `index.ts` calls `broker.start()` BEFORE any `getAccountSnapshot()`, or the account ID is empty and you get `/portfolio//summary` 401s.
- **Orders:** `POST /iserver/account/{accountId}/orders` with `{ orders: [...] }` envelope. May respond with messages requiring confirmation — POST to `/iserver/reply/{messageId}` with `{ confirmed: true }` (up to 3 hops).
- **Streaming:** WebSocket at `wss://localhost:5000/v1/api/ws`. Subscribe to market data via `smd+{conid}+{fields}` topic. Account activity via `sor`.
- **Contract resolution:** symbols are looked up to internal `conid` integers via `/iserver/secdef/search`. Cached in `IbkrBroker.conidCache` to avoid round-trips on every order.
- **Fees:** $0 commission tiered up to $0.0005/share on US equities; $0.65/contract for options on the IBKR Lite tier.
- **Restart caveat:** killing the gateway process (PM2 restart, crash, reboot) wipes the in-memory session. Operator must redo the browser login + `npm run auth:ibkr` after every gateway restart. The bot's tickle keepalive prevents this in normal ops.

### Schwab Trader API (fallback, not currently wired)

- **Trader base URL:** `https://api.schwabapi.com/trader/v1`
- **Market Data base URL:** `https://api.schwabapi.com/marketdata/v1`
- **OAuth:** `https://api.schwabapi.com/v1/oauth/authorize` and `/v1/oauth/token`
- **Auth header:** `Authorization: Bearer {access_token}`
- **Redirect URI:** MUST be HTTPS. `https://127.0.0.1:8182` is a documented localhost option. Exact match required including trailing slash.
- **Token TTLs:** Access token 30 min, refresh token 7 days HARD WALL. Refresh token stays constant across the 7-day window. At expiry, full browser re-auth required.
- **Account hash:** `GET /trader/v1/accounts/accountNumbers` returns `hashValue`. **Use the hash, not the raw account number, in all subsequent calls.**
- **Order placement:** `POST /trader/v1/accounts/{accountHash}/orders` -- same endpoint for equities, single-leg options, multi-leg spreads, differentiated by `orderStrategyType` + `orderLegCollection`. Order types: `MARKET`, `LIMIT`, `STOP`, `STOP_LIMIT`, `TRAILING_STOP`. Sessions: `NORMAL`, `AM`, `PM`, `SEAMLESS`. Durations: `DAY`, `GOOD_TILL_CANCEL`, `FILL_OR_KILL`.
- **Preview before placing:** `POST /trader/v1/accounts/{accountHash}/previewOrder`. Validate before submit.
- **Option chains:** `GET /marketdata/v1/chains?symbol=SPY&contractType=ALL&strikeCount=20&strategy=SINGLE`. Returns strikes, expirations, bid/ask, Greeks, IV.
- **Historical bars:** `GET /marketdata/v1/pricehistory?symbol=AAPL&periodType=day&period=10&frequencyType=minute&frequency=5`. **One symbol per call.**
- **Streaming WS URL:** dynamic via `GET /trader/v1/userPreference` -> `streamerInfo[0].streamerSocketUrl`.
- **Streaming auth:** after WS connect, send JSON LOGIN: `{ service: "ADMIN", command: "LOGIN", parameters: { Authorization, SchwabClientChannel, SchwabClientFunctionId } }`. Channel/FunctionId from `userPreference`.
- **Streaming services:** `LEVELONE_EQUITIES` (subscribe by uppercase ticker), `LEVELONE_OPTIONS` (subscribe by OSI symbol per contract, no full-chain subscription), `ACCT_ACTIVITY` (order/fill push). Commands: `LOGIN`, `LOGOUT`, `SUBS`, `ADD`, `UNSUBS`, `VIEW`.
- **Order status:** REST is poll-only. Use ACCT_ACTIVITY stream for real-time fill notifications.
- **Fees:** $0 equity commission. $0.65/contract options. $0 exercise/assignment.
- **Rate limits:** 120 req/min/account for POST/PUT/DELETE orders. GET /orders unthrottled per Schwab. Market data ~120/min ceiling (best-guess).
- **Extended hours:** LIMIT orders only. `session: "AM"` (07:00-09:25 ET), `"PM"` (16:05-20:00 ET), `"SEAMLESS"` (regular + extended). Market orders rejected.
- **Sandbox:** synthetic data only, NOT a paper-trading simulator. Useful for plumbing tests, not strategy validation.

### Anthropic Claude API (LLM classifier)

- **SDK:** `@anthropic-ai/sdk`
- **Model default:** `claude-sonnet-4-6` (good cost/intelligence balance for setup scoring)
- **Used for:** premarket setup classification, post-trade review, weekly strategy reports
- **NOT used for:** intraday entry triggers (latency unacceptable)
- **Cost:** ~$3-5/day at this scope

## Coding standards

### TypeScript
- `strict: true`. No `any` except at API boundaries with immediate validation.
- Every function has explicit return types.
- Every interface lives in `core/types.ts` or the module's own `*-types.ts`.
- Use `readonly` on immutable properties.
- Prefer Zod (or hand-rolled type guards) at every Schwab API response boundary -- untyped JSON is the #1 source of bugs.

### Error handling
- WebSocket: auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 60s). Already implemented in `utils/ws-manager.ts`.
- HTTP: 10s timeout default, 3 retry attempts with backoff. Already in `utils/retry.ts`.
- Every async function has try/catch.
- Log full error context: what was attempted, what failed, what the system will do next.
- **Catastrophic failures must trip the kill switch, not crash the bot mid-trade.**

### Logging
- Structured JSON to stdout. PM2 captures.
- Levels: `debug`, `info`, `warn`, `error`. Default `info`.
- Log every: order submit/fill/reject, signal detected, position opened/closed, risk-check decision, OAuth refresh, websocket connect/disconnect, kill-switch activation.
- Never log: Schwab client_secret, access_token, refresh_token, account number (hash is OK).

### Naming
- Files: `kebab-case.ts`
- Interfaces: `PascalCase`
- Types: `PascalCase`
- Functions: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Env vars: `UPPER_SNAKE_CASE`

### No over-engineering
- No DI framework. Plain constructors.
- No event bus library. EventEmitter or callbacks.
- No database. JSONL files under `data/`.
- No web server. Monitoring via Telegram and PM2 logs.
- No class hierarchies deeper than one level.
- If a function is under 50 lines and used once, inline it.

## Configuration (.env)

All config in `.env` via `dotenv`. `config.ts` validates on startup and exits on missing required vars. See `.env.example` for current shape.

**Required minimum (IBKR mode, default):**
- `BROKER=ibkr`
- `ANTHROPIC_API_KEY=sk-ant-...`
- `IBKR_BASE_URL=https://localhost:5000/v1/api`
- `LIVE_TRADING=false` (flip to true only after Step 8 validates)

**Required minimum (Schwab fallback, not currently wired):**
- `BROKER=schwab`, `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`, `SCHWAB_ACCOUNT_HASH`

**Optional but recommended:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL` for alerts.

## Build order

Strictly sequential. Each step compiled and ran before moving on. Steps 1-7 are complete; we're inside Step 8 as of May 22, 2026.

### Step 1: Schwab auth and REST (May 21-22) — DONE
`brokers/schwab/{types,auth,rest}.ts`, CLI smoke test.

### Step 2: Schwab streaming (May 22-23) — DONE
`brokers/schwab/stream.ts`, ACCT_ACTIVITY wired, 5-min SPY quote stream verified.

### Step 3: Risk and execution (May 23-24) — DONE
`risk/*`, `execution/*`. Dry-run signal → risk check → preview order → log.

### Step 4: Strategies (May 24-26) — DONE
`strategies/{base,orb,dte0-spy,mean-reversion,earnings-catalyst,pairs-trader}.ts`, `data/historical.ts`, `scanner/{premarket,options-chain}.ts`.

### Step 5: Intelligence (May 26-28) — DONE
`intelligence/{llm-classifier,agent-brain,self-tuner,walk-forward,confluence,multi-tf,regime-detector,sector-strength,market-internals,economic-calendar,news-reader,pattern-matcher}.ts`.

### Step 6: Backtester (May 28-30) — DONE
`backtest/{runner,metrics,backtest-cli,backtest-yahoo-cli,catalyst-test,microscalper-test}.ts`. Best-config baseline: +29.6% on the equity backtest, win rate ~75% / profit factor 2.42 on the shadow harness.

### Step 7: Monitoring + IBKR broker (May 30 - June 1) — DONE
`monitoring/{telegram,discord,daily-report-cli,trace-cli}.ts`, `brokers/ibkr/*`, broker abstraction (`brokers/broker.ts`, `brokers/factory.ts`).

### Step 7.5: VPS deploy (May 22 evening, unscheduled) — DONE
Vultr server provisioned, `deploy/setup.sh` bootstrap script, PM2 ecosystem, IBKR Gateway installed, browser login captured, bot running with `LIVE_TRADING=false`. Account `U25966327` resolved. Three real bugs surfaced and fixed during deploy (see "Known gotchas" below).

### Step 8: Paper / tiny live (May 23 - June 3) — IN PROGRESS
Live IBKR data + signal generation + order preview only (no submit). Watching for stable tickle keepalive, no spurious 401s, signals firing on real premarket gappers. Bot stays at `LIVE_TRADING=false` here.

### Step 9: Live (June 4-12)
Scale to sized positions based on bankroll and validated win rate. Operator funds the account from $110 (current) to $2-10k. Daily stop, kill switch monitored. PDT rule eliminated June 4 — but IBKR's implementation timing is the live constraint.

## Known gotchas (learned the hard way)

Burned in during the May 22 deploy. Future Claudes: read these before touching the relevant module.

1. **IBKR `/tickle`, `/iserver/auth/status`, `/iserver/reauthenticate` MUST use GET.** IBKR's reference doc says POST; the Akamai edge actually rejects POST with HTML "Bad Request". `src/brokers/ibkr/auth.ts` enforces GET. If you ever see Akamai HTML come back from the gateway, this is the first thing to check.

2. **Startup ordering: `broker.start()` MUST run before `refreshAccount()`.** `IbkrBroker.start()` is what authenticates AND resolves the account ID. If `getAccountSnapshot()` runs first, the URL becomes `/portfolio//summary` (empty account ID between the slashes) and IBKR returns 401. `src/index.ts` calls `broker.start()` immediately after `createBroker()`; the stream handler is wired later and ticks won't arrive until subscriptions are made.

3. **`.gitignore` must anchor `data/` to repo root.** Use `/data/`, not `data/`. The unanchored form matches `src/data/` too, silently dropping the data-layer source files from commits. The May 22 archaeological dig recovered three modules (`historical.ts`, `quote-cache.ts`, `yahoo-historical.ts`) that had been described in commit messages but never actually committed because of this.

4. **`npm install` on the VPS must include dev deps.** The bot runs via `node --import tsx` (tsx is a devDependency), and `npm run build` shells out to `tsc` (also dev). `npm ci --omit=dev` removes exactly the packages we need. `deploy/setup.sh` uses `npm ci` (no `--omit`).

5. **Restarting the IBKR gateway kills the session.** PM2 restart, server reboot, manual `kill` — all wipe the in-memory IBKR session held by the Java process. Operator must redo browser login + `npm run auth:ibkr` after every gateway restart. Document this in the ops runbook; it's the single most common "why is the bot 401'ing" cause.

6. **Don't set `Authorization: Bearer local-gateway` on IBKR calls.** That fake placeholder was getting forwarded to IBKR's edge as an invalid OAuth token. `IbkrAuth.authHeaders()` now suppresses the header when the access-token field is the `local-gateway` sentinel.

7. **`noVNC` clipboard paste mangles multi-line commands.** Always use `ssh root@<ip>` from a real terminal (PowerShell, Terminal, iTerm). The Vultr web console is fine for cloud-init verification only.

## Strategy logic details

### Engine A: Opening Range Breakout (ORB)

```
9:00 ET DAILY:
  1. Fetch premarket movers (gap >= 2%, premarket volume >= 500k, price $5-$50)
  2. Filter out: leveraged ETFs, biotechs < $1B mkt cap, OTC, recent bankruptcy
  3. Send each candidate to LLM classifier with recent news -> setup score 0-10
  4. Keep top N (5-15 depending on market regime)
  5. Subscribe to LEVELONE_EQUITIES for the universe

9:30-9:45 ET:
  6. For each symbol, track high/low of this window -> opening range (OR)
  7. Compute OR width as % of price. Skip if < 0.5% (no momentum) or > 5% (bad R:R)

9:45 ET - 11:30 ET:
  8. On 1-min close > OR high: LONG entry at current ask
     Stop: OR low (or VWAP if tighter)
     Take profit: entry + 2 * (entry - stop) = 2R
     Position size: 1% account / (entry - stop)
  9. Mirror for short on 1-min close < OR low (only if short available in account)
 10. Time-stop at 11:30 ET if not in profit (mean-revert regime starts)
 11. Catastrophic stop: -5R total daily loss -> kill switch
```

**Key constraints:**
- Max 1 trade per symbol per day
- Max 3 concurrent equity positions
- Daily stop at -3% account drawdown

### Engine B: 0DTE SPY scalp

```
9:30-10:30 ET:
  1. Track SPY 1-min bars and breadth (NYSE TICK, advance/decline)
  2. Trigger condition: SPY moved >= 1% from open AND breadth confirms direction

10:30 ET onward (only if triggered):
  3. Wait for SPY pullback to 5-min VWAP in trend direction
  4. On bounce off VWAP: buy ATM 0DTE call (uptrend) or put (downtrend)
  5. Sizing: 1 contract per signal, max 2 trades/day, max 2 concurrent

Exit:
  6. +50% gain -> close
  7. -50% loss -> close
  8. 30 min from entry with no movement -> close
  9. 14:00 ET hard time-stop (gamma chase risk after this)
```

**Key constraints:**
- Engine B disabled if Engine A daily P&L < 0 (no doubling down on a bad day)
- Engine B disabled on FOMC/CPI release days (regime risk)

### Risk management rules (hard-coded, not env-configurable)

1. Per-trade risk capped at `MAX_RISK_PER_TRADE_PCT` of account equity
2. Daily account loss limit: halt all trading at `DAILY_LOSS_LIMIT_PCT` drawdown
3. Max concurrent positions: `MAX_CONCURRENT_EQUITY_POSITIONS` + `MAX_CONCURRENT_OPTION_POSITIONS`
4. Day-trade counter tracked in `risk/pdt-tracker.ts` even though SEC rule eliminated PDT June 4 -- safety net in case Schwab hasn't implemented
5. Kill switch checked before every order submission
6. Account-balance check before sizing: if cashAvailable < required, refuse trade
7. WebSocket disconnect > 60s -> pause all trading until reconnect

## Data persistence

No database. Append-only JSONL under `data/` (the runtime directory, repo-root anchored in `.gitignore` as `/data/`):
- `data/signals.jsonl` -- every signal generated
- `data/trades.jsonl` -- every executed trade
- `data/outcomes.jsonl` -- closed positions with full P&L attribution
- `data/orders.jsonl` -- every order submit/close with flow tag
- `data/llm-classifications.jsonl` -- LLM scores for post-hoc analysis
- `data/anthropic-cost.jsonl` -- per-call token + USD spend
- `data/oauth-tokens.json` -- Schwab access + refresh tokens (mode 0600, never logged)
- `data/ibkr-tokens.json` -- IBKR local-gateway session sentinel (mode 0600, never logged)
- `data/bars/{symbol}_{freq}_{n}.jsonl` -- Schwab historical bar cache
- `data/bars-yahoo/{symbol}_{interval}.jsonl` -- Yahoo historical bar cache

`src/data/*.ts` is SOURCE CODE and tracks in git. The runtime `data/` directory is gitignored. The two are distinguished by the leading slash in `.gitignore`.

## Testing

No test framework during initial build. Validation via:
1. `npm run build` -- compiles clean
2. `npm run dev` -- runs with `LIVE_TRADING=false`, signals logged
3. Backtester runs Engine A on 6+ months of historical data; metrics must clear thresholds
4. 3 days paper / tiny-live before scaling
5. Manual log inspection daily

## Deployment

Production VPS: Vultr Gecko-Prod, 45.77.220.39, Ubuntu 24.04, 2 vCPU / 8 GB / 50 GB, $8.99/mo.

**First-time bootstrap:** see `deploy/README.md`. The script `deploy/setup.sh` installs Node 20, Java 17, PM2, clones the repo, installs deps (including dev — see gotcha #4), builds, downloads IBKR Gateway, sets up logrotate and UFW. Idempotent.

**Update a running bot:**
```bash
cd ~/project-gecko
git pull
npm install
npm run build
pm2 restart gecko-bot
pm2 logs gecko-bot --lines 50
```

**Re-auth IBKR** (after gateway restart, server reboot, or session expiry):
```bash
# From your laptop, in a new PowerShell/terminal:
ssh -L 5000:localhost:5000 root@45.77.220.39
# Then browser → https://localhost:5000 → log in → "Client login succeeds"

# From an SSH session on the VPS:
cd ~/project-gecko && npm run auth:ibkr
pm2 restart gecko-bot
```

**Process layout (`ecosystem.config.cjs`):**
- `ibkr-gateway` — Java process, `bin/run.sh root/conf.yaml`, cwd `~/clientportal.gw`
- `gecko-bot` — Node process, `node --import tsx src/index.ts`, cwd `~/project-gecko`

PM2 saves state on `pm2 save`. `pm2 startup` enables boot-time launch via systemd.

**Schwab note (if reactivated):** the 7-day refresh-token wall is the biggest ops headache there. Weekly browser re-auth, update `data/oauth-tokens.json`, restart.

## Things you must NOT do

- Do NOT use `console.log`. Use the logger.
- Do NOT store mutable state in module globals. Use typed state containers.
- Do NOT catch errors and silently ignore them. Log every error.
- Do NOT import from `dist/`. Always import from `src/` using relative paths with `.js` extensions (NodeNext requirement).
- Do NOT use `require()`. ESM imports only.
- Do NOT add a web framework, database, or ORM.
- Do NOT hardcode any URL, key, or trading parameter that's in `.env` or `AppConfig`.
- Do NOT use `any` without immediately validating to a specific type.
- Do NOT write Python. This is TypeScript end-to-end.
- Do NOT write code without running `npm run build` after changes.
- Do NOT log access_token, refresh_token, client_secret, or raw account numbers at any level.
- Do NOT assume a Schwab API response shape without verifying against current docs or hitting the endpoint once.
- Do NOT use em dashes in comments, logs, or documentation.
- Do NOT modify `data/oauth-tokens.json` directly without taking the bot down first.

## Context files

- `CLAUDE.md` -- this file
- `.env.example` -- required and optional env vars
- `deploy/README.md` -- VPS bootstrap walkthrough
- `deploy/setup.sh` -- idempotent provisioning script
- `ecosystem.config.cjs` -- PM2 process definitions

## When you get stuck

1. IBKR Client Portal Web API docs: https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/
2. IBKR API reference: https://interactivebrokers.github.io/cpwebapi/
3. IBeam (reference impl for headless gateway login): https://github.com/Voyz/ibeam
4. Schwab Trader API user guides: https://developer.schwab.com/products/trader-api--individual
5. TypeScript SDK reference: https://github.com/slimandslam/schwab-client-js
6. Python reference SDKs (canonical endpoint shapes): https://github.com/alexgolec/schwab-py and https://github.com/tylerebowers/Schwabdev
7. Anthropic SDK docs (for the LLM classifier): https://docs.anthropic.com
8. If a broker endpoint behaves differently than expected, tell the operator. Do not invent a workaround.
