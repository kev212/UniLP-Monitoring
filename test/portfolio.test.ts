import { zeroAddress, type Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfig } from "../src/config.js";
import type { Database } from "../src/db.js";
import type { ChainClients } from "../src/services/chain-client.js";
import { PortfolioService } from "../src/services/portfolio.js";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;

afterEach(() => vi.unstubAllGlobals());

describe("PortfolioService", () => {
  it("derives WETH and native ETH USD prices from the most liquid USDG/WETH pair", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          baseToken: { address: USDG },
          quoteToken: { address: WETH },
          priceUsd: "1",
          priceNative: "0.0005",
          liquidity: { usd: 100 },
        },
        {
          baseToken: { address: USDG },
          quoteToken: { address: WETH },
          priceUsd: "1.00089",
          priceNative: "0.0005317",
          liquidity: { usd: 5_872_334 },
        },
      ],
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
  });
});
