import { afterEach, describe, expect, it, vi } from 'vitest';
import { Notifier, buildPoolScanPages, parseDashboardAction, parsePoolScanInput } from '../src/services/notifier.js';
import type { RuntimeConfig } from '../src/config.js';
import type { PoolMarketScan, PoolScanFilters, ScoredPool } from '../src/services/pool-scanner.js';

const filters: PoolScanFilters = { chain: 'robinhood', minMarketCapUsd: 300000, minPoolTvlUsd: 1000,
  minTotalActiveTvlUsd: 5000, minPoolAgeSeconds: 60, minYieldHourlyPercent: 0.5,
  minStockYieldHourlyPercent: 0.05, maxResults: 20, minVolume1hUsd: 100,
  allowedQuotes: ['USDG'], allowedQuoteAddresses: [], candidatePages: 3 };
function result(count: number): PoolMarketScan {
  return { chain: 'robinhood', candidateTokens: count, evaluatedTokens: count, qualifiedTokens: count,
    marketCoverage: { partial: false, timedOut: false, completedTokens: count, pendingTokens: 0, failedTokens: 0,
      unavailablePools: 0, snapshotPools: 0, totalQualifiedTokens: count, durationMs: 20000 },
    pools: Array.from({ length: count }, (_, i) => ({ protocol: 'v4', pair: `TOKEN${i + 1}/USDG`,
      feeTier: 3000, tvlUsd: 6000, volume1hUsd: 1000, estimatedPoolYield1hPercent: 20 - i / 2,
      estimatedPoolFees1hUsd: 3, warnings: [],
      uniswapUrl: `https://app.uniswap.org/explore/pools/robinhood/0x${String(i).padStart(64, '0')}` } as ScoredPool)) };
}
function setup() {
  vi.useFakeTimers();
  const database = { queueMessageDeletion: vi.fn(async () => {}) };
  const notifier = new Notifier({ telegram: { token: '123:test', chatId: '1', userId: '1' },
    poolScanDefaults: { ...filters, minVolume1hUsd: 0 } } as unknown as RuntimeConfig, {} as never, database as never) as any;
  const api = { editMessageText: vi.fn(async () => ({})), sendMessage: vi.fn(async () => ({ message_id: 99 })) };
  notifier.bot = { api };
  const scanner = { scanPools: vi.fn() };
  const callback = async (page: number, messageId = 10, chatId = 1, userId = 1) => {
    const ctx = { from: { id: userId }, callbackQuery: { data: `lp:poolpg:${page}`,
      message: { message_id: messageId, chat: { id: chatId } } }, answerCallbackQuery: vi.fn(async () => {}) };
    await notifier.handleDashboardCallback(ctx, {}, {}, {}, scanner);
    return ctx;
  };
  return { notifier, api, scanner, callback, database };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('pool result pagination', () => {
  it.each([0, 1, 10, 11, 20])('renders %s results without losing ranks', count => {
    const pages = buildPoolScanPages(result(count), filters);
    expect(pages).toHaveLength(Math.max(1, Math.ceil(count / 10)));
    expect(pages.flatMap(page => [...page.matchAll(/^(\d+)\. V4/gm)].map(match => Number(match[1]))))
      .toEqual(Array.from({ length: count }, (_, i) => i + 1));
    pages.forEach((page, i) => {
      expect(page.length).toBeLessThanOrEqual(4096);
      expect(page).toContain(`Halaman ${i + 1}/${pages.length}`);
      expect(page).toContain(`Top ${count} dari ${count}`);
    });
  });

  it.each(['robinhood', 'base', 'bsc'] as const)('fits verbose %s results into Telegram pages', chain => {
    const scan = result(20);
    scan.chain = chain;
    if (chain !== 'robinhood') delete scan.marketCoverage;
    scan.pools.forEach(p => { p.pair = 'X'.repeat(1000); p.warnings = ['TVL snapshot Gecko ≤15m', 'Total TVL: batas bawah']; });
    const pages = buildPoolScanPages(scan, { ...filters, chain });
    expect(pages.join('\n').match(/^\d+\. V4/gm)).toHaveLength(20);
    pages.forEach(page => expect(page.length).toBeLessThanOrEqual(4096));
  });

  it('navigates both ways without rescanning or extending snapshot lifetime', async () => {
    const { notifier, api, scanner, callback, database } = setup();
    const pages = buildPoolScanPages(result(20), filters);
    await notifier.deliverMarketScan('1', 10, pages[0], Date.now() + 10000, pages);
    const expiry = notifier.poolScanPages.get('1:10').expiresAt;
    expect(api.editMessageText.mock.calls[0][3].reply_markup.inline_keyboard[0][0].callback_data).toBe('lp:poolpg:1');
    await callback(1);
    expect(api.editMessageText.mock.lastCall![2]).toBe(pages[1]);
    expect(api.editMessageText.mock.lastCall![3].reply_markup.inline_keyboard[0][0].callback_data).toBe('lp:poolpg:0');
    await callback(0);
    expect(api.editMessageText.mock.lastCall![2]).toBe(pages[0]);
    expect(scanner.scanPools).not.toHaveBeenCalled();
    expect(notifier.poolScanPages.get('1:10').expiresAt).toBe(expiry);
    expect(database.queueMessageDeletion).toHaveBeenCalledTimes(1);
  });

  it('attaches pages to fallback message, not the failed progress message', async () => {
    const { notifier, api, callback } = setup();
    const pages = buildPoolScanPages(result(20), filters);
    api.editMessageText.mockRejectedValueOnce(new Error('message to edit not found'));
    await notifier.deliverMarketScan('1', 10, pages[0], Date.now() + 10000, pages);
    expect(notifier.poolScanPages.has('1:10')).toBe(false);
    expect(notifier.poolScanPages.has('1:99')).toBe(true);
    expect(api.sendMessage.mock.lastCall![2].reply_markup.inline_keyboard[0][0].callback_data).toBe('lp:poolpg:1');
    await callback(1, 99);
    expect(api.editMessageText.mock.lastCall![2]).toBe(pages[1]);
  });

  it('rejects expired, unknown, cross-chat, unauthorized and out-of-range callbacks', async () => {
    const { notifier, api, callback } = setup();
    notifier.rememberPoolPages('1', 10, ['page one', 'page two']);
    for (const args of [[1, 11], [1, 10, 2], [1, 10, 1, 2], [99, 10]]) {
      const ctx = await callback(...args as [number, number?, number?, number?]);
      expect(ctx.answerCallbackQuery.mock.lastCall![0]).toMatchObject({ show_alert: true });
    }
    await vi.advanceTimersByTimeAsync(300000);
    expect(notifier.poolScanPages.size).toBe(0);
    expect((await callback(1)).answerCallbackQuery.mock.lastCall![0]).toMatchObject({ text: expect.stringContaining('kedaluwarsa') });
    expect(api.editMessageText).not.toHaveBeenCalled();
  });
});

describe('pool volume configuration', () => {
  it('saves volume through config input and resets it to ENV', async () => {
    const { notifier, api } = setup();
    let stored: Record<string, unknown> | null = { maxResults: 20 };
    const database = {
      getPoolScanSettings: vi.fn(async () => stored),
      setPoolScanSettings: vi.fn(async (_chat: string, settings: Record<string, unknown>) => { stored = settings; }),
      clearPoolScanSettings: vi.fn(async () => { stored = null; }),
    };
    notifier.pendingInput.set('1', { kind: 'config', key: 'volume_1h', dashboardMessageId: 10 });
    await notifier.handlePendingInput({ chat: { id: 1 }, from: { id: 1 }, message: { text: '1000' },
      reply: vi.fn(async () => ({ message_id: 42 })) }, database, {});
    expect(database.setPoolScanSettings).toHaveBeenCalledWith('1', expect.objectContaining({ minVolume1hUsd: 1000, maxResults: 20 }));
    expect(api.editMessageText.mock.lastCall![2]).toContain('Min volume 1h per pool: $1.00K');
    await notifier.handleDashboardCallback({ from: { id: 1 }, callbackQuery: { data: 'lp:config_reset:0',
      message: { message_id: 10, chat: { id: 1 } } }, answerCallbackQuery: vi.fn(async () => {}) }, database, {}, {}, {});
    // Existing dashboard callbacks dispatch their render work asynchronously.
    await vi.advanceTimersByTimeAsync(0);
    expect(database.clearPoolScanSettings).toHaveBeenCalledWith('1');
    expect(await notifier.poolScanSettings(database, '1')).toMatchObject({ minVolume1hUsd: 0 });
  });

  it('parses volume settings and rejects invalid input', () => {
    expect(parsePoolScanInput('volume_1h', '$10,000')).toEqual({ minVolume1hUsd: 10000 });
    expect(parsePoolScanInput('volume_1h', '0')).toEqual({ minVolume1hUsd: 0 });
    for (const value of ['', '$', '-1', 'NaN', 'Infinity', '10k']) expect(() => parsePoolScanInput('volume_1h', value)).toThrow();
    expect(parseDashboardAction('lp:cfg:volume_1h')).toEqual({ type: 'config_edit', key: 'volume_1h' });
    expect(parseDashboardAction('lp:poolpg:1')).toEqual({ type: 'pool_page', page: 1 });
    expect(parseDashboardAction('lp:poolpg:-1')).toBeNull();
  });

  it('defaults old settings to disabled and retains saved overrides', async () => {
    const { notifier } = setup();
    const database = { getPoolScanSettings: vi.fn(async () => ({ maxResults: 20 })) };
    expect(await notifier.poolScanSettings(database, '1')).toMatchObject({ maxResults: 20, minVolume1hUsd: 0 });
    database.getPoolScanSettings.mockResolvedValue({ maxResults: 20, minVolume1hUsd: 1000 } as any);
    expect(await notifier.poolScanSettings(database, '1')).toMatchObject({ maxResults: 20, minVolume1hUsd: 1000 });
  });
});
