import { describe, expect, it } from "vitest";

import { parseAssetTransfer } from "../src/services/alchemy-bootstrap.js";

describe("Alchemy asset transfer parsing", () => {
  it("normalizes a wallet NFT activity", () => {
    const activity = parseAssetTransfer({
      category: "erc721",
      blockNum: "0x1234",
      hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      from: "0x0000000000000000000000000000000000000000",
      to: "0x0000000000000000000000000000000000000001",
      tokenId: "0x2a",
      rawContract: { address: "0x0000000000000000000000000000000000000002" },
    });

    expect(activity).toMatchObject({
      asset: "0x0000000000000000000000000000000000000002",
      blockNumber: 4_660n,
      tokenId: 42n,
      category: "erc721",
    });
  });

  it("rejects incomplete provider records", () => {
    expect(parseAssetTransfer({ category: "erc20", blockNum: "0x1" })).toBeNull();
  });
});
