import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient } from "viem";

import { chainRegistry } from "../src/chains.js";
import { createRpcTransport } from "../src/services/chain-client.js";

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
});
