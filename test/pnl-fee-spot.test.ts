import { describe, expect, it, vi } from "vitest";
import { type Address } from "viem";

import type { RuntimeConfig } from "../src/config.js";
import { PnlService } from "../src/services/pnl.js";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;

const config = {
  chains: ["robinhood"],
  quoteTokens: { base: [], robinhood: [{ symbol: "USDG", address: USDG }], bsc: [] },
} as unknown as RuntimeConfig;

describe("PnL fee spot conversion", () => {
  it("uses the cached spot provider without calling a swap route", async () => {
    const spot = { quoteToUsd6: vi.fn().mockResolvedValue(250n) };
    const convert = vi.fn().mockResolvedValue({ expectedOut: 999n });
    const pnl = new PnlService({} as never, {} as never, {} as never, config, undefined, undefined, spot);

    const fee = await (pnl as unknown as {
      toFeeUsd6(chainId: number, quoteToken: Address, feeQuote: bigint, convert: typeof convert, blockNumber: bigint): Promise<bigint>;
    }).toFeeUsd6(4663, WETH, 10n, convert, 100n);

    expect(fee).toBe(250n);
    expect(spot.quoteToUsd6).toHaveBeenCalledWith(4663, WETH, USDG, 10n, 100n);
    expect(convert).not.toHaveBeenCalled();
  });

  it("falls back to the existing converter for an unsupported pair", async () => {
    const spot = { quoteToUsd6: vi.fn().mockResolvedValue(undefined) };
    const convert = vi.fn().mockResolvedValue({ expectedOut: 999n });
    const pnl = new PnlService({} as never, {} as never, {} as never, config, undefined, undefined, spot);

    const fee = await (pnl as unknown as {
      toFeeUsd6(chainId: number, quoteToken: Address, feeQuote: bigint, convert: typeof convert, blockNumber: bigint): Promise<bigint>;
    }).toFeeUsd6(4663, WETH, 10n, convert, 100n);

    expect(fee).toBe(999n);
    expect(convert).toHaveBeenCalledOnce();
  });

  it("does not issue a route request when the covered spot price is temporarily unavailable", async () => {
    const spot = { quoteToUsd6: vi.fn().mockResolvedValue(null) };
    const convert = vi.fn().mockResolvedValue({ expectedOut: 999n });
    const pnl = new PnlService({} as never, {} as never, {} as never, config, undefined, undefined, spot);

    const fee = await (pnl as unknown as {
      toFeeUsd6(chainId: number, quoteToken: Address, feeQuote: bigint, convert: typeof convert, blockNumber: bigint): Promise<bigint>;
    }).toFeeUsd6(4663, WETH, 10n, convert, 100n);

    expect(fee).toBe(0n);
    expect(convert).not.toHaveBeenCalled();
  });
});
