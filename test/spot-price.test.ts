import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";

import type { RuntimeConfig } from "../src/config.js";
import { ROBINHOOD_USDG_WETH_POOL, SpotPriceService } from "../src/services/spot-price.js";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
const OTHER = "0x0000000000000000000000000000000000000009" as Address;
const Q96 = 1n << 96n;

function config(): RuntimeConfig {
  return {
    chains: ["robinhood"],
    quoteTokens: {
      base: [],
      robinhood: [{ symbol: "USDG", address: USDG }, { symbol: "WETH", address: WETH }],
      bsc: [],
    },
  } as unknown as RuntimeConfig;
}

function success(token0: Address = WETH, token1: Address = USDG, sqrtPriceX96 = Q96): unknown[] {
  return [
    { status: "success", result: token0 },
    { status: "success", result: token1 },
    { status: "success", result: [sqrtPriceX96, 0, 0, 0, 0, 0, true] },
    { status: "success", result: 1n },
  ];
}

function failed(): unknown[] {
  return [
    { status: "failure", error: new Error("reverted") },
    { status: "failure", error: new Error("reverted") },
    { status: "failure", error: new Error("reverted") },
    { status: "failure", error: new Error("reverted") },
  ];
}

describe("SpotPriceService", () => {
  it("coalesces same-block reads and handles WETH/USDG orientation", async () => {
    const client = { multicall: vi.fn().mockResolvedValue(success()) };
    const service = new SpotPriceService({ getForMonitoring: () => ({ client }) } as never, config());

    const [first, second] = await Promise.all([
      service.quoteToUsd6(4663, WETH, USDG, 10n ** 18n, 100n),
      service.quoteToUsd6(4663, zeroAddress, USDG, 2n * 10n ** 18n, 100n),
    ]);

    expect(first).toBe(10n ** 18n);
    expect(second).toBe(2n * 10n ** 18n);
    expect(client.multicall).toHaveBeenCalledOnce();
    expect(client.multicall).toHaveBeenCalledWith(expect.objectContaining({
      blockNumber: 100n,
      multicallAddress: "0xca11bde05977b3631167028862be2a173976ca11",
    }));
  });

  it("supports reverse token orientation and bounded stale fallback", async () => {
    let now = 1_000;
    const client = { multicall: vi.fn()
      .mockResolvedValueOnce(success(USDG, WETH))
      .mockResolvedValueOnce(failed())
      .mockResolvedValueOnce(failed()) };
    const service = new SpotPriceService({ getForMonitoring: () => ({ client }) } as never, config(), () => now);

    expect(await service.quoteToUsd6(4663, WETH, USDG, 123n, 1n)).toBe(123n);
    now += 1_000;
    expect(await service.quoteToUsd6(4663, WETH, USDG, 123n, 2n)).toBe(123n);
    expect(client.multicall.mock.calls[0]?.[0].contracts).toHaveLength(4);
    expect(client.multicall.mock.calls[1]?.[0].contracts).toHaveLength(2);
    now += 180_001;
    expect(await service.quoteToUsd6(4663, WETH, USDG, 123n, 3n)).toBeNull();
  });

  it("keeps the pool's six-decimal USDG output units for an 18-decimal WETH input", async () => {
    const client = { multicall: vi.fn().mockResolvedValue(success(WETH, USDG, Q96 / 1_000_000n)) };
    const service = new SpotPriceService({ getForMonitoring: () => ({ client }) } as never, config());

    // A raw ratio of 1e-12 means roughly 1 USDG for 1 WETH after the
    // 18-to-6 decimal conversion encoded by the V3 sqrt price.
    await expect(service.quoteToUsd6(4663, WETH, USDG, 10n ** 18n, 1n)).resolves.toBe(999_999n);
  });

  it("does not claim coverage for unsupported pairs or chains", async () => {
    const client = { multicall: vi.fn().mockResolvedValue(success()) };
    const service = new SpotPriceService({ getForMonitoring: () => ({ client }) } as never, config());

    await expect(service.quoteToUsd6(4663, OTHER, USDG, 1n, 1n)).resolves.toBeUndefined();
    await expect(service.quoteToUsd6(8453, WETH, USDG, 1n, 1n)).resolves.toBeUndefined();
    expect(client.multicall).not.toHaveBeenCalled();
    expect(ROBINHOOD_USDG_WETH_POOL).toBe("0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca");
  });
});
