import { describe, expect, it } from "vitest";
import { decodeAbiParameters, type Address } from "viem";

import { encodeV4MintParams } from "../src/services/position-opener.js";

describe("V4 position mint encoding", () => {
  it("encodes the pool key as a structured tuple accepted by viem", () => {
    const currency0 = "0x0000000000000000000000000000000000000001" as Address;
    const currency1 = "0x0000000000000000000000000000000000000002" as Address;
    const hooks = "0x0000000000000000000000000000000000000003" as Address;
    const owner = "0x0000000000000000000000000000000000000004" as Address;
    const encoded = encodeV4MintParams(
      { currency0, currency1, fee: 3000, tickSpacing: 60, hooks },
      -120,
      120,
      123456n,
      100n,
      0n,
      owner,
    );

    const [poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, decodedOwner, hookData] = decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
        { type: "int24" },
        { type: "int24" },
        { type: "uint256" },
        { type: "uint128" },
        { type: "uint128" },
        { type: "address" },
        { type: "bytes" },
      ],
      encoded,
    );

    expect(poolKey).toEqual({ currency0, currency1, fee: 3000, tickSpacing: 60, hooks });
    expect([tickLower, tickUpper, liquidity, amount0Max, amount1Max, decodedOwner, hookData]).toEqual([-120, 120, 123456n, 100n, 0n, owner, "0x"]);
  });
});
