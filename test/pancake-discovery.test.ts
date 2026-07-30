import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";

import { chainRegistry } from "../src/chains.js";
import { DiscoveryService, type NftActivity } from "../src/services/discovery.js";

const owner = "0x0000000000000000000000000000000000000001" as Address;
const token0 = "0x55d398326f99059fF775485246999027B3197955" as Address;
const token1 = "0x0000000000000000000000000000000000000002" as Address;
const pool = "0x0000000000000000000000000000000000000003" as Address;

function candidate(tokenId = 42n): NftActivity {
  return {
    asset: chainRegistry.bsc.contracts.v3.positionManager,
    transactionHash: `0x${"a".repeat(64)}`,
    blockNumber: 26_956_207n,
    from: zeroAddress,
    to: owner,
    tokenId,
    historyTrusted: true,
  };
}

describe("PancakeSwap V3 BSC discovery", () => {
  it("stores directly owned NFTs as detection-only positions", async () => {
    const client = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "ownerOf") return owner;
        if (functionName === "positions") return [0n, zeroAddress, token0, token1, 500, -100, 100, 123n, 0n, 0n, 0n, 0n];
        if (functionName === "getPool") return pool;
        throw new Error(`unexpected ${functionName}`);
      }),
    };
    const upsertPosition = vi.fn(async (value) => ({ id: "position", metadata: value.metadata, ...value }));
    const database = { upsertPosition };
    const chains = { get: vi.fn(() => ({ client, registry: chainRegistry.bsc })) };
    const config = {
      executorAddress: owner,
      quoteTokens: { bsc: [{ symbol: "USDT", address: token0 }] },
    };
    const discovery = new DiscoveryService(database as never, chains as never, config as never);

    const positions = await discovery.discoverV3Candidates("bsc", [candidate()]);

    expect(positions).toHaveLength(1);
    expect(upsertPosition).toHaveBeenCalledWith(expect.objectContaining({
      chainId: 56,
      protocol: "v3",
      positionKey: "42",
      owner,
      poolAddress: pool,
      quoteToken: token0,
      status: "needs_review",
      metadata: expect.objectContaining({ dex: "pancakeswap-v3", detectionOnly: true, reason: "detection_only_chain" }),
    }));
  });

  it("ignores NFTs no longer owned by the executor", async () => {
    const client = { readContract: vi.fn().mockResolvedValue("0x0000000000000000000000000000000000000009") };
    const upsertPosition = vi.fn();
    const discovery = new DiscoveryService(
      { upsertPosition } as never,
      { get: vi.fn(() => ({ client, registry: chainRegistry.bsc })) } as never,
      { executorAddress: owner, quoteTokens: { bsc: [] } } as never,
    );

    await expect(discovery.discoverV3Candidates("bsc", [candidate()])).resolves.toEqual([]);
    expect(upsertPosition).not.toHaveBeenCalled();
  });

  it("enumerates all Pancake V3 NFTs currently held by the executor", async () => {
    const tokenIds = [67n, 89n];
    const discovery = new DiscoveryService(
      {} as never,
      {
        get: vi.fn(() => ({
          registry: chainRegistry.bsc,
          client: {
            readContract: vi.fn(async ({ functionName, args }: { functionName: string; args: readonly bigint[] }) => {
              if (functionName === "balanceOf") return 2n;
              if (functionName === "tokenOfOwnerByIndex") return tokenIds[Number(args[1])]!;
              throw new Error(`unexpected ${functionName}`);
            }),
          },
        })),
      } as never,
      { executorAddress: owner } as never,
    );
    const discover = vi.spyOn(discovery, "discoverV3Candidates").mockResolvedValue([]);

    await discovery.discoverOwnedV3Positions("bsc", 100n);

    expect(discover).toHaveBeenCalledWith("bsc", [
      expect.objectContaining({ tokenId: 67n, blockNumber: 100n, historyTrusted: false }),
      expect.objectContaining({ tokenId: 89n, blockNumber: 100n, historyTrusted: false }),
    ]);
  });
});
