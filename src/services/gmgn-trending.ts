import { randomUUID } from "node:crypto";
import { isAddress } from "viem";

import type { MarketCandidate } from "../db.js";

const DEFAULT_BASE_URL = "https://openapi.gmgn.ai";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RATE_LIMIT_FALLBACK_COOLDOWN_MS = 60_000;

export interface GmgnTrendingSnapshot {
  candidates: MarketCandidate[];
  fetchedAt: Date;
}

export interface MarketCandidateSource {
  fetchCandidates(minMarketCapUsd: number): Promise<GmgnTrendingSnapshot>;
}

export interface GmgnTrendingClientOptions {
  apiKey?: string;
  baseUrl?: string;
  limit?: number;
  cacheTtlMs?: number;
  fetcher?: typeof fetch;
  clock?: () => number;
}

export class GmgnTrendingError extends Error {
  readonly status?: number;
  readonly resetAt?: Date;

  constructor(message: string, status?: number, resetAt?: Date) {
    super(message);
    this.name = "GmgnTrendingError";
    this.status = status;
    this.resetAt = resetAt;
  }
}

interface CacheEntry extends GmgnTrendingSnapshot {
  expiresAt: number;
}

interface JsonObject {
  [key: string]: unknown;
}

export class GmgnTrendingClient implements MarketCandidateSource {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly limit: number;
  private readonly cacheTtlMs: number;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private readonly cache = new Map<number, CacheEntry>();
  private readonly inFlight = new Map<number, Promise<GmgnTrendingSnapshot>>();
  private cooldownUntil = 0;

  constructor(options: GmgnTrendingClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.limit = clampLimit(options.limit ?? DEFAULT_LIMIT);
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? CACHE_TTL_MS);
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.clock = options.clock ?? Date.now;
  }

  fetchCandidates(minMarketCapUsd: number): Promise<GmgnTrendingSnapshot> {
    const threshold = Number.isFinite(minMarketCapUsd) ? Math.max(0, minMarketCapUsd) : 0;
    const now = this.clock();
    const cached = this.cache.get(threshold);
    if (cached && cached.expiresAt > now) {
      return Promise.resolve({ candidates: [...cached.candidates], fetchedAt: cached.fetchedAt });
    }

    const existing = this.inFlight.get(threshold);
    if (existing) return existing;
    if (this.cooldownUntil > now) {
      const resetAt = new Date(this.cooldownUntil);
      return Promise.reject(new GmgnTrendingError(`GMGN trending cooldown active until ${resetAt.toISOString()}`, 429, resetAt));
    }

    const request = this.fetchFresh(threshold);
    this.inFlight.set(threshold, request);
    void request
      .then((snapshot) => {
        this.cache.set(threshold, { ...snapshot, expiresAt: this.clock() + this.cacheTtlMs });
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlight.get(threshold) === request) this.inFlight.delete(threshold);
      });
    return request;
  }

  private async fetchFresh(minMarketCapUsd: number): Promise<GmgnTrendingSnapshot> {
    if (!this.apiKey) throw new GmgnTrendingError("GMGN_API_KEY is not configured");

    const url = new URL(`${this.baseUrl}/v1/market/rank`);
    url.search = new URLSearchParams({
      chain: "robinhood",
      interval: "24h",
      order_by: "volume",
      direction: "desc",
      limit: String(this.limit),
      min_marketcap: String(minMarketCapUsd),
      timestamp: String(Math.floor(this.clock() / 1_000)),
      client_id: randomUUID(),
    }).toString();

    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "unilp-guardian",
          "X-APIKEY": this.apiKey,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GmgnTrendingError(`GMGN trending request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let resetAt = parseResetAt(response.headers.get("x-ratelimit-reset"));
    if (response.status === 429) {
      resetAt = laterDate(resetAt, new Date(this.clock() + RATE_LIMIT_FALLBACK_COOLDOWN_MS));
      this.cooldownUntil = Math.max(this.cooldownUntil, resetAt.getTime());
    }
    const text = await response.text().catch((error) => {
      throw new GmgnTrendingError(`GMGN trending response could not be read: ${error instanceof Error ? error.message : String(error)}`, response.status);
    });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new GmgnTrendingError(`GMGN trending returned non-JSON HTTP ${response.status}`, response.status);
    }

    const envelope = asObject(body);
    if (response.status === 429) {
      const bodyResetAt = parseResetAtValue(envelope?.reset_at ?? envelope?.resetAt ?? asObject(envelope?.data)?.reset_at ?? asObject(envelope?.data)?.resetAt);
      if (bodyResetAt) {
        resetAt = laterDate(resetAt, bodyResetAt);
        this.cooldownUntil = Math.max(this.cooldownUntil, resetAt.getTime());
      }
    }
    // Live responses are double-wrapped: { code, data: { code, data: { rank } } }.
    const data = asObject(envelope?.data);
    const inner = asObject(data?.data);
    const code = envelope?.code ?? data?.code;
    if (!response.ok || (code !== undefined && code !== 0 && code !== "0")) {
      const reason = stringValue(envelope?.error) ?? stringValue(envelope?.message)
        ?? stringValue(data?.reason) ?? stringValue(data?.message) ?? `HTTP ${response.status}`;
      const suffix = resetAt ? `; rate limit reset at ${resetAt.toISOString()}` : "";
      throw new GmgnTrendingError(`GMGN trending request failed: ${reason}${suffix}`, response.status, resetAt);
    }

    const ranking = Array.isArray(data?.rank) ? data.rank
      : Array.isArray(inner?.rank) ? inner.rank
        : Array.isArray(envelope?.rank) ? envelope.rank
          : null;
    if (!ranking) throw new GmgnTrendingError("GMGN trending response rank is not an array", response.status);

    const fetchedAt = new Date(this.clock());
    const candidates = new Map<string, MarketCandidate>();
    for (const item of ranking) {
      const row = asObject(item);
      const address = stringValue(row?.address)?.toLowerCase();
      if (!address || !isAddress(address, { strict: false })) continue;
      const rank = numberValue(row?.rank);
      const volume = numberValue(row?.volume);
      const seedScore = volume !== null && volume >= 0
        ? volume
        : rank !== null && rank >= 0 ? 1 / (rank + 1) : 0;
      const candidate: MarketCandidate = {
        tokenAddress: address,
        seedScore,
        lastSeenAt: fetchedAt,
        lastEvaluatedAt: null,
        sources: ["gmgn:24h"],
      };
      const previous = candidates.get(address);
      if (!previous || candidate.seedScore > previous.seedScore) candidates.set(address, candidate);
    }

    return {
      candidates: [...candidates.values()].sort((left, right) => right.seedScore - left.seedScore || left.tokenAddress.localeCompare(right.tokenAddress)),
      fetchedAt,
    };
  }
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseResetAt(value: string | null): Date | undefined {
  if (!value) return undefined;
  return parseResetAtValue(value);
}

function parseResetAtValue(value: unknown): Date | undefined {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1_000) : undefined;
}

function laterDate(left: Date | undefined, right: Date): Date {
  return left && left.getTime() >= right.getTime() ? left : right;
}
