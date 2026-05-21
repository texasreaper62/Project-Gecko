# CLAUDE.md -- Gecko (Equity + Option Day Trading Bot)

## Identity

You are working on **Gecko**, a personal day-trading bot for US equities and short-dated options, executing through the Charles Schwab Trader API. The operator is Chris Day. This is a live trading system that will handle real money on a $2-10k account. Precision matters. Do not guess. Do not hallucinate endpoints, parameters, or behavior. If you are unsure about an SDK method or API response shape, say so and verify against current docs before writing code.

## Repository

- **Repo:** `texasreaper62/Project-Gecko`
- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 20 LTS (developer uses 22.x; both work)
- **Process manager (deployment):** PM2 on a Linux VPS (to be provisioned)
- **Primary broker:** Interactive Brokers (IBKR) via Client Portal Web API.
  Operator has committed to IBKR. Schwab code stays in the repo as a fallback
  during IBKR account onboarding and can be deleted once IBKR is validated.
- **Previous incarnation:** The `main` branch holds the Polymarket prediction-market arbitrage bot this codebase used to be. That project is shelved; this branch (`claude/june-trading-strategy-GOVeW`) is the new equity/option trading system.

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
  brokers/schwab/
    auth.ts                         # OAuth 2.0 flow + 7-day refresh token loop + browser re-auth helper
    rest.ts                         # REST: orders, accounts, positions, balances, option chains, price history
    stream.ts                       # WebSocket: LEVELONE_EQUITIES, LEVELONE_OPTIONS, ACCT_ACTIVITY
    types.ts                        # Schwab-specific request/response shapes
  data/
    historical.ts                   # /pricehistory wrapper with caching
    cache.ts                        # Local JSONL cache for bars and chains
  scanner/
    premarket.ts                    # Daily 9:00 ET gap scanner (universe construction)
    options-chain.ts                # 0DTE SPY chain monitor
  intelligence/
    llm-classifier.ts               # Claude API premarket setup scorer
    self-tuner.ts                   # Threshold adjuster from realized outcomes
    features.ts                     # Feature extraction for buckets/scoring
  strategies/
    base.ts                         # Shared Strategy interface
    orb.ts                          # Engine A: Opening Range Breakout
    dte0-spy.ts                     # Engine B: 0DTE SPY scalp
  execution/
    equity-order.ts                 # Equity order construction
    option-order.ts                 # Option order construction (single-leg ATM)
    order-router.ts                 # Submit, monitor via ACCT_ACTIVITY, handle retries
    position-tracker.ts             # Open positions, cost basis, real-time P&L
  risk/
    risk-manager.ts                 # Per-trade size limit, buying power, kill switch
    daily-stop.ts                   # Account-level loss limit (halt all trading)
    pdt-tracker.ts                  # Day-trade counter (kept post-rule-change as safety)
    position-sizer.ts               # 1%-risk-per-trade math
  backtest/
    runner.ts                       # Event-driven simulator using historical bars
    metrics.ts                      # Sharpe, max DD, win rate, R-multiple distribution
  monitoring/
    telegram.ts                     # Send alerts via Telegram Bot API
    discord.ts                      # Send alerts via Discord webhook
    pnl-tracker.ts                  # Realized + unrealized P&L
    health-check.ts                 # Schwab API, stream, account state
    daily-report.ts                 # End-of-day summary (P&L, trades, mistakes)
  utils/
    ws-manager.ts                   # Generic WebSocket with auto-reconnect (broker-agnostic)
    retry.ts                        # HTTP retry with exponential backoff
    rate-limiter.ts                 # Token-bucket limiter
    persistence.ts                  # JSONL append/read for trades, signals, outcomes
    time.ts                         # ET-aware timestamps and market-hours helpers
    math.ts                         # R-multiple, position sizing, VWAP, ATR
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

### Schwab Trader API (post-TD Ameritrade)

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

All config in `.env` via `dotenv`. `config.ts` validates on startup and exits on missing required vars. See `.env.example` for current shape. Required minimum to start: `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`, `SCHWAB_ACCOUNT_HASH`.

## Build order

Strictly sequential. Each step compiles and runs before moving on.

### Step 1: Schwab auth and REST (May 21-22)
1. `brokers/schwab/types.ts` -- request/response shapes
2. `brokers/schwab/auth.ts` -- OAuth flow, browser handoff, refresh loop, token persistence
3. `brokers/schwab/rest.ts` -- account hash lookup, account/balances, place/cancel order, preview, chains, price history
4. CLI smoke test: load auth, fetch account, fetch one option chain, fetch one historical bar series.

### Step 2: Schwab streaming (May 22-23)
5. `brokers/schwab/stream.ts` -- WS connect via userPreference, LOGIN, SUBS for LEVELONE_EQUITIES + LEVELONE_OPTIONS + ACCT_ACTIVITY
6. Wire ACCT_ACTIVITY into a "real-time order status" channel
7. Smoke test: stream SPY quotes for 5 minutes, log throughput

### Step 3: Risk and execution (May 23-24)
8. `risk/risk-manager.ts`, `risk/daily-stop.ts`, `risk/pdt-tracker.ts`, `risk/position-sizer.ts`
9. `execution/equity-order.ts`, `execution/option-order.ts`, `execution/order-router.ts`, `execution/position-tracker.ts`
10. Dry-run: signal -> risk check -> preview order -> log (no submit)

### Step 4: Strategies (May 24-26)
11. `strategies/base.ts` -- shared interface
12. `data/historical.ts` -- bar fetch + cache
13. `scanner/premarket.ts` -- gap scanner
14. `strategies/orb.ts` -- Engine A
15. `scanner/options-chain.ts` -- 0DTE SPY chain monitor
16. `strategies/dte0-spy.ts` -- Engine B

### Step 5: Intelligence (May 26-28)
17. `intelligence/features.ts` -- feature extraction
18. `intelligence/llm-classifier.ts` -- Claude API integration
19. `intelligence/self-tuner.ts` -- threshold adjustment from outcomes

### Step 6: Backtester (May 28-30)
20. `backtest/runner.ts` -- event-driven sim from historical bars
21. `backtest/metrics.ts` -- Sharpe, max DD, R distribution
22. Run Engine A backtest on 6 months of bars. Tune parameters. Pass: Sharpe > 1.0, max DD < 15%, win rate * R > 0.

### Step 7: Monitoring (May 30 - June 1)
23. `monitoring/pnl-tracker.ts`, `health-check.ts`, `daily-report.ts`
24. Wire Telegram + Discord notifications

### Step 8: Paper / tiny live (June 1-3)
25. Paper-trade equivalent: live data + signal generation + order preview only (no submit)
26. Tiny live: $5-25 positions with full execution, verify ACCT_ACTIVITY fill loop end-to-end

### Step 9: Live (June 4-12)
27. Scale to sized positions based on bankroll and validated win rate. Daily stop, kill switch monitored.

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

No database. Append-only JSONL under `data/`:
- `data/signals.jsonl` -- every signal generated
- `data/trades.jsonl` -- every executed trade
- `data/outcomes.jsonl` -- closed positions with full P&L attribution
- `data/llm-classifications.jsonl` -- LLM scores for post-hoc analysis
- `data/oauth-tokens.json` -- current access + refresh tokens (mode 0600, never logged)

## Testing

No test framework during initial build. Validation via:
1. `npm run build` -- compiles clean
2. `npm run dev` -- runs with `LIVE_TRADING=false`, signals logged
3. Backtester runs Engine A on 6+ months of historical data; metrics must clear thresholds
4. 3 days paper / tiny-live before scaling
5. Manual log inspection daily

## Deployment

VPS deployment (TBD provisioning):
```bash
cd ~/gecko
git pull origin claude/june-trading-strategy-GOVeW
npm install
npm run build
pm2 restart gecko
pm2 logs gecko --lines 50
```

The 7-day Schwab refresh-token wall is the biggest ops headache: a weekly browser re-auth is required, then update `data/oauth-tokens.json`, then `pm2 restart gecko`.

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

## When you get stuck

1. Schwab Trader API user guides: https://developer.schwab.com/products/trader-api--individual
2. TypeScript SDK reference: https://github.com/slimandslam/schwab-client-js
3. Python reference SDKs (canonical endpoint shapes): https://github.com/alexgolec/schwab-py and https://github.com/tylerebowers/Schwabdev
4. Anthropic SDK docs (for the LLM classifier): https://docs.anthropic.com
5. If a Schwab endpoint behaves differently than expected, tell the operator. Do not invent a workaround.
