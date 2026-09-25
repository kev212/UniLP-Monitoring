import type { Database, MarketCandidate } from '../db.js';
import { log } from '../log.js';
import { GmgnTrendingError, type MarketCandidateSource } from './gmgn-trending.js';
import type { DexScreenerPair, PoolMarketScan, PoolScanFilters, ScoredPool } from './pool-scanner.js';
import { ScanBudget, ScanSlots } from './scan-budget.js';

export const MARKET_SCAN_BUDGET_MS = 110_000;
export interface MarketCoverage {
  partial: boolean;
  timedOut: boolean;
  completedTokens: number;
  pendingTokens: number;
  failedTokens: number;
  unavailablePools: number;
  snapshotPools: number;
  totalQualifiedTokens: number;
  discoveryAt?: string;
  durationMs: number;
}

interface Dependencies {
  database: Database;
  candidateSource: MarketCandidateSource;
  eligible(pair: DexScreenerPair): boolean;
  waitForInteractive(budget: ScanBudget): Promise<void>;
  score(pair: DexScreenerPair, token: string, tvls: Map<string, number>): Promise<ScoredPool | null>;
}

export function fairMarketCandidates(candidates: readonly MarketCandidate[]): MarketCandidate[] {
  const ranked = [...candidates].sort((a, b) => b.seedScore - a.seedScore || a.tokenAddress.localeCompare(b.tokenAddress));
  const overdue = [...candidates].sort((a, b) => (a.lastEvaluatedAt?.getTime() ?? 0) - (b.lastEvaluatedAt?.getTime() ?? 0) || a.tokenAddress.localeCompare(b.tokenAddress));
  const used = new Set<string>();
  const result: MarketCandidate[] = [];
  let high = 0; let old = 0;
  while (result.length < candidates.length) {
    const list = result.length % 2 === 0 ? ranked : overdue;
    let i = list === ranked ? high : old;
    while (i < list.length && used.has(list[i]!.tokenAddress)) i++;
    const candidate = list[i];
    if (list === ranked) high = i + 1; else old = i + 1;
    if (!candidate) break;
    used.add(candidate.tokenAddress); result.push(candidate);
  }
  return result;
}

export class MarketScanner {
  private nextRequestAt = 0;
  private readonly httpSlots = new ScanSlots(4);
  private readonly rpcSlots = new ScanSlots(3);
  constructor(private readonly deps: Dependencies) {}

  private async pairs(token: string, budget: ScanBudget): Promise<DexScreenerPair[]> {
    return this.httpSlots.run(budget, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        budget.check();
        const wait = Math.max(0, this.nextRequestAt - Date.now());
        this.nextRequestAt = Date.now() + wait + 250;
        await budget.delay(wait);
        try {
          const response = await budget.run(() => fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${token}`, {
            headers: { Accept: 'application/json' }, signal: AbortSignal.any([budget.signal, AbortSignal.timeout(8_000)]),
          }));
          if (!response.ok) {
            if (response.status !== 429 && response.status < 500) throw new Error(`Permanent HTTP ${response.status}`);
            const retryAfter = response.headers.get('retry-after');
            const seconds = retryAfter === null ? NaN : Number(retryAfter);
            const retryMs = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 1000;
            if (attempt < 2) { await budget.delay(Math.max(500, Number.isFinite(retryMs) ? retryMs : 1000)); continue; }
            throw new Error(`HTTP ${response.status}`);
          }
          const body: unknown = await budget.run(() => response.json());
          if (!Array.isArray(body)) throw new Error('Invalid pool response');
          return body as DexScreenerPair[];
        } catch (error) {
          budget.check();
          if (attempt === 2 || (error instanceof Error && /Permanent|Invalid/.test(error.message))) throw error;
          await budget.delay(500 * 2 ** attempt);
        }
      }
      throw new Error('Token data unavailable');
    });
  }

  async scan(filters: PoolScanFilters, onProgress?: (stage: string) => void, startedAt = Date.now()): Promise<PoolMarketScan> {
    const budget = new ScanBudget(startedAt + MARKET_SCAN_BUDGET_MS);
    const coverage: MarketCoverage = { partial: false, timedOut: false, completedTokens: 0, pendingTokens: 0,
      failedTokens: 0, unavailablePools: 0, snapshotPools: 0, totalQualifiedTokens: 0, durationMs: 0 };
    type TokenResult = { token: string; pools: ScoredPool[]; totalTvl: number; incomplete: boolean; done: boolean; active: boolean };
    const outcomes: TokenResult[] = [];
    let candidates: MarketCandidate[] = [];
    let metadataFailed = false;
    let fatalError: unknown;
    try {
      onProgress?.('Memuat trending GMGN 24h...');
      const trending = await budget.run(() => this.deps.candidateSource.fetchCandidates(filters.minMarketCapUsd));
      const snapshots = await budget.run(() => this.deps.database.listMarketTvlSnapshots('robinhood').catch(() => {
        metadataFailed = true;
        return [];
      }));
      // GMGN already orders this universe by 24h volume. Do not interleave it
      // with the legacy cache fairness order or lower-ranked tokens can win the budget.
      candidates = [...trending.candidates].sort((left, right) => right.seedScore - left.seedScore || left.tokenAddress.localeCompare(right.tokenAddress));
      coverage.discoveryAt = trending.fetchedAt.toISOString();
      onProgress?.(`Trending GMGN 24h: ${candidates.length} token`);
      const tvls = new Map(snapshots.filter(p => Date.now() - p.observedAt.getTime() <= 15 * 60_000)
        .map(p => [p.poolId.toLowerCase(), p.tvlUsd]));
      const snapshotTimes = new Map(snapshots.map(p => [p.poolId.toLowerCase(), p.observedAt.getTime()]));
      const allowed = new Set(filters.allowedQuoteAddresses.map(address => address.toLowerCase()));
      let index = 0;
      const worker = async () => {
        while (index < candidates.length && !budget.signal.aborted) {
          const candidate = candidates[index++]!;
          const token = candidate.tokenAddress.toLowerCase();
          const outcome: TokenResult = { token, pools: [], totalTvl: 0, incomplete: false, done: false, active: false };
          outcomes.push(outcome);
          try {
            const raw = await this.pairs(token, budget);
            budget.check();
            const pairs = [...new Map(raw.filter(pair => this.deps.eligible(pair)
              && ((pair.baseToken.address.toLowerCase() === token && allowed.has(pair.quoteToken.address.toLowerCase()))
                || (pair.quoteToken.address.toLowerCase() === token && allowed.has(pair.baseToken.address.toLowerCase()))))
              .map(pair => [pair.pairAddress.toLowerCase(), pair])).values()];
            outcome.active = pairs.some(pair => Number(pair.volume?.h1 ?? 0) > 0 || Number(pair.volume?.h24 ?? 0) > 0);
            const mc = Math.max(0, ...pairs.map(pair => Number(pair.marketCap ?? 0)).filter(Number.isFinite));
            const fdv = Math.max(0, ...pairs.map(pair => Number(pair.fdv ?? 0)).filter(Number.isFinite));
            const valuation = mc > 0 ? mc : fdv;
            if (!(valuation > 0)) { outcome.incomplete = pairs.length > 0; continue; }
            if (valuation <= filters.minMarketCapUsd) continue;
            const oldest = Math.min(...pairs.map(pair => pair.pairCreatedAt ?? 0).filter(time => time > 0));
            const age = Number.isFinite(oldest) ? Math.max(0, (Date.now() - oldest) / 1000) : 0;
            // Turnover orders work only; no fee assumption or pool-count cutoff determines eligibility.
            const turnover = (pair: DexScreenerPair) => Number(pair.volume?.h1 ?? 0) / Math.max(1, Number(pair.liquidity?.usd ?? 0) || tvls.get(pair.pairAddress.toLowerCase()) || 1);
            pairs.sort((a, b) => turnover(b) - turnover(a));
            for (const pair of pairs) {
              await this.deps.waitForInteractive(budget);
              budget.check();
              const id = pair.pairAddress.toLowerCase();
              const fallback = !(Number(pair.liquidity?.usd) > 0);
              if (fallback && (!tvls.has(id) || Date.now() - (snapshotTimes.get(id) ?? 0) > 15 * 60_000)) {
                outcome.incomplete = true; coverage.unavailablePools++; continue;
              }
              if ([pair.volume?.h1, pair.volume?.h6].some(value => value == null || !Number.isFinite(Number(value)) || Number(value) < 0)) {
                outcome.incomplete = true; coverage.unavailablePools++; continue;
              }
              let pool: ScoredPool | null;
              try {
                pool = await this.rpcSlots.run(budget, async () => {
                  await this.deps.waitForInteractive(budget);
                  budget.check();
                  return this.deps.score(pair, token, tvls);
                });
              } catch (error) {
                budget.check(); outcome.incomplete = true; coverage.unavailablePools++; continue;
              }
              budget.check();
              if (!pool) { outcome.incomplete = true; coverage.unavailablePools++; continue; }
              if (!pool.activeLiquidity) continue;
              outcome.totalTvl += pool.tvlUsd;
              if (fallback) coverage.snapshotPools++;
              if (pool.tvlUsd >= filters.minPoolTvlUsd && pool.volume1hUsd >= (filters.minVolume1hUsd ?? 0) && pool.estimatedPoolYield1hPercent > filters.minYieldHourlyPercent) {
                outcome.pools.push({ ...pool, warnings: [...pool.warnings, ...(fallback ? ['TVL snapshot Gecko ≤15m'] : [])],
                  tokenMarketCapUsd: valuation, tokenValuationSource: mc > 0 ? 'market_cap' : 'fdv', tokenOldestPoolAgeSeconds: age });
              }
            }
          } catch (error) {
            if (!budget.signal.aborted) log.warn({ token, reason: error instanceof Error ? error.name : 'error' }, 'market token evaluation incomplete');
            outcome.incomplete = true;
          } finally {
            // Never allow late RPC/HTTP completions to mutate a returned result.
            if (!budget.signal.aborted) {
              outcome.done = true;
              if (outcome.incomplete) coverage.failedTokens++; else coverage.completedTokens++;
              onProgress?.(`Diperiksa ${coverage.completedTokens + coverage.failedTokens}/${candidates.length} | ${Math.floor((Date.now() - startedAt) / 1000)}s`);
            }
          }
        }
      };
      await budget.run(() => Promise.all(Array.from({ length: 4 }, worker)));
    } catch (error) {
      if (error instanceof GmgnTrendingError) {
        fatalError = error;
      } else {
        metadataFailed = true;
        if (!budget.signal.aborted) log.warn({ reason: error instanceof Error ? error.name : 'error' }, 'market scan metadata unavailable');
      }
    } finally {
      coverage.timedOut = budget.signal.aborted || Date.now() >= budget.deadline;
      budget.close();
    }
    if (fatalError) throw fatalError;
    const pools = outcomes.filter(outcome => outcome.totalTvl > filters.minTotalActiveTvlUsd)
      .flatMap(outcome => [...outcome.pools].sort((a, b) => b.estimatedPoolYield1hPercent - a.estimatedPoolYield1hPercent || b.tvlUsd - a.tvlUsd).slice(0, 1)
        .map(pool => ({ ...pool, tokenTotalActiveTvlUsd: outcome.totalTvl,
          warnings: [...pool.warnings, ...(!outcome.done || outcome.incomplete ? ['Total TVL: batas bawah, pemeriksaan parsial'] : [])] })))
      .sort((a, b) => b.estimatedPoolYield1hPercent - a.estimatedPoolYield1hPercent || b.tvlUsd - a.tvlUsd);
    coverage.totalQualifiedTokens = pools.length;
    coverage.pendingTokens = candidates.length - coverage.completedTokens - coverage.failedTokens;
    coverage.durationMs = Date.now() - startedAt;
    coverage.partial = metadataFailed || coverage.pendingTokens > 0 || coverage.failedTokens > 0
      || !coverage.discoveryAt || Date.now() - Date.parse(coverage.discoveryAt) > 15 * 60_000;
    const result: PoolMarketScan = { pools: pools.slice(0, filters.maxResults), candidateTokens: candidates.length,
      evaluatedTokens: coverage.completedTokens + coverage.failedTokens, qualifiedTokens: pools.length,
      chain: 'robinhood', marketCoverage: coverage, warming: false };
    log.info({ ...coverage, candidateTokens: candidates.length }, 'market scan completed');
    return result;
  }
}
