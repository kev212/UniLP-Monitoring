import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient } from "viem";

import { chainRegistry } from "../src/chains.js";
import type { RuntimeConfig } from "../src/config.js";
import { ChainClients, createRpcTransport, ROBINHOOD_EXECUTION_CONCURRENCY, ROBINHOOD_READ_CONCURRENCY } from "../src/services/chain-client.js";

describe("RPC failover transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("moves to the fallback immediately when the primary returns HTTP 429", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createPublicClient({
      chain: chainRegistry.robinhood.chain,
      transport: createRpcTransport([
        "https://primary.example/rpc",
        "https://rpc.mainnet.chain.robinhood.com",
      ]),
    });

    await expect(client.getChainId()).resolves.toBe(4663);
    expect(urls).toEqual([
      "https://primary.example/rpc",
      "https://rpc.mainnet.chain.robinhood.com/",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("moves to the fallback after a primary network failure without retrying the primary", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length === 1) throw new Error("primary socket timed out");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createPublicClient({
      chain: chainRegistry.robinhood.chain,
      transport: createRpcTransport([
        "https://primary.example/rpc",
        "https://rpc.mainnet.chain.robinhood.com",
      ]),
    });

    await expect(client.getChainId()).resolves.toBe(4663);
    expect(urls).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares the Robinhood read concurrency limit across normal, scan, and monitoring clients", async () => {
    let active = 0;
    let maxActive = 0;
    const fetchMock = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2b2f955" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const clients = new ChainClients({
      chains: ["robinhood"],
      alchemyHttp: { robinhood: "https://alchemy.example/rpc" },
      rpcHttp: { base: "https://base.example/rpc", robinhood: "https://public.example/rpc", bsc: "https://bsc.example/rpc" },
      rpcHttpFallback: { robinhood: "https://fallback.example/rpc" },
      rpcHttpScanFallback: { robinhood: "https://rpc-robinhood.blockmachine.io" },
    } as RuntimeConfig);
    const normal = clients.get("robinhood").client;
    const scan = clients.getForScan("robinhood").client;
    const monitoring = clients.getForMonitoring("robinhood").client;

    await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const client = [normal, scan, monitoring][index % 3]!;
      return client.request({ method: "eth_blockNumber" });
    }));

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(maxActive).toBe(ROBINHOOD_READ_CONCURRENCY);
  });

  it("uses the same fallback for signed transaction submission", async () => {
    const urls: string[] = [];
    const transactionHash = `0x${"11".repeat(32)}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: transactionHash }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createPublicClient({
      chain: chainRegistry.robinhood.chain,
      transport: createRpcTransport([
        "https://primary.example/rpc",
        "https://rpc.mainnet.chain.robinhood.com",
      ]),
    });

    await expect(client.request({
      method: "eth_sendRawTransaction",
      params: ["0x1234"],
    } as never)).resolves.toBe(transactionHash);
    expect(urls).toHaveLength(2);
  });

  it("keeps log queries off the configured Alchemy archive endpoint", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const clients = new ChainClients({
      chains: ["robinhood"],
      alchemyHttp: {
        base: undefined,
        robinhood: "https://robinhood-mainnet.g.alchemy.com/v2/test",
        bsc: undefined,
      },
      rpcHttp: {
        base: "https://base.example/rpc",
        robinhood: "https://public.example/rpc",
        bsc: "https://bsc.example/rpc",
      },
      rpcHttpFallback: {
        base: "https://base-fallback.example/rpc",
        robinhood: "https://fallback.example/rpc",
        bsc: "https://bsc-fallback.example/rpc",
      },
      rpcHttpScanFallback: {
        robinhood: "https://rpc-robinhood.blockmachine.io",
      },
    } as RuntimeConfig);

    await expect(clients.getForLogs("robinhood").client.getChainId()).resolves.toBe(4663);
    expect(urls).toEqual([
      "https://public.example/rpc",
      "https://rpc-robinhood.blockmachine.io/",
    ]);
  });

  it("keeps heavy scans on public RPCs", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const clients = new ChainClients({
      chains: ["robinhood"],
      alchemyHttp: { base: undefined, robinhood: "https://alchemy.example/rpc" },
      rpcHttp: { base: "https://base.example/rpc", robinhood: "https://public.example/rpc", bsc: "https://bsc.example/rpc" },
      rpcHttpFallback: { robinhood: "https://public-fallback.example/rpc" },
      rpcHttpScanFallback: { robinhood: "https://rpc-robinhood.blockmachine.io" },
    } as RuntimeConfig);

    await clients.getForScan("robinhood").client.getChainId();

    expect(urls).toEqual(["https://public.example/rpc"]);
    expect(urls.some((url) => url.includes("alchemy.example"))).toBe(false);
  });

  it("uses Alchemy first for execution and never uses the scan fallback", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const clients = new ChainClients({
      chains: ["robinhood"],
      alchemyHttp: { base: undefined, robinhood: "https://alchemy.example/rpc", bsc: undefined },
      rpcHttp: { base: "https://base.example/rpc", robinhood: "https://public.example/rpc", bsc: "https://bsc.example/rpc" },
      rpcHttpFallback: { robinhood: "https://public-fallback.example/rpc" },
      rpcHttpScanFallback: { robinhood: "https://rpc-robinhood.blockmachine.io" },
    } as RuntimeConfig);

    await clients.getForExecution("robinhood").client.getChainId();

    expect(urls).toEqual(["https://alchemy.example/rpc"]);
    expect(urls.some((url) => url.includes("blockmachine.io"))).toBe(false);
  });

  it("uses Alchemy, then BlockMachine, then public RPC for Robinhood execution", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("alchemy.example")) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const clients = new ChainClients({
      chains: ["robinhood"],
      alchemyHttp: { base: undefined, robinhood: "https://alchemy.example/rpc", bsc: undefined },
      rpcHttp: { base: "https://base.example/rpc", robinhood: "https://public.example/rpc", bsc: "https://bsc.example/rpc" },
      rpcHttpFallback: { robinhood: "https://public-fallback.example/rpc" },
      rpcHttpScanFallback: { robinhood: "https://rpc-robinhood.blockmachine.io" },
    } as RuntimeConfig);

    await expect(clients.getForExecution("robinhood").client.getChainId()).resolves.toBe(4663);
    expect(urls).toEqual([
      "https://alchemy.example/rpc",
      "https://rpc-robinhood.blockmachine.io/",
    ]);
  });

  it("never sends Robinhood reads to Alchemy after public RPCs fail", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("rate limited", { status: 429 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const clients = new ChainClients({
      chains: ["robinhood"],
      alchemyHttp: { base: undefined, robinhood: "https://alchemy.example/rpc", bsc: undefined },
      rpcHttp: { base: "https://base.example/rpc", robinhood: "https://public.example/rpc", bsc: "https://bsc.example/rpc" },
      rpcHttpFallback: { robinhood: "https://public-fallback.example/rpc" },
      rpcHttpScanFallback: { robinhood: "https://rpc-robinhood.blockmachine.io" },
    } as RuntimeConfig);

    await expect(clients.get("robinhood").client.getChainId()).rejects.toThrow();
    await expect(clients.getForScan("robinhood").client.getChainId()).rejects.toThrow();
    await expect(clients.getForLogs("robinhood").client.getChainId()).rejects.toThrow();

    expect(urls.some((url) => url.includes("alchemy.example"))).toBe(false);
    expect(urls.some((url) => url.includes("public.example"))).toBe(true);
    expect(urls.some((url) => url.includes("blockmachine.io"))).toBe(true);
  });

  it("uses Alchemy only as the last resort for Robinhood monitoring", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (!url.includes("monitoring-alchemy.example")) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const clients = new ChainClients({
      chains: ["robinhood"],
      alchemyHttp: { base: undefined, robinhood: "https://execution-alchemy.example/rpc", bsc: undefined },
      alchemyMonitoringHttp: { robinhood: "https://monitoring-alchemy.example/rpc" },
      rpcHttp: { base: "https://base.example/rpc", robinhood: "https://public.example/rpc", bsc: "https://bsc.example/rpc" },
      rpcHttpFallback: { robinhood: "https://rpc-robinhood.blockmachine.io" },
      rpcHttpScanFallback: { robinhood: "https://rpc-robinhood.blockmachine.io" },
    } as RuntimeConfig);

    await expect(clients.getForMonitoring("robinhood").client.getChainId()).resolves.toBe(4663);
    expect(urls).toEqual([
      "https://public.example/rpc",
      "https://rpc-robinhood.blockmachine.io/",
      "https://monitoring-alchemy.example/rpc",
    ]);
    expect(urls.some((url) => url.includes("execution-alchemy.example"))).toBe(false);
  });

  it("falls back Robinhood normal reads to BlockMachine when the public RPC returns 429", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (String(input).includes("public.example")) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const clients = new ChainClients({
      chains: ["robinhood"],
      alchemyHttp: { base: undefined, robinhood: "https://alchemy.example/rpc", bsc: undefined },
      rpcHttp: { base: "https://base.example/rpc", robinhood: "https://public.example/rpc", bsc: "https://bsc.example/rpc" },
      rpcHttpFallback: { robinhood: "https://public.example/rpc" },
      rpcHttpScanFallback: { robinhood: "https://rpc-robinhood.blockmachine.io" },
    } as RuntimeConfig);

    await expect(clients.get("robinhood").client.getChainId()).resolves.toBe(4663);
    expect(urls).toEqual([
      "https://public.example/rpc",
      "https://rpc-robinhood.blockmachine.io/",
    ]);
    expect(urls.some((url) => url.includes("alchemy.example"))).toBe(false);
  });

  it("limits Robinhood execution concurrency separately from reads", async () => {
    let active = 0;
    let maxActive = 0;
    const fetchMock = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const clients = new ChainClients({
      chains: ["robinhood"],
      alchemyHttp: { robinhood: "https://alchemy.example/rpc" },
      rpcHttp: { base: "https://base.example/rpc", robinhood: "https://public.example/rpc", bsc: "https://bsc.example/rpc" },
      rpcHttpFallback: { robinhood: "https://fallback.example/rpc" },
      rpcHttpScanFallback: { robinhood: "https://rpc-robinhood.blockmachine.io" },
    } as RuntimeConfig);
    const execution = clients.getForExecution("robinhood").client;

    await Promise.all(Array.from({ length: 12 }, () => execution.request({ method: "eth_chainId" })));

    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(maxActive).toBe(ROBINHOOD_EXECUTION_CONCURRENCY);
  });

  it("keeps BSC logs on public RPC and never uses Alchemy", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x38" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const clients = new ChainClients({
      chains: ["bsc"],
      alchemyHttp: { bsc: "https://bnb-mainnet.g.alchemy.com/v2/test" },
      rpcHttp: { base: "https://base.example/rpc", robinhood: "https://public.example/rpc", bsc: "https://bsc-dataseed.bnbchain.org" },
      rpcHttpFallback: { bsc: "https://bsc-fallback.example/rpc" },
      rpcHttpScanFallback: {},
    } as RuntimeConfig);

    await expect(clients.getForLogs("bsc").client.getChainId()).resolves.toBe(56);
    expect(urls[0]).toContain("bsc-dataseed.bnbchain.org");
    expect(urls.some((url) => url.includes("alchemy"))).toBe(false);
  });

  it("uses public BSC RPC first for current-state scans", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x38" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const clients = new ChainClients({
      chains: ["bsc"],
      alchemyHttp: { bsc: "https://bnb-mainnet.g.alchemy.com/v2/test" },
      rpcHttp: { base: "https://base.example/rpc", robinhood: "https://public.example/rpc", bsc: "https://bsc-dataseed.bnbchain.org" },
      rpcHttpFallback: { bsc: "https://bsc-fallback.example/rpc" },
      rpcHttpScanFallback: {},
    } as RuntimeConfig);

    await clients.getForScan("bsc").client.getChainId();
    expect(urls[0]).toMatch(/^https:\/\/bsc-dataseed\.bnbchain\.org\/?$/);
  });

  it("uses public Base RPCs for scans without sending reads to Alchemy", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2105" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const clients = new ChainClients({
      chains: ["base"],
      alchemyHttp: { base: "https://base-mainnet.g.alchemy.com/v2/test" },
      rpcHttp: { base: "https://mainnet.base.org", robinhood: "https://public.example/rpc", bsc: "https://bsc.example/rpc" },
      rpcHttpFallback: { base: "https://1rpc.io/base" },
      rpcHttpScanFallback: {},
    } as RuntimeConfig);

    await expect(clients.getForScan("base").client.getChainId()).resolves.toBe(8453);
    expect(urls).toEqual([
      "https://mainnet.base.org/",
      "https://1rpc.io/base",
    ]);
    expect(urls.some((url) => url.includes("alchemy"))).toBe(false);
  });

  it("keeps Base normal reads off Alchemy after public fallback", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2105" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const clients = new ChainClients({
      chains: ["base"],
      alchemyHttp: { base: "https://base-mainnet.g.alchemy.com/v2/test" },
      rpcHttp: { base: "https://base.gateway.tenderly.co", robinhood: "https://public.example/rpc", bsc: "https://bsc.example/rpc" },
      rpcHttpFallback: { base: "https://1rpc.io/base" },
      rpcHttpScanFallback: {},
    } as RuntimeConfig);

    await expect(clients.get("base").client.getChainId()).resolves.toBe(8453);
    expect(urls).toEqual(["https://base.gateway.tenderly.co/", "https://1rpc.io/base"]);
    expect(urls.some((url) => url.includes("alchemy"))).toBe(false);
  });
});
