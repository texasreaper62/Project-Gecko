# CLAUDE.md -- Gecko (Equity + Option Day Trading Bot)

## Identity

You are working on **Gecko**, an automated day-trading bot for US equities and short-dated options. This is a live trading system that can handle real money. Precision matters. Do not guess. Do not hallucinate endpoints, parameters, or behavior. If you are unsure about an SDK method or API response shape, say so and verify against current docs before writing code.

## Repository

- **Repo:** `cdayAI/Project-Gecko`
- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 20 LTS (22.x also works)
- **Process manager (deployment):** PM2 on a Linux VPS (see `deploy/README.md`)
- **Primary broker:** Interactive Brokers (IBKR) via Client Portal Web API.
  The Schwab Trader API client stays in the repo as a legacy fallback and can
  be deleted once no longer needed.

## What this system does

Three layers stacked into one bot:

**Engine A -- Opening Range Breakout (equities, the workhorse)**
Premarket scanner finds liquid stocks gapping >2% on news. After 9:30 ET open, the 9:30-9:45 ET high/low defines the opening range. Long breakouts above range high (or short below range low) with stop at the opposite side or VWAP, take profit at 2R, time-stop 11:30 ET. Risk 1% of account per trade.

**Engine B -- 0DTE SPY options (the amplifier)**
Triggers only on strong-trend mornings (SPY moved >1% in first 60 min with breadth confirming). Buys ATM 0DTE SPY calls/puts on pullback to 5-min VWAP. Hard limit: 1-2 contracts per trade, max 2 trades/day. Exit at +50% or -50% or 14:00 ET.

**Intelligence layer**
- **Agent brain (Anthropic Claude API):** validates every candidate trade with full market context before submission, producing a conviction score that gates and sizes entries.
- **LLM premarket classifier:** scores premarket gappers 0-10 for ORB setup quality given news context. Filters universe down to top N candidates. Runs async, doesn't block execution.
- **Self-tuner:** after every N closed trades, recomputes win rates per setup bucket (gap size, VIX regime, time of day) and adjusts thresholds within bounds, with drift detection and walk-forward parameter optimization.

Regulatory note: the SEC eliminated the $25k PDT minimum effective June 4, 2026 (FINRA filing FINRA-2025-017), but brokers have until October 20, 2027 to implement and may still enforce the classic rule. `risk/pdt-tracker.ts` stays as a safety net. **Confirm your broker has implemented the change before running unrestricted day trades.**

## Architecture

```
src/
  index.ts                          # Entry point, orchestrates startup
  core/
    config.ts                       # Loads .env, validates, exports typed AppConfig
    logger.ts                       # Structured JSON logging to stdout
    types.ts                        # Shared interfaces (Instrument, Order, Position, etc.)
  brokers/
    broker.ts                       # Broker-agnostic interface
    factory.ts                      # Selects IBKR or Schwab from config
    ibkr/                           # Primary: Client Portal Web API (REST + WS + session keepalive)
    schwab/                         # Legacy fallback: Trader API (OAuth + REST + streaming)
  data/
    historical.ts                   # Historical bar fetch with caching
    quote-cache.ts                  # In-memory quote cache
    yahoo-historical.ts             # Free historical bars for backtests
  scanner/
    premarket.ts                    # Daily 9:00 ET gap scanner (universe construction)
    options-chain.ts                # 0DTE SPY chain monitor
  intelligence/
    agent-brain.ts                  # Claude validates every trade with full market context
    llm-classifier.ts               # Claude API premarket setup scorer
    news-reader.ts                  # News ingestion for classifier context
    self-tuner.ts                   # Threshold adjuster from realized outcomes
    walk-forward.ts                 # Walk-forward parameter optimizer
    regime-detector.ts              # Market regime classification
    market-internals.ts             # Breadth / TICK / advance-decline
    sector-strength.ts              # Sector relative strength
    confluence.ts                   # Multi-signal confluence scoring
    multi-tf.ts                     # Multi-timeframe alignment
    pattern-matcher.ts              # Historical setup similarity
    economic-calendar.ts            # FOMC/CPI/NFP release awareness
    anthropic-cost-tracker.ts       # API spend tracking
  strategies/
    base.ts                         # Shared Strategy interface
    orb.ts                          # Engine A: Opening Range Breakout
    dte0-spy.ts                     # Engine B: 0DTE SPY scalp
    mean-reversion.ts               # Mean-reversion engine
    earnings-catalyst.ts            # Earnings catalyst engine
    pairs-trader.ts                 # Pairs trading engine
  execution/
    order-builder.ts                # Order construction (equity + single-leg option)
    order-router.ts                 # Submit, monitor, handle retries
    fill-watcher.ts                 # Real-time fill detection
    position-monitor.ts             # Per-position exit management
    position-tracker.ts             # Open positions, cost basis, real-time P&L
  risk/
    risk-manager.ts                 # Per-trade size limit, buying power, kill switch
    daily-stop.ts                   # Account-level loss limit (halt all trading)
    pdt-tracker.ts                  # Day-trade counter (kept post-rule-change as safety)
    position-sizer.ts               # 1%-risk-per-trade math
    conviction-sizer.ts             # Conviction-tiered sizing
    kelly-sizer.ts                  # Kelly-fraction sizing
  backtest/
    runner.ts                       # Event-driven simulator using historical bars
    metrics.ts                      # Sharpe, max DD, win rate, R-multiple distribution
  shadow/
    shadow-broker.ts                # Paper broker for shadow trading
    replay.ts                       # Historical replay harness
    stress-tests.ts                 # Failure-mode stress tests
  monitoring/
    telegram.ts                     # Send alerts via Telegram Bot API
    discord.ts                      # Send alerts via Discord webhook
    daily-report-cli.ts             # End-of-day summary (P&L, trades, attribution)
    trace-cli.ts                    # Signal-by-signal audit trail
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

Do NOT add a web framework, database, ORM, or test framework.

## External APIs

### IBKR Client Portal Web API (primary)

- **Base URL:** `https://localhost:5000/v1/api` (local Client Portal Gateway, Java)
- **Auth:** browser login to the local gateway once; the bot captures the session and keeps it alive with a tickle every 60s. Sessions die after ~6 minutes of inactivity and ~24 hours of idle.
- **Self-signed TLS** on the local gateway is expected.
- **Key endpoints used:** `/iserver/accounts`, `/iserver/secdef/search`, `/iserver/secdef/strikes`, `/iserver/secdef/info`, `/iserver/marketdata/snapshot`, `/iserver/account/{id}/orders`, `/portfolio` endpoints.
- If an IBKR endpoint behaves differently than documented, tell the operator. Do not invent a workaround.

### Schwab Trader API (legacy fallback)

- **Trader base URL:** `https://api.schwabapi.com/trader/v1`
- **Market Data base URL:** `https://api.schwabapi.com/marketdata/v1`
- **OAuth:** `https://api.schwabapi.com/v1/oauth/authorize` and `/v1/oauth/token`
- **Token TTLs:** Access token 30 min, refresh token 7 days HARD WALL. At expiry, full browser re-auth required.
- **Account hash:** `GET /trader/v1/accounts/accountNumbers` returns `hashValue`. Use the hash, not the raw account number, in all subsequent calls.
- **Order placement:** `POST /trader/v1/accounts/{accountHash}/orders` for equities and options, differentiated by `orderStrategyType` + `orderLegCollection`.
- **Streaming:** WS URL from `GET /trader/v1/userPreference`; services `LEVELONE_EQUITIES`, `LEVELONE_OPTIONS`, `ACCT_ACTIVITY`.
- **Order status:** REST is poll-only; use ACCT_ACTIVITY stream for real-time fills.

### Anthropic Claude API (intelligence layer)

- **Direct HTTPS calls** (no SDK dependency); model names configured via `LLM_MODEL` and `LLM_MODEL_BRAIN` in `.env`
- **Used for:** trade validation (agent brain), premarket setup classification, post-trade review, daily reports
- **NOT used for:** intraday entry triggers (latency unacceptable)
- Costs are tracked in `intelligence/anthropic-cost-tracker.ts`

## Coding standards

### TypeScript
- `strict: true`. No `any` except at API boundaries with immediate validation.
- Every function has explicit return types.
- Every interface lives in `core/types.ts` or the module's own `*-types.ts`.
- Use `readonly` on immutable properties.
- Validate every broker API response at the boundary (type guards) -- untyped JSON is the #1 source of bugs.

### Error handling
- WebSocket: auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 60s). Already implemented in `utils/ws-manager.ts`.
- HTTP: 10s timeout default, 3 retry attempts with backoff. Already in `utils/retry.ts`.
- Every async function has try/catch.
- Log full error context: what was attempted, what failed, what the system will do next.
- **Catastrophic failures must trip the kill switch, not crash the bot mid-trade.**

### Logging
- Structured JSON to stdout. PM2 captures.
- Levels: `debug`, `info`, `warn`, `error`. Default `info`.
- Log every: order submit/fill/reject, signal detected, position opened/closed, risk-check decision, auth refresh, websocket connect/disconnect, kill-switch activation.
- Never log: client secrets, access tokens, refresh tokens, session tokens, or raw account numbers (hashes are OK).

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
- No web server. Monitoring via Telegram/Discord and PM2 logs.
- No class hierarchies deeper than one level.
- If a function is under 50 lines and used once, inline it.

## Configuration (.env)

All config in `.env` via `dotenv`. `config.ts` validates on startup and exits on missing required vars. See `.env.example` for the current shape. Required minimum to start: `BROKER=ibkr` and `ANTHROPIC_API_KEY` (or the Schwab credentials when `BROKER=schwab`).

## Validation workflow

1. `npm run build` -- compiles clean after every change
2. `npm run dev` with `LIVE_TRADING=false` -- signals logged, no orders submitted
3. `npm run backtest` / `npm run backtest:yahoo` -- Engine A on 6+ months of bars. Pass: Sharpe > 1.0, max DD < 15%, win rate * R > 0
4. `npm run shadow` and `npm run stress` -- paper execution and failure-mode tests
5. Several days of dry-run, then tiny live positions, before scaling

## Strategy logic details

### Engine A: Opening Range Breakout (ORB)

```
9:00 ET DAILY:
  1. Fetch premarket movers (gap >= 2%, premarket volume >= 500k, price $5-$50)
  2. Filter out: leveraged ETFs, biotechs < $1B mkt cap, OTC, recent bankruptcy
  3. Send each candidate to LLM classifier with recent news -> setup score 0-10
  4. Keep top N (5-15 depending on market regime)
  5. Subscribe to level-one quotes for the universe

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
4. Day-trade counter tracked in `risk/pdt-tracker.ts` even after the SEC PDT rule change -- safety net until the broker confirms implementation
5. Kill switch checked before every order submission
6. Account-balance check before sizing: if cashAvailable < required, refuse trade
7. WebSocket disconnect > 60s -> pause all trading until reconnect

## Data persistence

No database. Append-only JSONL under `data/` (gitignored):
- `data/signals.jsonl` -- every signal generated
- `data/trades.jsonl` -- every executed trade
- `data/outcomes.jsonl` -- closed positions with full P&L attribution
- `data/llm-classifications.jsonl` -- LLM scores for post-hoc analysis
- `data/ibkr-tokens.json` / `data/oauth-tokens.json` -- session/auth tokens (mode 0600, never logged, never committed)

## Testing

No test framework. Validation via:
1. `npm run build` -- compiles clean
2. `npm run dev` -- runs with `LIVE_TRADING=false`, signals logged
3. Backtester runs Engine A on 6+ months of historical data; metrics must clear thresholds
4. Shadow trading and stress tests (`npm run shadow`, `npm run stress`)
5. Several days paper / tiny-live before scaling
6. Manual log inspection daily

## Deployment

See `deploy/README.md` for the full VPS walkthrough (setup script, IBKR Gateway install, PM2 processes, logrotate, firewall).

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
- Do NOT log access tokens, refresh tokens, client secrets, or raw account numbers at any level.
- Do NOT assume a broker API response shape without verifying against current docs or hitting the endpoint once.
- Do NOT use em dashes in comments, logs, or documentation.
- Do NOT modify token files under `data/` directly without taking the bot down first.

## Context files

- `CLAUDE.md` -- this file
- `README.md` -- project overview and quick start
- `.env.example` -- required and optional env vars
- `deploy/README.md` -- VPS deployment walkthrough

## When you get stuck

1. IBKR Client Portal API docs: https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/
2. Schwab Trader API user guides: https://developer.schwab.com/products/trader-api--individual
3. Python reference SDKs (canonical Schwab endpoint shapes): https://github.com/alexgolec/schwab-py and https://github.com/tylerebowers/Schwabdev
4. Anthropic API docs (for the intelligence layer): https://docs.anthropic.com
5. If a broker endpoint behaves differently than expected, tell the operator. Do not invent a workaround.
