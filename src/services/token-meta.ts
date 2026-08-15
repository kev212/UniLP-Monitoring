import { zeroAddress, type Address } from "viem";

import { chainRegistry, isWrappedNative, registryByChainId, type ChainRegistry } from "../chains.js";
import type { ChainName } from "../types.js";

export const USD6_SCALE = 1_000_000n;
const USD_STABLE_SYMBOLS = new Set(["USDG", "USDC", "USDT"]);

export function isUsdStableSymbol(symbol: string | undefined): boolean {
  return Boolean(symbol && USD_STABLE_SYMBOLS.has(symbol.toUpperCase()));
}

export function normalizeToUsd6(rawAmount: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("Token decimals must be an integer between 0 and 36");
  }
  if (decimals === 6) return rawAmount;
  if (decimals > 6) return rawAmount / (10n ** BigInt(decimals - 6));
  return rawAmount * (10n ** BigInt(6 - decimals));
}

export function registryForChain(nameOrId: ChainName | number): ChainRegistry {
  if (typeof nameOrId === "number") {
    const registry = registryByChainId(nameOrId);
    if (!registry) throw new Error(`Unsupported chain ID ${nameOrId}`);
    return registry;
  }
  return chainRegistry[nameOrId];
}

export function nativeLabel(registry: ChainRegistry, address: Address): string | undefined {
  if (address.toLowerCase() === zeroAddress) return registry.nativeSymbol;
  if (isWrappedNative(registry, address)) return registry.wrappedSymbol;
  return undefined;
}

export function isNativeOrWrapped(registry: ChainRegistry, address: Address): boolean {
  return address.toLowerCase() === zeroAddress || isWrappedNative(registry, address);
}
