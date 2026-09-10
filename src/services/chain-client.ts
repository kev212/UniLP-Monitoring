import { createPublicClient, fallback, http, type Address, type PublicClient, type Transport } from "viem";

import { chainRegistry, type ChainRegistry } from "../chains.js";
import type { RuntimeConfig } from "../config.js";
import type { ChainName } from "../types.js";
import { log } from "../log.js";

export interface ChainClient {
  registry: ChainRegistry;
  client: PublicClient;
  transport: Transport;
}

const RPC_TIMEOUT_MS = 20_000;
const RPC_METRICS_INTERVAL_MS = 60_000;
export const ROBINHOOD_READ_CONCURRENCY = 12;
export const ROBINHOOD_EXECUTION_CONCURRENCY = 4;

export type RpcMetricCategory = "success" | "rpc_error" | "contract_revert" | "rate_limited" | "invalid_request" | "transport_error";

export interface RpcMetricSink {
  record(endpoint: string, method: string, category: RpcMetricCategory, latencyMs: number): void;
}

export interface RpcTransportOptions {
  endpointLabels?: readonly string[];
  metrics?: RpcMetricSink;
}

interface RpcMetricCounter {
  endpoint: string;
  method: string;
  category: RpcMetricCategory;
  count: number;
  latencyMs: number;
  maxLatencyMs: number;
}

export class RpcMetrics implements RpcMetricSink {
  private readonly counters = new Map<string, RpcMetricCounter>();

  record(endpoint: string, method: string, category: RpcMetricCategory, latencyMs: number): void {
    const key = `${endpoint}|${method}|${category}`;
    const current = this.counters.get(key);
    if (current) {
      current.count += 1;
      current.latencyMs += latencyMs;
      current.maxLatencyMs = Math.max(current.maxLatencyMs, latencyMs);
      return;
    }
    this.counters.set(key, { endpoint, method, category, count: 1, latencyMs, maxLatencyMs: latencyMs });
  }

  flush(): readonly RpcMetricCounter[] {
    const rows = [...this.counters.values()].map((row) => ({ ...row }));
    this.counters.clear();
    if (rows.length > 0) {
      const requests = rows.reduce((total, row) => total + row.count, 0);
      const successes = rows.reduce((total, row) => total + (row.category === "success" ? row.count : 0), 0);
      log.info({
        rpcTotals: {
          requests,
          successes,
          failures: requests - successes,
          successRatePct: requests > 0 ? Math.round((successes / requests) * 10_000) / 100 : 100,
        },
        rpcMetrics: rows,
      }, "RPC request metrics");
    }
    return rows;
  }
}

export class AsyncLimiter {
  private active = 0;
  private priorityHandoffs = 0;
  private readonly priorityWaiters: Array<() => void> = [];
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>, priority = false): Promise<T> {
    await this.acquire(priority);
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private async acquire(priority: boolean): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => (priority ? this.priorityWaiters : this.waiters).push(resolve));
  }

  private release(): void {
    const servePriority = this.priorityWaiters.length > 0
      && (this.waiters.length === 0 || this.priorityHandoffs < 4);
    const next = servePriority ? this.priorityWaiters.shift() : this.waiters.shift() ?? this.priorityWaiters.shift();
    if (next) this.priorityHandoffs = servePriority ? this.priorityHandoffs + 1 : 0;
    if (next) next();
    else this.active -= 1;
  }
}

function uniqueUrls(urls: readonly (string | undefined)[]): string[] {
  return [...new Set(urls.filter((url): url is string => Boolean(url)))];
}

/**
 * Keep RPC failover request-local and deterministic. A failed primary request
 * must reach the next provider immediately instead of retrying the same
 * throttled endpoint before fallback gets a chance.
 */
export function createRpcTransport(urls: readonly string[], limiter?: AsyncLimiter, priority = false, options?: RpcTransportOptions): Transport {
  const endpoints = uniqueUrls(urls);
  if (endpoints.length === 0) throw new Error("At least one RPC endpoint is required");
  const transports = endpoints.map((url, index) => {
    const transport = http(url, { retryCount: 0, timeout: RPC_TIMEOUT_MS });
    const metrics = options?.metrics;
    if (!metrics) return transport;
    return instrumentRpcTransport(transport, options.endpointLabels?.[index] ?? url, metrics);
  });
  const transport = transports.length === 1
    ? transports[0]!
    : fallback(transports as [Transport, ...Transport[]], { retryCount: 0 });
  if (!limiter) return transport;
  return ((options) => {
    const inner = transport(options);
    const request = ((args, requestOptions) => limiter.run(() => inner.request(args, requestOptions), priority)) as typeof inner.request;
    return { ...inner, config: { ...inner.config, request }, request };
  }) as Transport;
}

function instrumentRpcTransport(base: Transport, endpoint: string, metrics: RpcMetricSink): Transport {
  return ((options) => {
    const inner = base(options);
    const request = (async (args, requestOptions) => {
      const startedAt = Date.now();
      try {
        const result = await inner.request(args, requestOptions);
        metrics.record(endpoint, String(args.method), "success", Date.now() - startedAt);
        return result;
      } catch (error) {
        metrics.record(endpoint, String(args.method), classifyRpcError(error), Date.now() - startedAt);
        throw error;
      }
    }) as typeof inner.request;
    return { ...inner, config: { ...inner.config, request }, request };
  }) as Transport;
}

function classifyRpcError(error: unknown): RpcMetricCategory {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current !== "object") {
      return classifyRpcMessage(String(current));
    }
    if (seen.has(current)) break;
    seen.add(current);
    const value = current as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown; error?: unknown };
    const code = numericValue(value.code);
    const status = numericValue(value.status ?? value.statusCode);
    if (status === 429 || code === 429 || code === -32005) return "rate_limited";
    if (status >= 500 && status < 600) return "transport_error";
    if (code === -32600 || code === -32601 || code === -32602) return "invalid_request";
    if (code === 3) return "contract_revert";
    if (typeof value.message === "string") {
      const category = classifyRpcMessage(value.message);
      if (category !== "rpc_error") return category;
    }
    current = value.cause ?? value.error;
  }
  return "rpc_error";
}

function numericValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return Number.NaN;
}

function classifyRpcMessage(message: string): RpcMetricCategory {
  if (/(?:429|rate.?limit|too many requests|throttl)/i.test(message)) return "rate_limited";
  if (/(?:invalid (?:request|params?|argument)|malformed|unknown method)/i.test(message)) return "invalid_request";
  if (/(?:execution reverted|contract function .*reverted|reverted with)/i.test(message)) return "contract_revert";
  if (/(?:timeout|timed out|network|fetch|socket|econn|aborted|connection)/i.test(message)) return "transport_error";
  return "rpc_error";
}

export class ChainClients {
  private readonly clients = new Map<ChainName, ChainClient>();
  private readonly monitoringClients = new Map<ChainName, ChainClient>();
  private readonly scanClients = new Map<ChainName, ChainClient>();
  private readonly scanFallbackClients = new Map<ChainName, ChainClient>();
  private readonly logClients = new Map<ChainName, ChainClient>();
  private readonly executionClients = new Map<ChainName, ChainClient>();
  private readonly enabledChains: Set<ChainName>;
  private readonly tokenMetadata = new Map<string, { decimals: number; symbol: string }>();
  private readonly rpcMetrics = new RpcMetrics();

  constructor(config: RuntimeConfig) {
    this.enabledChains = new Set(config.chains);
    const metricsTimer = setInterval(() => this.rpcMetrics.flush(), RPC_METRICS_INTERVAL_MS);
    metricsTimer.unref?.();
    for (const name of ["base", "robinhood", "bsc"] as const) {
      const registry = chainRegistry[name];
      const readLimiter = name === "robinhood" ? new AsyncLimiter(ROBINHOOD_READ_CONCURRENCY) : undefined;
      const executionLimiter = name === "robinhood" ? new AsyncLimiter(ROBINHOOD_EXECUTION_CONCURRENCY) : undefined;
      const publicEndpoints = uniqueUrls([
        config.rpcHttp[name],
        config.rpcHttpScanFallback?.[name],
        config.rpcHttpFallback[name],
      ]);
      const alchemyLastResort = name !== "base" && name !== "robinhood" && config.alchemyHttp[name]
        ? [config.alchemyHttp[name]]
        : [];
      const normalUrls = uniqueUrls([
        ...publicEndpoints,
        ...alchemyLastResort,
      ]);
      const normalTransport = createRpcTransport(normalUrls, readLimiter, false, this.rpcTransportOptions(config, name, "normal", normalUrls));
      this.clients.set(name, {
        registry,
        transport: normalTransport,
        client: createPublicClient({
          chain: registry.chain,
          transport: normalTransport,
          pollingInterval: 4_000,
        }),
      });
      const monitoringUrls = uniqueUrls([
        ...(name === "robinhood" ? [config.alchemyMonitoringHttp?.[name]] : []),
        ...publicEndpoints,
        ...(name === "robinhood" ? [] : alchemyLastResort),
      ]);
      const monitoringTransport = createRpcTransport(monitoringUrls, readLimiter, true, this.rpcTransportOptions(config, name, "monitoring", monitoringUrls));
      this.monitoringClients.set(name, {
        registry,
        transport: monitoringTransport,
        client: createPublicClient({
          chain: registry.chain,
          transport: monitoringTransport,
          pollingInterval: 4_000,
        }),
      });
      const scanUrls = uniqueUrls([
        config.rpcHttp[name],
        config.rpcHttpScanFallback?.[name],
        config.rpcHttpFallback[name],
        ...alchemyLastResort,
      ]);
      const scanTransport = createRpcTransport(scanUrls, readLimiter, false, this.rpcTransportOptions(config, name, "scan", scanUrls));
      this.scanClients.set(name, {
        registry,
        transport: scanTransport,
        client: createPublicClient({
          chain: registry.chain,
          transport: scanTransport,
          pollingInterval: 4_000,
        }),
      });
      const scanFallbackUrl = config.rpcHttpScanFallback?.[name];
      if (scanFallbackUrl) {
        const scanFallbackUrls = [scanFallbackUrl];
        const scanFallbackTransport = createRpcTransport(scanFallbackUrls, readLimiter, false, this.rpcTransportOptions(config, name, "scan-fallback", scanFallbackUrls));
        this.scanFallbackClients.set(name, {
          registry,
          transport: scanFallbackTransport,
          client: createPublicClient({
            chain: registry.chain,
            transport: scanFallbackTransport,
            pollingInterval: 4_000,
          }),
        });
      }
      const logUrls = uniqueUrls([
        config.rpcHttp[name],
        config.rpcHttpScanFallback?.[name],
        config.rpcHttpFallback[name],
        ...alchemyLastResort,
      ]);
      if (logUrls.length > 0) {
        const logTransport = createRpcTransport(logUrls, readLimiter, false, this.rpcTransportOptions(config, name, "logs", logUrls));
        this.logClients.set(name, {
          registry,
          transport: logTransport,
          client: createPublicClient({
            chain: registry.chain,
            transport: logTransport,
            pollingInterval: 4_000,
          }),
        });
      }
      const executionUrls = uniqueUrls([
        config.alchemyHttp[name],
        config.rpcHttpScanFallback?.[name],
        config.rpcHttp[name],
        config.rpcHttpFallback[name],
      ]);
      const executionTransport = createRpcTransport(executionUrls, executionLimiter, false, this.rpcTransportOptions(config, name, "execution", executionUrls));
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

  getForMonitoring(name: ChainName): ChainClient {
    const item = this.monitoringClients.get(name);
    if (!item || !this.enabledChains.has(name)) throw new Error(`Chain ${name} is not enabled for monitoring`);
    return item;
  }

  getForScanFallback(name: ChainName): ChainClient | undefined {
    return this.scanFallbackClients.get(name);
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

  private rpcTransportOptions(config: RuntimeConfig, chain: ChainName, purpose: string, urls: readonly string[]): RpcTransportOptions {
    return {
      metrics: this.rpcMetrics,
      endpointLabels: urls.map((url) => `${chain}:${purpose}:${rpcEndpointName(config, chain, url)}`),
    };
  }
}

function rpcEndpointName(config: RuntimeConfig, chain: ChainName, url: string): string {
  const normalized = url.replace(/\/+$/, "");
  const same = (candidate: string | undefined): boolean => Boolean(candidate && candidate.replace(/\/+$/, "") === normalized);
  if (same(config.alchemyMonitoringHttp?.[chain])) return "alchemy-monitoring";
  if (same(config.alchemyHttp[chain])) return "alchemy";
  if (same(config.rpcHttp[chain])) return "public-primary";
  if (same(config.rpcHttpScanFallback?.[chain])) return "public-scan-fallback";
  if (same(config.rpcHttpFallback[chain])) return "public-fallback";
  return "rpc";
}
