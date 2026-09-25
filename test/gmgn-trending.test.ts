import { afterEach, describe, expect, it, vi } from "vitest";

import { GmgnTrendingClient, GmgnTrendingError } from "../src/services/gmgn-trending.js";

const tokenA = "0x0000000000000000000000000000000000000001";
const tokenB = "0x0000000000000000000000000000000000000002";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GMGN trending client", () => {
  it("requests Robinhood 24h volume ranking and normalizes the double-wrapped response", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { code: 0, message: "success", data: { rank: [
        { address: tokenA.toUpperCase(), volume: "12,500", rank: 1 },
        { address: tokenB, volume: 100, rank: 2 },
        { address: tokenA, volume: 11_000, rank: 3 },
        { address: "not-an-address", volume: 99_000, rank: 4 },
      ] } },
    })));
    const client = new GmgnTrendingClient({
      apiKey: "test-key",
      limit: 100,
      clock: () => 1_700_000_000_000,
      fetcher: fetcher as unknown as typeof fetch,
    });

    const snapshot = await client.fetchCandidates(500_000);
    const request = new URL(String(fetcher.mock.calls[0]?.[0]));
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;

    expect(request.pathname).toBe("/v1/market/rank");
    expect(Object.fromEntries(request.searchParams)).toMatchObject({
      chain: "robinhood",
      interval: "24h",
      order_by: "volume",
      direction: "desc",
      limit: "100",
      min_marketcap: "500000",
      timestamp: "1700000000",
    });
    expect((init.headers as Record<string, string>)["X-APIKEY"]).toBe("test-key");
    expect(snapshot.candidates.map(candidate => candidate.tokenAddress)).toEqual([tokenA, tokenB]);
    expect(snapshot.candidates[0]?.seedScore).toBe(12_500);
    expect(snapshot.candidates[0]?.sources).toEqual(["gmgn:24h"]);
  });

  it("accepts a flat data.rank response shape", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { rank: [{ address: tokenA, volume: 500 }] },
    })));
    const client = new GmgnTrendingClient({ apiKey: "test-key", fetcher: fetcher as unknown as typeof fetch });
    const snapshot = await client.fetchCandidates(500_000);
    expect(snapshot.candidates.map(c => c.tokenAddress)).toEqual([tokenA]);
  });

  it("caches and single-flights the same market-cap threshold", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(res => { resolve = res; }));
    const client = new GmgnTrendingClient({ apiKey: "test-key", fetcher: fetcher as unknown as typeof fetch });

    const first = client.fetchCandidates(500_000);
    const second = client.fetchCandidates(500_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(new Response(JSON.stringify({ code: 0, data: { rank: [{ address: tokenA, volume: 1 }] } })));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await client.fetchCandidates(500_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses a conservative cooldown when a 429 has no reset metadata", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 429, error: "RATE_LIMIT_BANNED" }), { status: 429 }));
    const client = new GmgnTrendingClient({ apiKey: "test-key", fetcher: fetcher as unknown as typeof fetch });

    await expect(client.fetchCandidates(500_000)).rejects.toMatchObject({ status: 429 });
    await expect(client.fetchCandidates(600_000)).rejects.toThrow("cooldown active");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry a rate-limited request during GMGN cooldown", async () => {
    const resetAt = Math.floor(Date.now() / 1_000) + 60;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      code: 429,
      error: "RATE_LIMIT_BANNED",
    }), { status: 429, headers: { "x-ratelimit-reset": String(resetAt) } }));
    const client = new GmgnTrendingClient({ apiKey: "test-key", fetcher: fetcher as unknown as typeof fetch });

    const result = client.fetchCandidates(500_000);
    await expect(result).rejects.toBeInstanceOf(GmgnTrendingError);
    await expect(result).rejects.toMatchObject({ status: 429 });
    await expect(client.fetchCandidates(600_000)).rejects.toThrow("cooldown active");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses the reset timestamp from a rate-limit body when the header is absent", async () => {
    const resetAt = Math.floor(Date.now() / 1_000) + 60;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      code: 429,
      error: "RATE_LIMIT_BANNED",
      reset_at: resetAt,
    }), { status: 429 }));
    const client = new GmgnTrendingClient({
      apiKey: "test-key",
      clock: () => (resetAt - 60) * 1_000,
      fetcher: fetcher as unknown as typeof fetch,
    });

    await expect(client.fetchCandidates(500_000)).rejects.toMatchObject({ status: 429, resetAt: new Date(resetAt * 1_000) });
    await expect(client.fetchCandidates(600_000)).rejects.toThrow("cooldown active");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when no API key is configured", async () => {
    const client = new GmgnTrendingClient({ fetcher: vi.fn() as unknown as typeof fetch });
    await expect(client.fetchCandidates(500_000)).rejects.toThrow("GMGN_API_KEY is not configured");
  });
});
