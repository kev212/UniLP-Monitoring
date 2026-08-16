import { type Address } from "viem";

import type { ChainRegistry, UniswapContracts } from "../chains.js";

export type DexName = "uniswap" | "pancake";
export type V3Contracts = UniswapContracts["v3"];

export function dexNameFromMetadata(metadata: Record<string, unknown> | undefined): DexName {
  return metadata?.dex === "pancake" ? "pancake" : "uniswap";
}

export function v3ContractsFor(registry: ChainRegistry, dex: DexName = "uniswap"): V3Contracts {
  if (dex === "pancake") {
    if (!registry.pancakeV3) throw new Error(`Pancake V3 is not deployed on ${registry.name}`);
    return registry.pancakeV3;
  }
  return registry.contracts.v3;
}

export function v3Deployments(registry: ChainRegistry): Array<{ dex: DexName; contracts: V3Contracts }> {
  const deployments: Array<{ dex: DexName; contracts: V3Contracts }> = [
    { dex: "uniswap", contracts: registry.contracts.v3 },
  ];
  if (registry.pancakeV3) deployments.push({ dex: "pancake", contracts: registry.pancakeV3 });
  return deployments.filter((item) => item.contracts.positionManager !== item.contracts.factory);
}

export function resolveV3Dex(registry: ChainRegistry, address: Address): DexName | null {
  const value = address.toLowerCase();
  if (registry.contracts.v3.factory.toLowerCase() === value || registry.contracts.v3.positionManager.toLowerCase() === value) {
    return "uniswap";
  }
  if (registry.pancakeV3
    && (registry.pancakeV3.factory.toLowerCase() === value || registry.pancakeV3.positionManager.toLowerCase() === value)) {
    return "pancake";
  }
  return null;
}

export function isKnownV3PositionManager(registry: ChainRegistry, address: Address): boolean {
  const value = address.toLowerCase();
  return registry.contracts.v3.positionManager.toLowerCase() === value
    || registry.pancakeV3?.positionManager.toLowerCase() === value;
}
