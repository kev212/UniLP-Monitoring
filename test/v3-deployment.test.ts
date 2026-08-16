import { describe, expect, it } from "vitest";

import { chainRegistry } from "../src/chains.js";
import { dexNameFromMetadata, resolveV3Dex, v3ContractsFor, v3Deployments } from "../src/services/v3-deployment.js";

describe("V3 deployments", () => {
  it("resolves Pancake and Uniswap V3 contracts on BSC", () => {
    const registry = chainRegistry.bsc;
    expect(v3Deployments(registry).map((item) => item.dex)).toEqual(["uniswap", "pancake"]);
    expect(v3ContractsFor(registry, "pancake").factory).toBe("0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865");
    expect(resolveV3Dex(registry, registry.pancakeV3!.positionManager)).toBe("pancake");
    expect(resolveV3Dex(registry, registry.contracts.v3.factory)).toBe("uniswap");
    expect(dexNameFromMetadata({ dex: "pancake" })).toBe("pancake");
    expect(dexNameFromMetadata({})).toBe("uniswap");
  });

  it("does not expose Pancake V3 on Robinhood", () => {
    expect(chainRegistry.robinhood.pancakeV3).toBeUndefined();
    expect(v3Deployments(chainRegistry.robinhood)).toEqual([
      { dex: "uniswap", contracts: chainRegistry.robinhood.contracts.v3 },
    ]);
  });
});
