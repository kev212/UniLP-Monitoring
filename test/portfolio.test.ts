import { zeroAddress, type Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfig } from "../src/config.js";
import type { Database } from "../src/db.js";
import type { ChainClients } from "../src/services/chain-client.js";
import { PortfolioService } from "../src/services/portfolio.js";
import { chainRegistry } from "../src/chains.js";
import type { ChainName, PositionRecord } from "../src/types.js";
import type { PositionReader, PositionValue } from "../src/services/position-reader.js";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;

afterEach(() => vi.unstubAllGlobals());

describe("PortfolioService", () => {
  it("derives WETH and native ETH USD prices from the most liquid USDG/WETH pair", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          pairs: [{
            baseToken: { address: USDG },
            quoteToken: { address: WETH },
            priceUsd: "1.00089",
            priceNative: "0.0005317",
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
      }));
    const service = new PortfolioService({
      quoteTokens: {
        robinhood: [{ address: USDG, symbol: "USDG" }, { address: WETH, symbol: "WETH" }],
      },
    } as RuntimeConfig, {} as ChainClients, {} as Database);

    const prices = await (service as unknown as { tokenPrices(chain: "robinhood", addresses: Address[]): Promise<Map<string, number>> })
      .tokenPrices("robinhood", [WETH]);

    expect(prices.get(WETH.toLowerCase())).toBeCloseTo(1.00089 / 0.0005317, 8);
    expect(prices.get(zeroAddress)).toBeCloseTo(1.00089 / 0.0005317, 8);

    const cachedPrices = await (service as unknown as { tokenPrices(chain: "robinhood", addresses: Address[]): Promise<Map<string, number>> })
      .tokenPrices("robinhood", [WETH]);
    expect(cachedPrices.get(WETH.toLowerCase())).toBeCloseTo(1.00089 / 0.0005317, 8);
  });
});

// Exercise full refreshes without live RPC/API calls.
const OWNER = "0x0000000000000000000000000000000000000001" as Address;
const POOL = "0x0000000000000000000000000000000000000002" as Address;
const OTHER = "0x0000000000000000000000000000000000000003" as Address;
const lower = (address: Address) => address.toLowerCase() as Address;
const token = (address: Address, amount: bigint) => ({ contractAddress: address, tokenBalance: `0x${amount.toString(16)}` });
function position(overrides: Partial<PositionRecord> = {}): PositionRecord {
  return { id: "p1", chainId: 4663, protocol: "v3", positionKey: "1", owner: OWNER,
    poolAddress: POOL, token0: USDG, token1: OTHER, quoteToken: USDG, status: "armed",
    liquidity: 1n, openedAtBlock: 1n, metadata: {}, ...overrides };
}
function lpValue(amount = 100_000_000n, fees = 5_000_000n): PositionValue {
  return { protocol: "v3", poolKey: POOL, sourcePool: POOL, token0: { token: USDG, amount },
    token1: { token: OTHER, amount: 0n }, liquidity: amount ? 1n : 0n, priceMarker: 1n << 96n,
    minAmount0: 0n, minAmount1: 0n, unclaimedFees0: fees, unclaimedFees1: 0n, observedBlock: 100n };
}
function harness(active: ChainName[] = ["robinhood"]) {
  const rows: PositionRecord[] = [];
  const groupRows: unknown[] = [];
  let items = [token(USDG, 20_000_000n)];
  const client = {
    getBlockNumber: vi.fn().mockResolvedValue(100n),
    getBalance: vi.fn().mockResolvedValue(10n ** 18n),
    readContract: vi.fn(async ({ address }: { address: Address }) => lower(address) === lower(USDG) ? 6 : 18),
    multicall: vi.fn(async ({ contracts }: { contracts: Array<{ functionName: string }> }) => contracts.map(c => ({
      status: "success", result: c.functionName === "ownerOf" ? OWNER : ("address" in c && lower((c as { address: Address }).address) === lower(OTHER) ? 0n : 20_000_000n),
    }))),
  };
  const chains = {
    getForScan: vi.fn((chain: ChainName) => ({ client, registry: chainRegistry[chain] })),
    getById: vi.fn((id: number) => ({ client, registry: Object.values(chainRegistry).find(c => c.chain.id === id)! })),
  };
  const db = { listActivePositions: vi.fn(async (id: number) => rows.filter(p => p.chainId === id)), listPositionGroups: vi.fn(async () => groupRows) };
  const reader = {
    getPortfolioValue: vi.fn().mockReturnValue(undefined),
    read: vi.fn().mockResolvedValue(lpValue()),
    readGroup: vi.fn(async (_g: unknown, children: unknown[]) => children.map(() => lpValue())),
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return { ok: true, json: async () => ({ result: { tokenBalances: items } }) };
    if (url.includes("latest/dex")) return { ok: true, json: async () => ({ pairs: [{
      baseToken: { address: USDG }, quoteToken: { address: WETH }, priceUsd: "1", priceNative: "0.0005",
    }] }) };
    return { ok: true, json: async () => active.map(chain => ({ baseToken: { address: chainRegistry[chain].wrappedNative }, priceUsd: "2000" })) };
  });
  vi.stubGlobal("fetch", fetchMock);
  const config = { chains: active, executorAddress: OWNER,
    alchemyHttp: Object.fromEntries(active.map(c => [c, `https://alchemy.test/${c}`])),
    quoteTokens: Object.fromEntries(active.map(c => [c, [{ address: USDG, symbol: "USDG" }]])),
  } as RuntimeConfig;
  const service = new PortfolioService(config, chains as unknown as ChainClients, db as unknown as Database, reader as unknown as PositionReader);
  return { service, rows, groupRows, client, chains, db, reader, fetchMock, config, setItems: (value: typeof items) => { items = value; } };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("portfolio totals and RPC budget", () => {
  it("counts LP principal + unclaimed fees + all wallet tokens, only on RH", async () => {
    const h = harness(); h.rows.push(position({ status: "paused" }));
    await h.service.refresh();
    expect(h.service.getSnapshot()).toMatchObject({ activeLpUsd: 105, walletUsd: 2020, totalUsd: 2125, complete: true });
    expect(h.chains.getForScan.mock.calls.every(([chain]) => chain === "robinhood")).toBe(true);
    expect(h.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(h.client.multicall.mock.calls.flatMap(([request]) => request.contracts).every(c => c.functionName === "ownerOf")).toBe(true);
    expect(h.client.getBalance).toHaveBeenCalledWith({ address: OWNER, blockNumber: 100n });
    expect(h.reader.read).toHaveBeenCalledWith(h.rows[0], 100n, 0, "scan", true);
    expect(h.client.multicall).toHaveBeenCalledWith(expect.objectContaining({ multicallAddress: "0xca11bde05977b3631167028862be2a173976ca11" }));
  });

  it("refreshes every 180 seconds and shares in-flight work and dashboard cache", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    const h = harness();
    h.service.start(); await h.service.ensureFresh();
    await Promise.all([h.service.ensureFresh(), h.service.ensureFresh()]);
    await vi.advanceTimersByTimeAsync(179_999);
    expect(h.db.listActivePositions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.db.listActivePositions).toHaveBeenCalledTimes(2);
    expect(h.client.readContract).toHaveBeenCalledTimes(1); // decimals cached
    h.service.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.db.listActivePositions).toHaveBeenCalledTimes(2);
  });

  it("deduplicates paginated balances and sends pageKey only to the active Alchemy endpoint", async () => {
    const h = harness();
    h.fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        expect(url).toBe("https://alchemy.test/robinhood");
        const body = JSON.parse(String(init.body));
        return { ok: true, json: async () => ({ result: { tokenBalances: [token(USDG, 20_000_000n)], ...(body.params[2] ? {} : { pageKey: "page2" }) } }) };
      }
      return { ok: true, json: async () => ({ pairs: [{ baseToken: { address: USDG }, quoteToken: { address: WETH }, priceUsd: "1", priceNative: "0.0005" }] }) };
    });
    await h.service.refresh();
    expect(h.service.getSnapshot().walletUsd).toBe(2020);
    expect(h.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });

  it("counts group children once, includes closing groups, excludes another owner's positions", async () => {
    const h = harness();
    h.rows.push(position({ metadata: { managedBy: "position_group", positionGroupId: "g1" } }), position({ id: "duplicate" }), position({ id: "foreign", positionKey: "2", owner: OTHER }));
    h.groupRows.push({ id: "g1", owner: OWNER, status: "closing" });
    await h.service.refresh();
    expect(h.service.getSnapshot().activeLpUsd).toBe(105);
    expect(h.reader.readGroup).toHaveBeenCalledOnce();
    expect(h.reader.read).not.toHaveBeenCalled();
  });

  it("excludes V2 receipt tokens from the wallet and reuses same-block monitoring values", async () => {
    const h = harness(); h.rows.push(position({ protocol: "v2", positionKey: POOL }));
    h.setItems([token(USDG, 20_000_000n), token(POOL, 100n)]);
    h.reader.getPortfolioValue.mockReturnValue(lpValue());
    await h.service.refresh();
    expect(h.service.getSnapshot()).toMatchObject({ walletUsd: 2020, activeLpUsd: 105 });
    expect(h.reader.read).not.toHaveBeenCalled();
    expect(h.client.multicall).not.toHaveBeenCalled();
  });

  it("reconciles a withdrawal at the LP block instead of double counting latest wallet funds", async () => {
    const h = harness(); h.rows.push(position({ status: "closing" }));
    h.setItems([token(USDG, 125_000_000n)]); // latest wallet is after the withdrawal
    h.client.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValueOnce(101n);
    await h.service.refresh(); // block 100 still has LP and only $20 wallet tokens
    expect(h.service.getSnapshot().totalUsd).toBeCloseTo(2125);
    h.reader.read.mockResolvedValue(lpValue(0n, 0n));
    h.client.getBlockNumber.mockResolvedValue(102n);
    await h.service.refresh(); // block 102 has the withdrawn funds and no LP
    expect(h.service.getSnapshot()).toMatchObject({ activeLpUsd: 0, walletUsd: 2125, totalUsd: 2125 });
  });

  it("falls back to known balanceOf calls, marks missing enumeration, and recovers", async () => {
    const h = harness();
    const original = h.fetchMock.getMockImplementation()!;
    h.fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === "POST") throw new Error("Unsupported endpoint");
      return original(url, init);
    });
    await h.service.refresh();
    expect(h.service.getSnapshot()).toMatchObject({ walletUsd: 2020, complete: false });
    expect(h.client.multicall).toHaveBeenCalledOnce();
    expect(h.client.multicall).toHaveBeenCalledWith(expect.objectContaining({ multicallAddress: "0xca11bde05977b3631167028862be2a173976ca11" }));
    h.fetchMock.mockImplementation(original);
    await h.service.refresh();
    expect(h.service.getSnapshot().complete).toBe(true);
  });

  it("marks unpriced tokens incomplete and keeps the old timestamp on RPC failure", async () => {
    const h = harness(); h.setItems([token(OTHER, 10n ** 18n)]);
    await h.service.refresh();
    expect(h.service.getSnapshot()).toMatchObject({ walletUsd: 2000, complete: false });
    expect(h.service.getSnapshot().issues.join()).toContain("harga USD");
    const updatedAt = h.service.getSnapshot().updatedAt;
    h.client.getBalance.mockRejectedValue(new Error("RPC down"));
    await h.service.refresh();
    expect(h.service.getSnapshot().updatedAt).toEqual(updatedAt);
    expect(h.service.getSnapshot().issues.join()).toContain("Refresh gagal");
  });

  it.each(["base", "bsc"] as ChainName[])("prices native and wrapped coin on %s", async chain => {
    const h = harness([chain]); h.setItems([token(chainRegistry[chain].wrappedNative, 2n * 10n ** 18n)]);
    await h.service.refresh();
    expect(h.service.getSnapshot()).toMatchObject({ totalUsd: 6000, complete: true });
  });

  it("sums enabled chains and isolates metadata by chain", async () => {
    const h = harness(["base", "bsc"]);
    await h.service.refresh();
    expect(h.service.getSnapshot().totalUsd).toBe(4040);
    expect(h.client.readContract).toHaveBeenCalledTimes(2);
  });

  it("does not count transferred NFTs, and reports unreadable LPs", async () => {
    const h = harness(); h.rows.push(position());
    h.client.multicall.mockResolvedValueOnce([{ status: "success", result: OTHER }]);
    await h.service.refresh();
    expect(h.service.getSnapshot().activeLpUsd).toBe(0);
    expect(h.reader.read).not.toHaveBeenCalled();
    h.reader.read.mockRejectedValue(new Error("unavailable"));
    await h.service.refresh();
    expect(h.service.getSnapshot().complete).toBe(false);
  });
});
