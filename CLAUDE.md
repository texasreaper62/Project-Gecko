# CLAUDE.md -- Project Gecko

## Identity

You are building **Project Gecko**, a prediction market arbitrage trading bot. The operator is Chris Day. This is a live trading system that will handle real money. Precision matters. Do not guess. Do not hallucinate API endpoints, parameters, or behavior. If you are unsure about an SDK method or API response shape, say so and look it up before writing code.

## Reusable patterns (also lifted to ~/.claude/skills/)

Two modules in this repo are the canonical implementations of patterns that other repos consume via user-level skills:

- **WebSocket resilience** (`src/utils/ws-manager.ts`) -- exponential backoff, ping/pong heartbeat, single-message subscription batching, drift correction. Skill: `ws-resilience`.
- **Strict config loader** (`src/core/config.ts`) -- `required()`, `optionalNumber()`, `boundedNumber()`, `validateHex()`. Skill: `config-strict-loader`.

If you change either module's contract, also update the corresponding skill in `~/.claude/skills/`.

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

### Risk Management Rules (hard-coded, not .env-configurable)

1. Never risk more than MAX_POSITION_SIZE on a single trade (default $50)
2. Never exceed MAX_TOTAL_EXPOSURE across all open positions (default $1000)
3. Never hold more than MAX_OPEN_POSITIONS concurrent positions (default 5)
4. Never trade a market with less than MIN_LIQUIDITY in the order book (default $500)
5. If KILL_SWITCH is true, cancel all open orders and refuse new trades
6. If any WebSocket feed has been disconnected for >30 seconds, pause all trading
7. If the wallet USDC.e balance drops below 10% of starting balance, activate kill switch automatically
8. Log every risk check decision (pass or fail) with the reason

## Things You Must NOT Do

- Do NOT use `console.log` directly. Use the logger.
- Do NOT store state in global variables. Use the config object and typed state containers.
- Do NOT use `setTimeout` for recurring tasks. Use `setInterval` or a proper scheduling loop with drift correction.
- Do NOT catch errors and silently ignore them. Log every error.
- Do NOT add a web framework, database, or class hierarchy deeper than one level.
- Do NOT log private keys, secrets, or credentials at any log level.
- Do NOT use em dashes in comments, logs, or documentation.

## Full system documentation

The complete API references, build order, strategy logic, and ops procedures are in `docs/`. This file is the standing rulebook; `docs/` is the manual.
