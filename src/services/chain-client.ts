import { createPublicClient, fallback, http, type Address, type PublicClient, type Transport } from "viem";

import { chainRegistry, type ChainRegistry } from "../chains.js";
import type { RuntimeConfig } from "../config.js";
import type { ChainName } from "../types.js";

export interface ChainClient {
  registry: ChainRegistry;
  client: PublicClient;
  transport: Transport;
}

const RPC_TIMEOUT_MS = 20_000;

function uniqueUrls(urls: readonly (string | undefined)[]): string[] {
  return [...new Set(urls.filter((url): url is string => Boolean(url)))];
}

/**
 * Keep RPC failover request-local and deterministic. A failed primary request
 * must reach the next provider immediately instead of retrying the same
 * throttled endpoint before fallback gets a chance.
 */
export function createRpcTransport(urls: readonly string[]): Transport {
  const endpoints = uniqueUrls(urls);
  if (endpoints.length === 0) throw new Error("At least one RPC endpoint is required");
  const transports = endpoints.map((url) => http(url, { retryCount: 0, timeout: RPC_TIMEOUT_MS }));
  if (transports.length === 1) return transports[0]!;
  return fallback(transports as [Transport, ...Transport[]], { retryCount: 0 });
}

export class ChainClients {
  private readonly clients = new Map<ChainName, ChainClient>();
  private readonly scanClients = new Map<ChainName, ChainClient>();
  private readonly logClients = new Map<ChainName, ChainClient>();
  private readonly executionClients = new Map<ChainName, ChainClient>();
  private readonly enabledChains: Set<ChainName>;
  private readonly tokenMetadata = new Map<string, { decimals: number; symbol: string }>();

  constructor(config: RuntimeConfig) {
    this.enabledChains = new Set(config.chains);
    for (const name of ["base", "robinhood", "bsc"] as const) {
      const registry = chainRegistry[name];
      const publicEndpoints = uniqueUrls([
        config.rpcHttp[name],
        config.rpcHttpFallback[name],
      ]);
      const normalTransport = createRpcTransport([
        ...publicEndpoints,
        ...(config.alchemyHttp[name] ? [config.alchemyHttp[name]] : []),
      ]);
      this.clients.set(name, {
        registry,
        transport: normalTransport,
        client: createPublicClient({
          chain: registry.chain,
          transport: normalTransport,
          pollingInterval: 4_000,
        }),
      });
      const scanTransport = createRpcTransport(uniqueUrls([
        config.rpcHttp[name],
        config.rpcHttpScanFallback?.[name],
        config.rpcHttpFallback[name],
      ]));
      this.scanClients.set(name, {
        registry,
        transport: scanTransport,
        client: createPublicClient({
          chain: registry.chain,
          transport: scanTransport,
          pollingInterval: 4_000,
        }),
      });
      const logTransport = createRpcTransport(uniqueUrls([
        config.rpcHttp[name],
        config.rpcHttpScanFallback?.[name],
        config.rpcHttpFallback[name],
      ]));
      this.logClients.set(name, {
        registry,
        transport: logTransport,
        client: createPublicClient({
          chain: registry.chain,
          transport: logTransport,
          pollingInterval: 4_000,
        }),
      });
      const executionTransport = createRpcTransport(uniqueUrls([
        config.alchemyHttp[name],
        ...publicEndpoints,
      ]));
      this.executionClients.set(name, {
        registry,
        transport: executionTransport,
        client: createPublicClient({
          chain: registry.chain,
          transport: executionTransport,
          pollingInterval: 4_000,
        }),
      });
    }
  }

  get(name: ChainName): ChainClient {
    const item = this.clients.get(name);
    if (!item || !this.enabledChains.has(name)) throw new Error(`Chain ${name} is not enabled`);
    return item;
  }

  getForScan(name: ChainName): ChainClient {
    const item = this.scanClients.get(name);
    if (!item) throw new Error(`Chain ${name} is not configured for scanning`);
    return item;
  }

  getForLogs(name: ChainName): ChainClient {
    const item = this.logClients.get(name);
    if (!item) throw new Error(`Chain ${name} is not configured for log queries`);
    return item;
  }

  getForExecution(name: ChainName): ChainClient {
    const item = this.executionClients.get(name);
    if (!item) throw new Error(`Chain ${name} is not configured for execution`);
    return item;
  }

  getById(chainId: number): ChainClient {
    for (const item of this.clients.values()) {
      if (!this.enabledChains.has(item.registry.name)) continue;
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
