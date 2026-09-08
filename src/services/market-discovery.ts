import { isAddress } from 'viem';
import type { Database } from '../db.js';
import { log } from '../log.js';
import type { GeckoPool } from './pool-scanner.js';

export const ROBINHOOD_DISCOVERY_FEEDS = [
  'new_pools?page=1', 'trending_pools?page=1',
  ...['uniswap-v3-robinhood', 'uniswap-v4-robinhood'].flatMap(dex =>
    Array.from({ length: 10 }, (_, i) => `dexes/${dex}/pools?page=${i + 1}`)),
];

export class MarketDiscovery {
  private running = false;
  constructor(private readonly database: Database, private readonly fetchPage: (path: string) => Promise<GeckoPool[]>) {}

  async refresh(allowedQuotes: readonly string[]): Promise<void> {
    if (this.running) return;
    this.running = true;
    const allowed = new Set(allowedQuotes.map(address => address.toLowerCase()));
    try {
      const state = await this.database.getMarketDiscoveryState('robinhood');
      const start = Math.max(0, Math.min(ROBINHOOD_DISCOVERY_FEEDS.length - 1, state.nextCursor));
      // Finish the persisted cycle; a later refresh starts from page one again.
      for (let cursor = start; cursor < ROBINHOOD_DISCOVERY_FEEDS.length; cursor++) {
        const path = ROBINHOOD_DISCOVERY_FEEDS[cursor]!;
        try {
          const rows = await this.fetchPage(path);
          const candidates = new Map<string, number>();
          const snapshots = new Map<string, number>();
          for (const pool of rows) {
            if (!['uniswap-v3-robinhood', 'uniswap-v4-robinhood'].includes(pool.relationships?.dex?.data?.id ?? '')) continue;
            const base = pool.relationships?.base_token?.data?.id?.split('_').at(-1)?.toLowerCase();
            const quote = pool.relationships?.quote_token?.data?.id?.split('_').at(-1)?.toLowerCase();
            if (!base || !quote || !isAddress(base) || !isAddress(quote) || allowed.has(base) === allowed.has(quote)) continue;
            const token = allowed.has(base) ? quote : base;
            const tvl = Number(pool.attributes.reserve_in_usd);
            const volume = Number(pool.attributes.volume_usd?.h1);
            const fee = /\s(\d+(?:\.\d+)?)%$/.exec(pool.attributes.pool_name ?? pool.attributes.name);
            // Unknown fee/TVL/activity must not prevent future evaluation.
            const score = Number.isFinite(tvl) && tvl > 0 && Number.isFinite(volume) && volume > 0 && fee
              ? volume * Number(fee[1]) / tvl : 0;
            candidates.set(token, Math.max(candidates.get(token) ?? 0, score));
            if (Number.isFinite(tvl) && tvl > 0) snapshots.set(pool.attributes.address.toLowerCase(), tvl);
          }
          await this.database.saveMarketDiscoveryPage('robinhood', path, (cursor + 1) % ROBINHOOD_DISCOVERY_FEEDS.length,
            [...candidates].map(([tokenAddress, seedScore]) => ({ tokenAddress, seedScore })),
            [...snapshots].map(([poolId, tvlUsd]) => ({ poolId, tvlUsd })));
          log.info({ chain: 'robinhood', path, candidates: candidates.size }, 'market discovery page saved');
        } catch (error) {
          // Leave the cursor at the failed page. Earlier pages are already durable.
          log.warn({ err: error, path }, 'market discovery interrupted; will resume failed page');
          break;
        }
      }
    } finally { this.running = false; }
  }
}
