import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";

import type { RuntimeConfig } from "../src/config.js";
import { Executor } from "../src/services/executor.js";
import type { PositionRecord } from "../src/types.js";

const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const token = "0xd7321801caae694090694ff55a9323139f043b88" as const;
const owner = "0xeE924367213Ae3764b57d5b9a6214c8188d34060" as const;

const config = {
  executorAddress: owner,
  executorPrivateKey: undefined,
  dryRun: true,
  quoteTokens: { base: [], robinhood: [{ symbol: "USDG", address: usdg }] },
} as RuntimeConfig;

describe("Executor pending settlement recovery", () => {
  it("restores a V4 quote token and pair from burned-position metadata", async () => {
    const database = { repairPositionAssets: vi.fn(), setPositionStatus: vi.fn() };
    const chains = { getById: vi.fn(() => ({ registry: { name: "robinhood" } })) };
    const notifier = { failure: vi.fn() };
    const executor = new Executor(database as never, chains as never, {} as never, {} as never, notifier as never, config);
    const position: PositionRecord = {
      id: "position",
      chainId: 4663,
      protocol: "v4",
      positionKey: "31470",
      owner,
      poolAddress: null,
      token0: "0x" as Address,
      token1: "0x" as Address,
      quoteToken: null,
      status: "closing",
      liquidity: null,
      openedAtBlock: null,
      metadata: { currency0: usdg, currency1: token },
    };

    const recovered = await (executor as unknown as { recoverSettlementPosition(value: PositionRecord): Promise<PositionRecord | null> }).recoverSettlementPosition(position);

    expect(recovered).toMatchObject({ token0: usdg, token1: token, quoteToken: usdg });
    expect(database.repairPositionAssets).toHaveBeenCalledWith("position", usdg, token, usdg);
    expect(database.setPositionStatus).not.toHaveBeenCalled();
  });

  it("reads native ETH with getBalance instead of ERC-20 balanceOf", async () => {
    const client = { getBalance: vi.fn().mockResolvedValue(123n), readContract: vi.fn() };
    const chains = { getById: vi.fn(() => ({ client })) };
    const executor = new Executor({} as never, chains as never, {} as never, {} as never, {} as never, config);

    const balance = await (executor as unknown as {
      assetBalance(chainId: number, account: Address, tokenAddress: Address): Promise<bigint>;
    }).assetBalance(4663, owner, zeroAddress);

    expect(balance).toBe(123n);
    expect(client.getBalance).toHaveBeenCalledWith({ address: owner });
    expect(client.readContract).not.toHaveBeenCalled();
  });
});
