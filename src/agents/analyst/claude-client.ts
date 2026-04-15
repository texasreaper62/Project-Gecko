/**
 * ANALYST: Claude API Client
 *
 * Sends opportunities to Claude for deep analysis.
 * Uses Haiku for fast triage, Sonnet for deep analysis.
 *
 * The key principle: Claude reasons freely in natural language.
 * The output is parsed into typed StrategyActions.
 * Claude NEVER sees the constraint rules.
 */

import { createLogger } from '../../core/logger.js';
import { withRetry } from '../../utils/retry.js';
import type { Opportunity, AccountState } from '../../core/types.js';
import { getStrategyStats } from '../recorder/trade-recorder.js';

const log = createLogger('analyst-claude');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-6';

interface ClaudeResponse {
  content: Array<{ type: string; text: string }>;
}

interface AnalysisResult {
  shouldTrade: boolean;
  conviction: number;      // 0-100
  side: 'BUY' | 'SELL';
  rationale: string;
  suggestedStopPercent: number;
  suggestedTargetPercent: number;
  suggestedHoldDays: number;
  instrumentPreference: 'SHARES' | 'OPTIONS';
  risks: string[];
}

// ============================================================
// CLAUDE API CALL
// ============================================================

async function callClaude(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as ClaudeResponse;
  return data.content[0]?.text ?? '';
}

// ============================================================
// ANALYSIS PROMPTS
// ============================================================

const SYSTEM_PROMPT = `You are a financial analyst evaluating trading opportunities. You will be given data about a potential trade.

Respond ONLY with a JSON object (no markdown, no explanation outside the JSON) with these fields:
{
  "shouldTrade": true/false,
  "conviction": 0-100,
  "side": "BUY" or "SELL",
  "rationale": "2-3 sentence explanation",
  "suggestedStopPercent": number (e.g., 0.08 for 8% stop),
  "suggestedTargetPercent": number (e.g., 0.15 for 15% target),
  "suggestedHoldDays": number,
  "instrumentPreference": "SHARES" or "OPTIONS",
  "risks": ["risk1", "risk2"]
}

Be conservative. Only recommend trades where you have genuine conviction based on the data provided. A conviction score of 60 means marginal. 70 means decent. 80+ means strong.`;

function buildSpinoffPrompt(opp: Opportunity, stats: ReturnType<typeof getStrategyStats>): string {
  return `SPIN-OFF OPPORTUNITY

Company: ${opp.ticker}
Filing: ${opp.data.formType}
Filed: ${opp.data.filedAt}
Entity: ${opp.data.entityName}
EDGAR URL: ${opp.sourceUrl ?? 'N/A'}

Summary: ${opp.summary}

Historical strategy performance (our track record):
- Total trades: ${stats.totalTrades}
- Win rate: ${(stats.winRate * 100).toFixed(1)}%
- Profit factor: ${stats.profitFactor.toFixed(2)}
- Average win: $${stats.avgWin.toFixed(2)}
- Average loss: $${stats.avgLoss.toFixed(2)}

Evaluate this spin-off opportunity. Consider:
1. Is this a new spin-off or an amendment to an existing filing?
2. Spin-offs where index funds must sell the new entity have historically outperformed by 7-10% in the first 12 months.
3. The best spin-off opportunities are small companies spun from large parents where forced selling is strongest.
4. What are the key risks?`;
}

function buildRegShoPrompt(opp: Opportunity, stats: ReturnType<typeof getStrategyStats>): string {
  return `REG SHO THRESHOLD LIST OPPORTUNITY

Stock: ${opp.ticker}
Exchange: ${opp.data.exchange}
Days on list: ${opp.data.daysOnList}
Forced covering deadline: ${opp.data.remainingDays} settlement days

Summary: ${opp.summary}

Historical strategy performance:
- Total trades: ${stats.totalTrades}
- Win rate: ${(stats.winRate * 100).toFixed(1)}%
- Profit factor: ${stats.profitFactor.toFixed(2)}

Evaluate this forced-covering opportunity. Consider:
1. Stocks on the threshold list must have FTDs > 10,000 shares AND > 0.5% of float for 5 consecutive days.
2. Mandatory buy-to-cover must happen within 13 settlement days.
3. Historical studies show 2-4% abnormal returns over 10 trading days for threshold list additions.
4. However, these stocks are heavily shorted for a reason. What might make this stock a value trap?
5. Is the stock liquid enough to trade without excessive slippage?`;
}

function buildInsiderPrompt(opp: Opportunity, stats: ReturnType<typeof getStrategyStats>): string {
  const isActivist = opp.data.isActivist as boolean;
  return `INSIDER ${isActivist ? 'ACTIVIST 13D' : 'CLUSTER BUYING'} OPPORTUNITY

Stock: ${opp.ticker}
${isActivist ? `Activist filing: SC 13D` : `Insider buyers: ${opp.data.buyerCount} in 14 days`}
${isActivist ? '' : `Buyers: ${(opp.data.buyers as string[])?.join(', ') ?? 'Unknown'}`}

Summary: ${opp.summary}

Historical strategy performance:
- Total trades: ${stats.totalTrades}
- Win rate: ${(stats.winRate * 100).toFixed(1)}%

Evaluate this opportunity. Consider:
1. ${isActivist
    ? 'Activist 13D filings have historically produced +5-7% abnormal returns on filing day with continued drift.'
    : 'Cluster insider buying (3+ insiders in 14 days) predicts 4-8% abnormal returns over 12 months.'}
2. Who are the insiders buying? CEO/CFO purchases are more informative than board member purchases.
3. What is the likely catalyst for the buying?
4. Is the stock fundamentally sound or is this insiders catching a falling knife?`;
}

function buildFilingPrompt(opp: Opportunity): string {
  return `SEC 8-K FILING ANALYSIS

Company: ${opp.ticker}
Entity: ${opp.data.entityName}
Filed: ${opp.data.filedAt}
EDGAR URL: ${opp.sourceUrl ?? 'N/A'}

This is an 8-K material event filing. Based on the filing metadata, evaluate whether this represents a tradeable opportunity.

Consider:
1. What type of material event is this likely to be? (acquisition, CEO departure, bankruptcy, earnings pre-announcement, etc.)
2. 8-K filings appear on EDGAR approximately 47 minutes before mainstream news coverage on average.
3. Is this likely already priced in, or could there be a trading window?
4. What is the risk of acting on incomplete information from just the filing metadata?

Be especially conservative here. Without reading the actual filing content, conviction should generally be low (40-60) unless the metadata strongly suggests a specific material event.`;
}

// ============================================================
// MAIN ANALYSIS FUNCTION
// ============================================================

export async function analyzeWithClaude(
  apiKey: string,
  opp: Opportunity,
  account: AccountState
): Promise<AnalysisResult | null> {
  if (!apiKey) {
    log.debug('No Claude API key configured, skipping LLM analysis');
    return null;
  }

  const stats = getStrategyStats(opp.type.toLowerCase());

  let prompt: string;
  let model: string;

  switch (opp.type) {
    case 'SPINOFF':
      prompt = buildSpinoffPrompt(opp, stats);
      model = SONNET_MODEL; // Deep analysis for spin-offs
      break;
    case 'REG_SHO':
      prompt = buildRegShoPrompt(opp, stats);
      model = HAIKU_MODEL; // Fast triage for threshold list
      break;
    case 'INSIDER_CLUSTER':
      prompt = buildInsiderPrompt(opp, stats);
      model = opp.data.isActivist ? SONNET_MODEL : HAIKU_MODEL;
      break;
    case 'FILING_TONE_SHIFT':
      prompt = buildFilingPrompt(opp);
      model = HAIKU_MODEL;
      break;
    default:
      log.debug('No Claude prompt for opportunity type', { type: opp.type });
      return null;
  }

  try {
    const responseText = await withRetry(
      () => callClaude(apiKey, model, SYSTEM_PROMPT, prompt),
      `claude-${opp.type}`,
      { maxAttempts: 2, initialDelay: 2000 }
    );

    // Parse JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn('Claude response did not contain valid JSON', { response: responseText.slice(0, 200) });
      return null;
    }

    const result = JSON.parse(jsonMatch[0]) as AnalysisResult;

    log.info('Claude analysis complete', {
      ticker: opp.ticker,
      type: opp.type,
      model,
      shouldTrade: result.shouldTrade,
      conviction: result.conviction,
      side: result.side,
    });

    return result;
  } catch (err) {
    log.error('Claude analysis failed', {
      ticker: opp.ticker,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
