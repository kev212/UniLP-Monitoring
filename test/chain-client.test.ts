import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient } from "viem";

import { chainRegistry } from "../src/chains.js";
import type { RuntimeConfig } from "../src/config.js";
import { ChainClients, createRpcTransport } from "../src/services/chain-client.js";

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
        robinhood: "https://rpc.arrowrpc.com",
      },
    } as RuntimeConfig);

    await expect(clients.getForLogs("robinhood").client.getChainId()).resolves.toBe(4663);
    expect(urls).toEqual([
      "https://public.example/rpc",
      "https://rpc.arrowrpc.com/",
    ]);
  });

  it("keeps heavy scans on public and Arrow RPCs", async () => {
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
      rpcHttpScanFallback: { robinhood: "https://rpc.arrowrpc.com" },
    } as RuntimeConfig);

    await clients.getForScan("robinhood").client.getChainId();

    expect(urls).toEqual(["https://public.example/rpc"]);
    expect(urls.some((url) => url.includes("alchemy.example"))).toBe(false);
  });

  it("uses Alchemy first for execution and never uses Arrow", async () => {
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
      rpcHttpScanFallback: { robinhood: "https://rpc.arrowrpc.com" },
    } as RuntimeConfig);

    await clients.getForExecution("robinhood").client.getChainId();

    expect(urls).toEqual(["https://alchemy.example/rpc"]);
    expect(urls.some((url) => url.includes("arrowrpc.com"))).toBe(false);
  });

  it("keeps BSC logs on Alchemy and never falls through to public BNB RPC", async () => {
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
    expect(urls).toEqual(["https://bnb-mainnet.g.alchemy.com/v2/test"]);
    expect(urls.some((url) => url.includes("bsc-dataseed"))).toBe(false);
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
});
