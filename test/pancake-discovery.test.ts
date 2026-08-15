import { describe, expect, it } from "vitest";

import { chainRegistry, isEligibleScanDex, isProtocolDeployed } from "../src/chains.js";

describe("BSC Uniswap V4 registry", () => {
  it("replaces PancakeSwap with official Uniswap V4 deployments", () => {
    const registry = chainRegistry.bsc;
    expect(registry.dex).toBe("uniswap");
    expect(registry.discoveryProtocols).toEqual(["v3", "v4"]);
    expect(registry.monitoringEnabled).toBe(true);
    expect(registry.aliases).toEqual(["bsc", "bnb"]);
    expect(registry.uniswapSlug).toBe("bnb");
    expect(registry.nativeSymbol).toBe("BNB");
    expect(registry.wrappedSymbol).toBe("WBNB");
    expect(registry.quotePriority).toEqual(["USDT", "WBNB", "BNB"]);
    expect(registry.contracts.v4.poolManager).toBe("0x28e2ea090877bf75740558f6bfb36a5ffee9e9df");
    expect(registry.contracts.v4.positionManager).toBe("0x7a4a5c919ae2541aed11041a1aeee68f1287f95b");
    expect(registry.contracts.v4.quoter).toBe("0x9f75dd27d6664c475b90e105573e550ff69437b0");
    expect(registry.contracts.v4.stateView).toBe("0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4");
    expect(registry.contracts.v4.universalRouter).toBe("0x1906c1d672b88cd1b9ac7593301ca990f94eae07");
    expect(registry.contracts.v3.factory).toBe("0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7");
    expect(registry.contracts.v3.positionManager).toBe("0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613");
    expect(isProtocolDeployed(registry, "v3")).toBe(true);
    expect(isProtocolDeployed(registry, "v4")).toBe(true);
    expect(isEligibleScanDex(registry, "uniswap-v4-bsc")).toBe(true);
    expect(isEligibleScanDex(registry, "uniswap-v3-bsc")).toBe(true);
    expect(isEligibleScanDex(registry, "uniswap-bsc")).toBe(true);
    expect(isEligibleScanDex(registry, "uniswap-v2-bsc")).toBe(false);
    expect(isEligibleScanDex(registry, "pancakeswap-v3-bsc")).toBe(false);
  });
});
