/**
 * SCOUT: SEC EDGAR Filing Monitor
 *
 * Polls EDGAR full-text search API every second for new filings.
 * Detects and flags:
 * - Form 10-12B (spin-offs)
 * - Schedule 13D (activist stakes)
 * - Form 4 (insider transactions -- cluster detection)
 * - Form 8-K (material events)
 *
 * SEC rate limit: 10 req/sec with proper User-Agent header.
 * Required: User-Agent with company name and email.
 */

import type { Opportunity, OpportunityType } from '../../core/types.js';
import { createLogger } from '../../core/logger.js';
import { RateLimiter } from '../../utils/rate-limiter.js';

const log = createLogger('scout-edgar');

const EDGAR_SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';
const EDGAR_FILINGS_URL = 'https://efts.sec.gov/LATEST/search-index';
const CIK_TICKER_URL = 'https://www.sec.gov/files/company_tickers.json';
const USER_AGENT = 'ProjectGecko research@projectgecko.dev';

// Rate limiter: max 8 req/sec (leave headroom below SEC's 10/sec limit)
const rateLimiter = new RateLimiter('edgar', 8, 8);

// Track seen filing accession numbers to avoid duplicates
const seenFilings = new Set<string>();

// Track Form 4 filings per company for cluster detection
const form4History: Map<string, Array<{ filerName: string; date: number; type: 'P' | 'S' }>> = new Map();

// CIK to ticker mapping (loaded once at startup)
let cikToTicker: Map<string, string> = new Map();

// ============================================================
// CIK TO TICKER MAPPING
// ============================================================

export async function loadCikTickerMap(): Promise<void> {
  try {
    await rateLimiter.acquire();
    const response = await fetch(CIK_TICKER_URL, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      log.error('Failed to load CIK-ticker map', { status: response.status });
      return;
    }
    const data = await response.json() as Record<string, { cik_str: number; ticker: string; title: string }>;
    cikToTicker = new Map();
    for (const entry of Object.values(data)) {
      cikToTicker.set(String(entry.cik_str), entry.ticker);
    }
    log.info(`Loaded ${cikToTicker.size} CIK-ticker mappings`);
  } catch (err) {
    log.error('Error loading CIK-ticker map', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ============================================================
// FILING POLLING
// ============================================================

interface EdgarFiling {
  accessionNumber: string;
  formType: string;
  filedAt: string;
  entityName: string;
  cik: string;
  fileUrl: string;
}

async function pollRecentFilings(formType: string): Promise<EdgarFiling[]> {
  try {
    await rateLimiter.acquire();

    const url = `${EDGAR_SEARCH_URL}?q=*&forms=${formType}&dateRange=custom&startdt=${todayStr()}&enddt=${todayStr()}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 429) {
        log.warn('EDGAR rate limited, backing off');
        await new Promise(r => setTimeout(r, 5000));
        return [];
      }
      log.error('EDGAR poll failed', { status: response.status, formType });
      return [];
    }

    const data = await response.json() as {
      hits?: { hits?: Array<{ _source: { file_date: string; display_names: string[]; file_num: string; form_type: string; entity_name: string; } ; _id: string }> }
    };

    const filings: EdgarFiling[] = [];
    const hits = data?.hits?.hits ?? [];

    for (const hit of hits) {
      const accession = hit._id;
      if (seenFilings.has(accession)) continue;
      seenFilings.add(accession);

      filings.push({
        accessionNumber: accession,
        formType: hit._source.form_type,
        filedAt: hit._source.file_date,
        entityName: hit._source.entity_name,
        cik: '', // Will be extracted from accession
        fileUrl: `https://www.sec.gov/Archives/edgar/data/${accession.replace(/-/g, '/')}`,
      });
    }

    return filings;
  } catch (err) {
    log.error('EDGAR poll error', {
      formType,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ============================================================
// OPPORTUNITY DETECTION
// ============================================================

function detectSpinoff(filing: EdgarFiling): Opportunity | null {
  if (filing.formType !== '10-12B' && filing.formType !== '10-12B/A') return null;

  return {
    id: `spinoff-${filing.accessionNumber}`,
    type: 'SPINOFF',
    ticker: lookupTicker(filing.cik) ?? filing.entityName,
    urgency: 'THIS_WEEK',
    detectedAt: Date.now(),
    data: {
      entityName: filing.entityName,
      accessionNumber: filing.accessionNumber,
      formType: filing.formType,
      filedAt: filing.filedAt,
      fileUrl: filing.fileUrl,
    },
    sourceUrl: filing.fileUrl,
    summary: `Spin-off filing: ${filing.entityName} filed ${filing.formType}`,
  };
}

function detectActivist(filing: EdgarFiling): Opportunity | null {
  if (filing.formType !== 'SC 13D' && filing.formType !== 'SC 13D/A') return null;

  return {
    id: `activist-${filing.accessionNumber}`,
    type: 'INSIDER_CLUSTER', // Activist is a form of concentrated insider activity
    ticker: lookupTicker(filing.cik) ?? filing.entityName,
    urgency: 'IMMEDIATE',
    detectedAt: Date.now(),
    data: {
      entityName: filing.entityName,
      accessionNumber: filing.accessionNumber,
      formType: filing.formType,
      filedAt: filing.filedAt,
      fileUrl: filing.fileUrl,
      isActivist: true,
    },
    sourceUrl: filing.fileUrl,
    summary: `Activist 13D filing: ${filing.entityName}`,
  };
}

function detectInsiderCluster(filing: EdgarFiling): Opportunity | null {
  if (filing.formType !== '4') return null;

  const ticker = lookupTicker(filing.cik) ?? filing.entityName;

  // Track this Form 4
  if (!form4History.has(ticker)) {
    form4History.set(ticker, []);
  }
  const history = form4History.get(ticker)!;
  history.push({
    filerName: filing.entityName,
    date: Date.now(),
    type: 'P', // Would need to parse XML for actual buy/sell
  });

  // Clean old entries (older than 14 days)
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recent = history.filter(h => h.date >= cutoff);
  form4History.set(ticker, recent);

  // Cluster detection: 3+ unique filers buying in 14 days
  const uniqueBuyers = new Set(recent.filter(h => h.type === 'P').map(h => h.filerName));
  if (uniqueBuyers.size >= 3) {
    return {
      id: `cluster-${ticker}-${Date.now()}`,
      type: 'INSIDER_CLUSTER',
      ticker,
      urgency: 'TODAY',
      detectedAt: Date.now(),
      data: {
        buyerCount: uniqueBuyers.size,
        buyers: Array.from(uniqueBuyers),
        period: '14d',
        filings: recent.length,
      },
      summary: `Insider cluster: ${uniqueBuyers.size} insiders bought ${ticker} in 14 days`,
    };
  }

  return null;
}

function detectMaterialEvent(filing: EdgarFiling): Opportunity | null {
  if (filing.formType !== '8-K') return null;

  // 8-K needs deeper analysis by the Analyst agent
  // Scout just flags it as an opportunity
  return {
    id: `event-${filing.accessionNumber}`,
    type: 'FILING_TONE_SHIFT', // Will be reclassified by Analyst
    ticker: lookupTicker(filing.cik) ?? filing.entityName,
    urgency: 'TODAY',
    detectedAt: Date.now(),
    data: {
      entityName: filing.entityName,
      accessionNumber: filing.accessionNumber,
      formType: filing.formType,
      filedAt: filing.filedAt,
      fileUrl: filing.fileUrl,
    },
    sourceUrl: filing.fileUrl,
    summary: `Material event: ${filing.entityName} filed 8-K`,
  };
}

// ============================================================
// MAIN SCAN LOOP
// ============================================================

export async function scanEdgar(): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];

  // Poll each filing type we care about
  const formTypes = ['10-12B', 'SC 13D', '4', '8-K'];

  for (const formType of formTypes) {
    const filings = await pollRecentFilings(formType);

    for (const filing of filings) {
      let opp: Opportunity | null = null;

      switch (formType) {
        case '10-12B':
          opp = detectSpinoff(filing);
          break;
        case 'SC 13D':
          opp = detectActivist(filing);
          break;
        case '4':
          opp = detectInsiderCluster(filing);
          break;
        case '8-K':
          opp = detectMaterialEvent(filing);
          break;
      }

      if (opp) {
        opportunities.push(opp);
        log.info(`Opportunity detected: ${opp.type}`, {
          id: opp.id,
          ticker: opp.ticker,
          urgency: opp.urgency,
        });
      }
    }
  }

  return opportunities;
}

// ============================================================
// HELPERS
// ============================================================

function lookupTicker(cik: string): string | null {
  return cikToTicker.get(cik) ?? null;
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}
