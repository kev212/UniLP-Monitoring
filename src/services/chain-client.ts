import { createPublicClient, fallback, http, webSocket, type Address, type PublicClient } from "viem";

import { chainRegistry, type ChainRegistry } from "../chains.js";
import type { RuntimeConfig } from "../config.js";
import type { ChainName } from "../types.js";

export interface ChainClient {
  registry: ChainRegistry;
  client: PublicClient;
}

export class ChainClients {
  private readonly clients = new Map<ChainName, ChainClient>();
  private readonly tokenMetadata = new Map<string, { decimals: number; symbol: string }>();

  constructor(config: RuntimeConfig) {
    for (const name of config.chains) {
      const registry = chainRegistry[name];
      const wsUrl = config.rpcWss[name];
      const primary = config.rpcHttp[name];
      const fallbackUrl = config.rpcHttpFallback[name];
      const fallbackUrls = fallbackUrl ? [fallbackUrl] : [];
      this.clients.set(name, {
        registry,
        client: createPublicClient({
          chain: registry.chain,
          transport: wsUrl
            ? webSocket(wsUrl, { retryCount: 3, retryDelay: 250, timeout: 20_000 })
            : fallbackUrls.length > 0
              ? fallback([http(primary, { retryCount: 3, timeout: 20_000 }), http(fallbackUrl, { retryCount: 3, timeout: 20_000 })], { retryCount: 1 })
              : http(primary, { retryCount: 3, timeout: 20_000 }),
          pollingInterval: 4_000,
        }),
      });
    }
  }

  get(name: ChainName): ChainClient {
    const item = this.clients.get(name);
    if (!item) throw new Error(`Chain ${name} is not enabled`);
    return item;
  }

  getById(chainId: number): ChainClient {
    for (const item of this.clients.values()) {
      if (item.registry.chain.id === chainId) return item;
    }
    throw new Error(`Chain ID ${chainId} is not enabled`);
  }

  cacheToken(address: Address, metadata: { decimals: number; symbol: string }): void {
    this.tokenMetadata.set(address.toLowerCase(), metadata);
  }

  getCachedToken(address: Address): { decimals: number; symbol: string } | undefined {
    return this.tokenMetadata.get(address.toLowerCase());
  }
}
