// Build first. This harness reads production settings/candidates; discovery writes only to memory.
// It never starts Telegram, monitoring, migrations, or transactions on-chain.
import pg from 'pg';
import { loadConfig } from '../dist/config.js';
import { ChainClients } from '../dist/services/chain-client.js';
import { PoolScanner, limitQualifiedPoolsPerToken } from '../dist/services/pool-scanner.js';

const config = loadConfig();
const client = new pg.Client({ connectionString: config.databaseUrl });
await client.connect();
await client.query('BEGIN READ ONLY');
const seeds = (await client.query('SELECT token_address, seed_score, updated_at FROM pool_scan_candidates WHERE chain=$1 ORDER BY seed_score DESC', ['robinhood'])).rows;
const settings = (await client.query('SELECT settings FROM telegram_pool_scan_settings WHERE chat_id=$1', [config.telegram?.chatId])).rows[0]?.settings ?? {};
await client.query('ROLLBACK');
await client.end();
const candidates = new Map(seeds.map(row => [row.token_address, { tokenAddress: row.token_address, seedScore: row.seed_score, lastSeenAt: new Date(row.updated_at), lastEvaluatedAt: null, sources: ['cache'] }]));
const snapshots = new Map();
let state = { nextCursor: 0, lastSuccessAt: null, cycleCompletedAt: null };
const memory = {
  async getMarketDiscoveryState() { return state; },
  async saveMarketDiscoveryPage(_chain, source, nextCursor, entries, pools) {
    for (const entry of entries) {
      const old = candidates.get(entry.tokenAddress);
      candidates.set(entry.tokenAddress, { ...entry, seedScore: Math.max(old?.seedScore ?? 0, entry.seedScore), lastSeenAt: new Date(),
        lastEvaluatedAt: null, sources: [...new Set([...(old?.sources ?? []), source])] });
    }
    for (const pool of pools) snapshots.set(pool.poolId, { ...pool, observedAt: new Date() });
    state = { nextCursor, lastSuccessAt: new Date(), cycleCompletedAt: nextCursor === 0 ? new Date() : state.cycleCompletedAt };
    console.log(JSON.stringify({ stage: 'warming', source, candidates: candidates.size }));
  },
  async listRetainedMarketCandidates() { return [...candidates.values()]; },
  async listMarketTvlSnapshots() { return [...snapshots.values()]; },
  async recordMarketEvaluations() {},
};
const scanner = new PoolScanner(new ChainClients(config), memory);
const allowedQuoteAddresses = config.quoteTokens.robinhood.map(token => token.address);
const warmingAt = Date.now();
await scanner.marketDiscovery.refresh(allowedQuoteAddresses);
const warmingMs = Date.now() - warmingAt;
const filters = { ...config.poolScanDefaults, ...settings, chain: 'robinhood', allowedQuoteAddresses,
  allowedQuotes: config.quoteTokens.robinhood.map(token => token.symbol), candidatePages: config.poolScanCandidatePages };
const marketResponses = new Map();
const poolScores = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const response = await realFetch(url, options);
  if (String(url).includes('/token-pairs/v1/robinhood/') && response.ok) {
    const body = await response.clone().json();
    marketResponses.set(String(url).split('/').at(-1), body);
  }
  return response;
};
const realScore = scanner.toDexScreenerPool.bind(scanner);
scanner.toDexScreenerPool = async (pair, token, ...args) => {
  const result = await realScore(pair, token, ...args);
  poolScores.set(`${token}:${pair.pairAddress.toLowerCase()}`, result);
  return result;
};
const startedAt = new Date().toISOString();
const result = await scanner.scanPools(filters, stage => console.log(JSON.stringify({ stage: 'scan', progress: stage })));
const finishedAt = new Date().toISOString();
// Compare the legacy shortlist against the exact captured market/verification responses.
scanner.fetchDexScreenerPairs = async token => marketResponses.get(token) ?? [];
scanner.buildGeckoTvlMap = async () => new Map([...snapshots].map(([id, row]) => [id, row.tvlUsd]));
scanner.toDexScreenerPool = async (pair, token) => poolScores.get(`${token}:${pair.pairAddress.toLowerCase()}`) ?? null;
const baseline = [];
for (const row of seeds.slice(0,20)) {
  const pools = await scanner.enrichDexScreenerToken(row.token_address, filters);
  baseline.push(...limitQualifiedPoolsPerToken(pools ?? []));
}
baseline.sort((a,b) => b.estimatedPoolYield1hPercent - a.estimatedPoolYield1hPercent);
const compact = pool => ({ pair: pool.pair, yieldHourlyPercent: pool.estimatedPoolYield1hPercent, tvlUsd: pool.tvlUsd, url: pool.uniswapUrl });
console.log(JSON.stringify({ stage: 'RESULT', startedAt, finishedAt, warmingMs, filters, coverage: result.marketCoverage,
  candidateTokens: result.candidateTokens, qualifiedTokens: result.qualifiedTokens, top10: result.pools.map(compact),
  baselineCapturedTop10: baseline.slice(0,10).map(compact),
  baselineHasAllTokenResponses: seeds.slice(0,20).every(row => marketResponses.has(row.token_address)),
  note: 'Legacy comparison uses captured responses only; unavailable/unfinished pool verifications are omitted.' }));
