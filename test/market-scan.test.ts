import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database, MarketCandidate } from '../src/db.js';
import { MarketScanner, fairMarketCandidates } from '../src/services/market-scan.js';
import { MarketDiscovery, ROBINHOOD_DISCOVERY_FEEDS } from '../src/services/market-discovery.js';
import { ScanBudget, ScanSlots } from '../src/services/scan-budget.js';
import { PoolScanner, type PoolScanFilters, type ScoredPool } from '../src/services/pool-scanner.js';
import { formatPoolMarketScan } from '../src/services/notifier.js';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const token = addr(1);
const quote = addr(9999);
const candidate = (n: number): MarketCandidate => ({ tokenAddress: addr(n), seedScore: 100-n, lastSeenAt: new Date(), lastEvaluatedAt: null, sources: ['cache'] });
const pair = (n: number, target = token) => ({ pairAddress: addr(n+100), chainId: 'robinhood', dexId: 'uniswap', labels: ['v3'],
  baseToken: { address: target, symbol: 'TOKEN' }, quoteToken: { address: quote, symbol: 'USDG' }, marketCap: 1_000_000,
  pairCreatedAt: Date.now() - 7_200_000, volume: { h1: 100, h6: 600, h24: 2400 }, liquidity: { usd: 6000 } });
const scored = (p: ReturnType<typeof pair>, yieldPercent = 1): ScoredPool => ({ protocol: 'v3', pair: 'TOKEN/USDG', quoteToken: quote as any,
  uniswapUrl: `https://app.uniswap.org/explore/pools/robinhood/${p.pairAddress}`, activeLiquidity: true, feeTier: 3000, feeRate: 0.003,
  tvlUsd: p.liquidity.usd, volume1hUsd: 100, volume6hUsd: 600, estimatedPoolFees1hUsd: 3, estimatedPoolYield1hPercent: yieldPercent,
  estimatedPoolFees6hUsd: 18, estimatedPoolYieldHourlyPercent: 1, score: 1, safetyFactor: 1, dynamicFee: false, stale: false, warnings: [] });
const filters: PoolScanFilters = { chain: 'robinhood', minPoolTvlUsd: 1000, minMarketCapUsd: 300000, minTotalActiveTvlUsd: 5000,
  minPoolAgeSeconds: 60, minYieldHourlyPercent: 0.5, minStockYieldHourlyPercent: 0.05, maxResults: 10,
  allowedQuotes: ['USDG'], allowedQuoteAddresses: [quote as any], candidatePages: 3 };
function setup(count = 1) {
  vi.useFakeTimers();
  const database = { listRetainedMarketCandidates: vi.fn(async () => Array.from({length:count}, (_, i) => candidate(i+1))),
    listMarketTvlSnapshots: vi.fn(async () => [] as any[]),
    getMarketDiscoveryState: vi.fn(async () => ({ nextCursor: 0, cycleCompletedAt: new Date(), lastSuccessAt: new Date() })),
    recordMarketEvaluations: vi.fn(async () => {}) };
  const score = vi.fn(async p => scored(p));
  const waitForInteractive = vi.fn(async (budget: ScanBudget) => budget.check());
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify([pair(1, url.split('/').at(-1)!)])));
  vi.stubGlobal('fetch', fetchMock);
  const scanner = new MarketScanner({ database: database as unknown as Database, score, waitForInteractive, eligible: () => true });
  return { scanner, score, waitForInteractive, database, fetchMock };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('bounded market scan', () => {
  it('honors Top N 20 and sorts all retained results by yield', async () => {
    const { scanner, score } = setup(25);
    score.mockImplementation(async p => scored(p, Number(BigInt(p.baseToken.address))));
    const pending = scanner.scan({ ...filters, maxResults: 20 });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.pools).toHaveLength(20);
    expect(result.pools.map(p => p.estimatedPoolYield1hPercent)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
    expect(result.qualifiedTokens).toBe(25);
  });

  it.each([0, 99, 100, 101])('applies minimum volume %s inclusively', async minimum => {
    const { scanner } = setup();
    const pending = scanner.scan({ ...filters, minVolume1hUsd: minimum });
    await vi.runAllTimersAsync();
    expect((await pending).pools).toHaveLength(minimum <= 100 ? 1 : 0);
  });

  it('filters volume before choosing best yield while retaining total active TVL', async () => {
    const { scanner, fetchMock, score } = setup();
    const pairs = [pair(1), pair(2)];
    fetchMock.mockResolvedValue(new Response(JSON.stringify(pairs)));
    score.mockImplementation(async p => ({ ...scored(p, p.pairAddress === pairs[0].pairAddress ? 9 : 2),
      volume1hUsd: p.pairAddress === pairs[0].pairAddress ? 10 : 200 }));
    const pending = scanner.scan({ ...filters, minVolume1hUsd: 100, minTotalActiveTvlUsd: 10000 });
    await vi.runAllTimersAsync();
    expect((await pending).pools[0]).toMatchObject({ estimatedPoolYield1hPercent: 2, tokenTotalActiveTvlUsd: 12000 });
  });

  it('evaluates the full 205-token universe within the budget with provider pacing', async () => {
    const { scanner, score } = setup(205);
    const pending = scanner.scan(filters);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(score).toHaveBeenCalledTimes(205);
    expect(result.marketCoverage).toMatchObject({ completedTokens: 205, pendingTokens: 0, partial: false });
    expect(result.marketCoverage!.durationMs).toBeLessThan(110000);
    expect(result.pools).toHaveLength(10);
  });

  it('evaluates pool 9+ and uses all active TVL while emitting one best pool per token', async () => {
    const { scanner, fetchMock, score } = setup();
    const pairs = Array.from({length:12}, (_, i) => pair(i));
    fetchMock.mockResolvedValue(new Response(JSON.stringify(pairs)));
    score.mockImplementation(async p => scored(p, p.pairAddress === pairs[11]!.pairAddress ? 9 : 0.1));
    const pending = scanner.scan(filters); await vi.runAllTimersAsync(); const result = await pending;
    expect(score).toHaveBeenCalledTimes(12);
    expect(result.pools[0]).toMatchObject({ estimatedPoolYield1hPercent: 9, tokenTotalActiveTvlUsd: 72000 });
  });

  it('returns partial verified results at 110 seconds and ignores a late RPC', async () => {
    const { scanner, fetchMock, score } = setup();
    fetchMock.mockResolvedValue(new Response(JSON.stringify([pair(1), pair(2)])));
    let resolve!: (value: ScoredPool) => void;
    score.mockImplementationOnce(async p => scored(p)).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = scanner.scan(filters); await vi.runAllTimersAsync(); const result = await pending;
    expect(result.marketCoverage).toMatchObject({ partial: true, timedOut: true, durationMs: 110000, pendingTokens: 1 });
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]!.warnings).toContain('Total TVL: batas bawah, pemeriksaan parsial');
    const before = JSON.stringify(result); resolve(scored(pair(2), 99)); await Promise.resolve();
    expect(JSON.stringify(result)).toBe(before);
  });

  it('does not mistake missing total TVL for a completed filter rejection', async () => {
    const { scanner, fetchMock, score } = setup();
    fetchMock.mockResolvedValue(new Response(JSON.stringify([pair(1), {...pair(2), liquidity: {usd:0}}])));
    score.mockImplementation(async p => ({...scored(p), tvlUsd: 3000}));
    const pending = scanner.scan(filters); await vi.runAllTimersAsync(); const result = await pending;
    expect(result.pools).toHaveLength(0);
    expect(result.marketCoverage).toMatchObject({ failedTokens: 1, partial: true, completedTokens: 0, unavailablePools: 1 });
  });

  it('uses only fresh TVL snapshots and labels the fallback', async () => {
    const { scanner, fetchMock, score, database } = setup();
    database.listMarketTvlSnapshots.mockResolvedValue([{poolId: pair(1).pairAddress, tvlUsd: 6000, observedAt: new Date()}]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify([{...pair(1), liquidity: {usd:0}}])));
    score.mockImplementation(async p => ({...scored(p), tvlUsd: 6000}));
    const pending = scanner.scan(filters); await vi.runAllTimersAsync(); const result = await pending;
    expect(result.pools[0]!.warnings).toContain('TVL snapshot Gecko ≤15m');
    expect(result.marketCoverage!.snapshotPools).toBe(1);
  });

  it('aborts hanging HTTP and clears queued work at the deadline', async () => {
    const { scanner, fetchMock } = setup(10);
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url, init?: any) => { signals.push(init.signal); return new Promise(() => {}); });
    const pending = scanner.scan(filters); await vi.runAllTimersAsync(); const result = await pending;
    expect(result.marketCoverage!.timedOut).toBe(true);
    expect(result.marketCoverage!.durationMs).toBe(110000);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it('honors /scan priority and resumes after it releases', async () => {
    const { scanner, waitForInteractive, score } = setup();
    let release!: () => void; const paused = new Promise<void>(r => {release=r;});
    waitForInteractive.mockImplementation(budget => budget.run(() => paused));
    const pending = scanner.scan(filters); await vi.advanceTimersByTimeAsync(1000);
    expect(score).not.toHaveBeenCalled(); release(); await vi.runAllTimersAsync();
    expect((await pending).pools).toHaveLength(1);
  });

  it('keeps formatter within Telegram length for ten verbose results', async () => {
    const { scanner } = setup(10);const pending=scanner.scan(filters);await vi.runAllTimersAsync();const result=await pending;
    result.pools.forEach(p=>{p.pair='X'.repeat(1000);p.uniswapUrl='https://app.uniswap.org/explore/pools/robinhood/0x'+'a'.repeat(64);p.warnings=['TVL snapshot Gecko ≤15m','Total TVL: batas bawah, pemeriksaan parsial'];});
    expect(formatPoolMarketScan(result,filters).length).toBeLessThanOrEqual(4096);
  });

  it('alternates seed rank with least-recently-evaluated tokens', () => {
    const rows=Array.from({length:30},(_,i)=>({...candidate(i+1),lastEvaluatedAt:new Date(1000-i)}));
    const ordered=fairMarketCandidates(rows);
    expect(ordered.slice(0,4).map(x=>x.tokenAddress)).toEqual([addr(1),addr(30),addr(2),addr(29)]);
    expect(new Set(ordered.map(x=>x.tokenAddress)).size).toBe(30);
  });
});

describe('market discovery', () => {
  const pool = (fee = '') => ({ attributes: { address: addr(100), name: `TOKEN / USDG${fee}`, reserve_in_usd: '9000', volume_usd:{h1:'100'} },
    relationships:{dex:{data:{id:'uniswap-v4-robinhood'}},base_token:{data:{id:`robinhood_${token}`}},quote_token:{data:{id:`robinhood_${quote}`}}}} as any);
  it('persists unknown-fee candidates and snapshots one page at a time', async () => {
    const database={getMarketDiscoveryState:vi.fn(async()=>({nextCursor:21})),saveMarketDiscoveryPage:vi.fn(async()=>{})};
    const fetchPage=vi.fn(async()=>[pool()]);
    await new MarketDiscovery(database as any,fetchPage).refresh([quote]);
    expect(fetchPage).toHaveBeenCalledWith(ROBINHOOD_DISCOVERY_FEEDS[21]);
    expect(database.saveMarketDiscoveryPage).toHaveBeenCalledWith('robinhood',ROBINHOOD_DISCOVERY_FEEDS[21],0,[{tokenAddress:token,seedScore:0}],[{poolId:addr(100),tvlUsd:9000}]);
  });
  it('keeps the failed page cursor and does not overlap refreshes', async () => {
    const database={getMarketDiscoveryState:vi.fn(async()=>({nextCursor:3})),saveMarketDiscoveryPage:vi.fn(async()=>{})};
    let fail!:()=>void;const fetchPage=vi.fn(()=>new Promise<any[]>((_,reject)=>{fail=()=>reject(new Error('429'));}));
    const discovery=new MarketDiscovery(database as any,fetchPage);
    const first=discovery.refresh([quote]);await Promise.resolve();await discovery.refresh([quote]);fail();await first;
    expect(fetchPage).toHaveBeenCalledTimes(1);expect(database.saveMarketDiscoveryPage).not.toHaveBeenCalled();
  });
});

describe('priority and concurrency', () => {
  it('does not issue discovery fetches during a token scan and resumes on release', async () => {
    const scanner=new PoolScanner({} as any,{} as any,0);const fetchMock=vi.fn(async()=>new Response('{}'));vi.stubGlobal('fetch',fetchMock);
    const release=scanner.beginTokenScan();const background=(scanner as any).fetchGecko('https://background','background');
    await Promise.resolve();expect(fetchMock).not.toHaveBeenCalled();
    await (scanner as any).fetchGecko('https://interactive','interactive');expect(fetchMock).toHaveBeenCalledTimes(1);
    release();release();await background;expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('retains physical RPC capacity after a timed-out caller until the RPC settles', async () => {
    vi.useFakeTimers();const slots=new ScanSlots(1);const firstBudget=new ScanBudget(Date.now()+100);let release!:()=>void;
    const first=slots.run(firstBudget,()=>new Promise<void>(r=>{release=r;}));const failed=expect(first).rejects.toThrow();await vi.advanceTimersByTimeAsync(100);await failed;
    const secondBudget=new ScanBudget(Date.now()+1000);const work=vi.fn(async()=>{});const second=slots.run(secondBudget,work);
    await Promise.resolve();expect(work).not.toHaveBeenCalled();release();await second;expect(work).toHaveBeenCalledTimes(1);firstBudget.close();secondBudget.close();
  });
});

describe('market scan verification metadata', () => {
  it('reuses immutable V4 keys but refreshes live liquidity and fee on every evaluation', async () => {
    const { v4PoolId } = await import('../src/services/v4-pool.js');
    const key = { currency0: token as any, currency1: quote as any, fee: 8388608, tickSpacing: 60, hooks: addr(0) as any };
    const poolId = v4PoolId(key);
    let fee = 10000; let liquidity = 10n;
    const readContract = vi.fn(async ({functionName}: any) => {
      if (functionName === 'getSlot0') return [1n, 0, 0, fee];
      if (functionName === 'getLiquidity') return liquidity;
      if (functionName === 'poolKeys') return key;
      throw new Error('Unexpected method');
    });
    const chains = { getForScan: () => ({client:{readContract},registry:{contracts:{v4:{stateView:addr(2),positionManager:addr(3)}}}}) };
    const scanner = new PoolScanner(chains as any, {} as any);
    const first = await scanner.verifyPool('v4',poolId as any,token,'robinhood','scan',true);
    fee = 20000; liquidity = 0n;
    const second = await scanner.verifyPool('v4',poolId as any,token,'robinhood','scan',true);
    expect(first).toMatchObject({currentLpFee:10000,activeLiquidity:true});
    expect(second).toMatchObject({currentLpFee:20000,activeLiquidity:false});
    expect(readContract.mock.calls.filter(([x])=>x.functionName==='poolKeys')).toHaveLength(1);
    expect(readContract.mock.calls.filter(([x])=>x.functionName==='getSlot0')).toHaveLength(2);
  });

  it('lets interactive work go first after shared 429 cooldown', async () => {
    vi.useFakeTimers();
    const scanner = new PoolScanner({} as any, {} as any, 0);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return calls.length === 1 ? new Response('{}', {status:429, headers:{'retry-after':'1'}}) : new Response('{}');
    }));
    const background = (scanner as any).fetchGecko('background','background');
    await vi.advanceTimersByTimeAsync(1);
    const release = scanner.beginTokenScan();
    const interactive = (scanner as any).fetchGecko('interactive','interactive').finally(release);
    await vi.runAllTimersAsync(); await Promise.all([background,interactive]);
    expect(calls).toEqual(['background','interactive','background']);
  });

  it('releases token scan priority if the token scan throws', async () => {
    const scanner = new PoolScanner({} as any, {} as any, 0);
    vi.spyOn(scanner as any,'fetchUniswapPools').mockRejectedValue(new Error('upstream failed'));
    await expect(scanner.scan(token as any)).rejects.toThrow('upstream failed');
    expect((scanner as any).interactiveScans).toBe(0);
  });
});
