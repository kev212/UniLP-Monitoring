import { describe, expect, it, vi } from "vitest";

import { chainRegistry } from "../src/chains.js";
import { DiscoveryService } from "../src/services/discovery.js";

describe("historical discovery reads", () => {
  it("uses the archive scan client for V4 historical price reads", async () => {
    const regularClient = { readContract: vi.fn() };
    const archiveClient = { readContract: vi.fn().mockResolvedValue([1n << 96n, 0, 0, 0]) };
    const discovery = new DiscoveryService(
      {} as never,
      {
        getById: vi.fn(() => ({ registry: chainRegistry.robinhood, client: regularClient })),
        getForScan: vi.fn(() => ({ registry: chainRegistry.robinhood, client: archiveClient })),
      } as never,
      {} as never,
    );
    const position = {
      chainId: 4663,
      token0: "0x0000000000000000000000000000000000000001",
      token1: "0x0000000000000000000000000000000000000002",
      quoteToken: "0x0000000000000000000000000000000000000002",
      metadata: {
        currency0: "0x0000000000000000000000000000000000000001",
        currency1: "0x0000000000000000000000000000000000000002",
        fee: 42500,
        tickSpacing: 425,
        hooks: "0x0000000000000000000000000000000000000000",
      },
    };

    const value = await (discovery as unknown as {
      quoteV4AmountsAtBlock(position: typeof position, amount0: bigint, amount1: bigint, blockNumber: bigint): Promise<bigint>;
    }).quoteV4AmountsAtBlock(position, 10n, 20n, 123n);

    expect(value).toBe(30n);
    expect(archiveClient.readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 123n }));
    expect(regularClient.readContract).not.toHaveBeenCalled();
  });
});
