import { afterEach, describe, expect, it, vi } from "vitest";
import { PoolScanner, ROBINHOOD_STOCK_TOKENS, type PoolMarketScan } from "../src/services/pool-scanner.js";
import { formatStockScan } from "../src/services/notifier.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const asset = (n: number, tokenSymbol = `STOCK${n}`) => ({ tokenSymbol, deployments: [{ chainId: 4663, contractAddress: address(n) }] });
const pair = (n: number, token = address(1), h24 = 100_000) => ({
  chainId: "robinhood", dexId: "uniswap", pairAddress: `0x${n.toString(16).padStart(64, "0")}`, labels: ["v4"],
  baseToken: { address: token, symbol: "STOCK" },
  quoteToken: { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", symbol: "USDG" },
  liquidity: { usd: 1_000 }, volume: { h24, h1: 1_000, h6: 6_000 },
});
function setup(assets = [asset(1)], pairs: (url: string) => unknown = () => []) {
  const scanner = new PoolScanner({} as never, {} as never, 0);
  const internals = scanner as any;
  vi.spyOn(internals, "verifyPool").mockResolvedValue({ activeLiquidity: true, feeTier: 3000 });
  const fetchMock = vi.fn(async (url: string) => {
    // No wall-clock provider pacing in fixture tests.
    internals.nextStockRequestAt = 0;
    return new Response(JSON.stringify(url.includes("rhj/assets") ? { assets } : pairs(url)), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { scanner, internals, fetchMock };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Robinhood stock coverage", () => {
  it("scans more than 400 official assets including commodity ETFs without logo/name requirements", async () => {
    const assets = Array.from({ length: 405 }, (_, i) => asset(i + 1));
    ["GLD", "SLV", "USO", "QQQ", "NEW"].forEach((symbol, i) => { assets[i]!.tokenSymbol = symbol; });
    assets.push(asset(1, "GLD"));
    assets.push({ tokenSymbol: "OTHER_CHAIN", deployments: [{ chainId: 1, contractAddress: address(999) }] });
    const { scanner, fetchMock } = setup(assets);
    const scan = await scanner.scanStocks();
    expect(scan.candidateTokens).toBe(405);
    expect(scan.stockCoverage).toMatchObject({ source: "official", partial: false, completedTokens: 405, noEligiblePools: 405 });
    expect(fetchMock).toHaveBeenCalledTimes(406);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith(address(1)))).toHaveLength(1);
  });

  it("verifies pool 9 and later, deduplicates pools and reports the total before top 10", async () => {
    const pairs = Array.from({ length: 12 }, (_, i) => pair(i + 1));
    const { scanner, internals, fetchMock } = setup([asset(1)], () => [...pairs, pairs[0]]);
    const scan = await scanner.scanStocks(undefined, "robinhood", 0.2);
    expect(internals.verifyPool).toHaveBeenCalledTimes(12);
    expect(scan.pools).toHaveLength(10);
    expect(scan.qualifiedTokens).toBe(1);
    expect(scan.stockCoverage).toMatchObject({ totalQualifiedPools: 12, minYieldHourlyPercent: 0.2, partial: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps volume and yield boundary semantics and avoids duplicate volume", async () => {
    const { scanner } = setup([asset(1), asset(2)], (url) => url.endsWith(address(1))
      ? [pair(1, address(1), 50_000), pair(1, address(1), 50_000)] : [pair(2, address(2), 100_000)]);
    const scan = await scanner.scanStocks(undefined, "robinhood", 0.3);
    expect(scan.evaluatedTokens).toBe(1);
    expect(scan.qualifiedTokens).toBe(0);
    expect(scan.stockCoverage).toMatchObject({ belowVolumeTokens: 1, totalQualifiedPools: 0, partial: false });
  });

  it("retains successful pools when another pool or token fails", async () => {
    const { scanner, internals } = setup([asset(1), asset(2), asset(3)], (url) => {
      if (url.endsWith(address(2))) return { error: "malformed" };
      if (url.endsWith(address(3))) return [];
      return [pair(1), pair(2)];
    });
    internals.verifyPool.mockResolvedValueOnce(null).mockResolvedValue({ activeLiquidity: true, feeTier: 3000 });
    const scan = await scanner.scanStocks();
    expect(scan.pools).toHaveLength(1);
    expect(scan.stockCoverage).toMatchObject({ partial: true, completedTokens: 1, failedTokens: 2, noEligiblePools: 1, unverifiedPools: 1 });
  });

  it("does not treat missing volume as a real zero", async () => {
    const { scanner } = setup([asset(1)], () => [{ ...pair(1), volume: undefined }]);
    expect((await scanner.scanStocks()).stockCoverage).toMatchObject({ failedTokens: 1, belowVolumeTokens: 0, partial: true });
  });

  it("retains qualified pools when known volume already passes despite another pool missing volume", async () => {
    const { scanner } = setup([asset(1)], () => [pair(1), { ...pair(2), volume: null }]);
    const scan = await scanner.scanStocks();
    expect(scan.pools).toHaveLength(1);
    expect(scan.stockCoverage).toMatchObject({ partial: true, failedTokens: 1, unverifiedPools: 1, belowVolumeTokens: 0 });
  });

  it("limits simultaneous pool verification to three and excludes inactive liquidity", async () => {
    const { scanner, internals } = setup(Array.from({ length: 6 }, (_, i) => asset(i + 1)), (url) => {
      const token = url.split("/").at(-1)!;
      return [pair(Number(BigInt(token)), token)];
    });
    let active = 0;
    let peak = 0;
    internals.verifyPool.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { activeLiquidity: false, feeTier: 3000 };
    });
    const scan = await scanner.scanStocks();
    expect(peak).toBe(3);
    expect(scan.pools).toHaveLength(0);
    expect(scan.qualifiedTokens).toBe(0);
    expect(scan.stockCoverage).toMatchObject({ completedTokens: 6, partial: false });
  });

  it("uses last valid registry on empty/malformed response and does not replace the cache", async () => {
    const { scanner, fetchMock, internals } = setup();
    const first = await scanner.scanStocks();
    for (const body of [{ assets: [] }, { assets: [asset(2), { deployments: null }] }, { assets: [{ ...asset(2), deployments: [{ chainId: 4663, contractAddress: "bad" }] }] }]) {
      fetchMock.mockImplementation(async (url: string) => {
        internals.nextStockRequestAt = 0;
        return new Response(JSON.stringify(url.includes("rhj/assets") ? body : []));
      });
      const fallback = await scanner.scanStocks();
      expect(fallback.candidateTokens).toBe(1);
      expect(fallback.stockCoverage).toMatchObject({ source: "cache", partial: true, fetchedAt: first.stockCoverage!.fetchedAt });
    }
  });

  it("labels seed fallback on a cold start when the registry fails", async () => {
    const { scanner, fetchMock, internals } = setup();
    fetchMock.mockImplementation(async (url: string) => {
      internals.nextStockRequestAt = 0;
      return url.includes("rhj/assets") ? new Response("blocked", { status: 403 }) : new Response("[]");
    });
    const scan = await scanner.scanStocks();
    expect(scan.candidateTokens).toBe(ROBINHOOD_STOCK_TOKENS.length);
    expect(scan.stockCoverage).toMatchObject({ source: "seeds", partial: true });
    expect(scan.stockCoverage!.fetchedAt).toBeUndefined();
  });

  it.each([429, 503, "timeout"])("retries %s at most twice", async (failure) => {
    vi.useFakeTimers();
    const { internals, fetchMock } = setup();
    fetchMock.mockImplementation(async () => {
      if (failure === "timeout") throw new DOMException("timeout", "TimeoutError");
      return new Response("unavailable", { status: failure as number });
    });
    const pending = expect(internals.fetchStockJson("https://example.test")).rejects.toThrow();
    await vi.runAllTimersAsync();
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("recovers after transient HTTP failure", async () => {
    vi.useFakeTimers();
    const { internals, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "1" } }));
    const pending = internals.fetchStockJson("https://example.test");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("stock Telegram summary", () => {
  it("uses configured threshold, distinguishes partial empty data and bounds long symbols", async () => {
    const { scanner } = setup();
    const scan = await scanner.scanStocks(undefined, "robinhood", 0.25);
    scan.stockCoverage!.partial = true;
    scan.stockSymbols = Array.from({ length: 450 }, () => "LONG_SYMBOL");
    const text = formatStockScan(scan);
    expect(text).toContain("yield/h > 0.25%");
    expect(text).toContain("pada data yang berhasil diperiksa");
    expect(text).toContain("Coverage parsial");
    expect(text.length).toBeLessThan(4096);
  });

  it("fits all 10 pool entries and total into one Telegram message", async () => {
    const { scanner } = setup([asset(1)], () => Array.from({ length: 12 }, (_, i) => pair(i + 1)));
    const scan: PoolMarketScan = await scanner.scanStocks();
    scan.pools.forEach((pool) => { pool.pair = "X".repeat(500); });
    scan.stockSymbols = Array.from({ length: 450 }, () => "LONG_SYMBOL");
    const text = formatStockScan(scan);
    expect(text).toContain("Top 10 dari 12 pool lolos");
    expect(text).toContain("10. V4");
    expect(text.length).toBeLessThan(4096);
  });
});
