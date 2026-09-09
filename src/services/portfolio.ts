import { formatUnits, isAddress, zeroAddress, type Address } from "viem";

import { erc20Abi, v3PositionManagerAbi } from "../abi.js";
import { chainRegistry } from "../chains.js";
import type { RuntimeConfig } from "../config.js";
import { isUsdStableSymbol } from "./token-meta.js";
import type { Database } from "../db.js";
import type { ChainName, PositionRecord } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import { PositionReader, type PositionValue } from "./position-reader.js";
import { dexNameFromMetadata, v3ContractsFor } from "./v3-deployment.js";
import { quoteValueAtPriceMarker, quoteValueAtSqrtPrice } from "./uniswap-math.js";
import { log } from "../log.js";

export const PORTFOLIO_REFRESH_INTERVAL_MS = 3 * 60_000;
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11" as Address;
const DEXSCREENER_BASE = "https://api.dexscreener.com";
const ROBINHOOD_USDG_WETH_PAIR = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca";

export interface PortfolioSnapshot {
  totalUsd: number;
  walletUsd: number;
  activeLpUsd: number;
  updatedAt: Date;
  calculating: boolean;
  complete: boolean;
  issues: string[];
}
interface TokenBalance { address: Address; amount: bigint; decimals: number }
interface DexTokenPair {
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  priceUsd?: string | null;
  priceNative?: string | null;
  liquidity?: { usd?: number | null };
}
interface DexPairResponse { pairs?: DexTokenPair[] | null }

export class PortfolioService {
  private snapshot: PortfolioSnapshot = {
    totalUsd: 0, walletUsd: 0, activeLpUsd: 0, updatedAt: new Date(0),
    calculating: true, complete: false, issues: [],
  };
  private pending?: Promise<void>;
  private lastAttempt = 0;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private lastNativeUsd = new Map<ChainName, number>();
  private decimals = new Map<string, number>();
  private knownTokens = new Map<ChainName, Set<Address>>();
  private readonly reader: PositionReader;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly chains: ChainClients,
    private readonly database: Database,
    reader?: PositionReader,
  ) { this.reader = reader ?? new PositionReader(chains, 0); }

  getSnapshot(): PortfolioSnapshot { return this.snapshot; }
  start(): void {
    if (this.refreshTimer) return;
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), PORTFOLIO_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
  }
  stop(): void { clearInterval(this.refreshTimer); this.refreshTimer = undefined; }

  async ensureFresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.lastAttempt && Date.now() - this.lastAttempt < PORTFOLIO_REFRESH_INTERVAL_MS) return;
    return this.refresh();
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.lastAttempt = Date.now();
    this.pending = this.calculate().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async calculate(): Promise<void> {
    const started = Date.now();
    try {
      const results = await Promise.allSettled([...new Set(this.config.chains)].map(chain => this.refreshChain(chain)));
      const totals = results.map(result => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      const walletUsd = totals.reduce((sum, item) => sum + item.walletUsd, 0);
      const activeLpUsd = totals.reduce((sum, item) => sum + item.activeLpUsd, 0);
      const issues = totals.flatMap(item => item.issues);
      if (!Number.isFinite(walletUsd + activeLpUsd)) throw new Error("Non-finite portfolio value");
      this.snapshot = { walletUsd, activeLpUsd, totalUsd: walletUsd + activeLpUsd,
        updatedAt: new Date(), calculating: false, complete: issues.length === 0, issues };
      log.info({ durationMs: Date.now() - started, complete: this.snapshot.complete, issues }, "portfolio refreshed");
    } catch (err) {
      // Keep the old timestamp: a failed attempt must never make stale values look fresh.
      this.snapshot = { ...this.snapshot, calculating: false, complete: false, issues: ["Refresh gagal; data terakhir belum diperbarui"] };
      log.warn({ err }, "portfolio refresh failed");
    }
  }

  private manager(position: PositionRecord): Address {
    const registry = this.chains.getById(position.chainId).registry;
    return position.protocol === "v3"
      ? v3ContractsFor(registry, dexNameFromMetadata(position.metadata)).positionManager
      : registry.contracts.v4.positionManager;
  }

  private async refreshChain(chain: ChainName): Promise<{ walletUsd: number; activeLpUsd: number; issues: string[] }> {
    const { client, registry } = this.chains.getForScan(chain);
    const issues: string[] = [];
    const [allPositions, groups, blockNumber] = await Promise.all([
      this.database.listActivePositions(registry.chain.id), this.database.listPositionGroups(registry.chain.id), client.getBlockNumber({ cacheTime: 0 }),
    ]);
    const seen = new Set<string>();
    const positions = allPositions.filter(position => {
      if (position.owner.toLowerCase() !== this.config.executorAddress.toLowerCase()) return false;
      const key = position.protocol === "v2"
        ? `v2:${position.poolAddress?.toLowerCase()}`
        : `${position.protocol}:${this.manager(position).toLowerCase()}:${BigInt(position.positionKey)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const known = this.knownTokens.get(chain) ?? new Set<Address>();
    for (const address of [...this.config.quoteTokens[chain].map(t => t.address), ...positions.flatMap(p => [p.token0, p.token1])]) {
      known.add(address.toLowerCase() as Address);
    }
    this.knownTokens.set(chain, known);
    const excluded = new Set(positions.filter(p => p.protocol === "v2" && p.poolAddress).map(p => p.poolAddress!.toLowerCase()));
    const balances = await this.walletBalances(chain, excluded, blockNumber, issues, positions.length > 0);
    // Check NFT ownership at the same block as LP reads, including paused/closing positions.
    const nfts = positions.filter(p => p.protocol !== "v2");
    const ownership = nfts.length ? await client.multicall({ multicallAddress: MULTICALL3, blockNumber, contracts: nfts.map(p => ({
      address: this.manager(p), abi: v3PositionManagerAbi, functionName: "ownerOf" as const, args: [BigInt(p.positionKey)] as const,
    })) }) : [];
    const owned = new Set(positions.filter(p => p.protocol === "v2").map(p => p.id));
    ownership.forEach((result, index) => {
      if (result.status === "success") {
        if (result.result.toLowerCase() === this.config.executorAddress.toLowerCase()) owned.add(nfts[index]!.id);
      } else issues.push(`${chain}: kepemilikan LP ${nfts[index]!.positionKey} belum terverifikasi`);
    });
    const values = new Map<string, PositionValue>();
    let cacheHits = 0;
    for (const position of positions.filter(p => owned.has(p.id))) {
      const cached = this.reader.getPortfolioValue(position, blockNumber);
      if (cached) { values.set(position.id, cached); cacheHits++; }
    }
    const missing = positions.filter(p => owned.has(p.id) && !values.has(p.id));
    const grouped = new Set<string>();
    for (const group of groups.filter(g => g.owner.toLowerCase() === this.config.executorAddress.toLowerCase())) {
      const children = missing.filter(p => p.metadata.managedBy === "position_group" && p.metadata.positionGroupId === group.id);
      if (!children.length) continue;
      try {
        const results = await this.reader.readGroup(group, children, blockNumber, 0, "scan", true);
        children.forEach((p, i) => { values.set(p.id, results[i]!); grouped.add(p.id); });
      } catch {
        // Isolate a broken child with individual reads below.
      }
    }
    for (const position of missing.filter(p => !grouped.has(p.id))) {
      try { values.set(position.id, await this.reader.read(position, blockNumber, 0, "scan", true)); }
      catch { issues.push(`${chain}: nilai LP ${position.positionKey} belum tersedia`); }
    }
    const addresses = [...new Set([
      ...balances.map(b => b.address), ...positions.flatMap(p => [p.quoteToken, p.token0, p.token1].filter((a): a is Address => a !== null)),
      registry.wrappedNative,
    ].map(a => a.toLowerCase()))] as Address[];
    const prices = await this.tokenPrices(chain, addresses);
    if (this.staleNativeChains.has(chain)) issues.push(`${chain}: harga native memakai cache lama`);
    const valueUsd = async (address: Address, amount: bigint): Promise<number> => {
      if (amount === 0n) return 0;
      const price = prices.get(address.toLowerCase());
      if (price === undefined) { issues.push(`${chain}: harga USD ${address} belum tersedia`); return 0; }
      return Number(formatUnits(amount, await this.tokenDecimals(chain, address))) * price;
    };
    let walletUsd = 0;
    for (const balance of balances) walletUsd += await valueUsd(balance.address, balance.amount);
    let activeLpUsd = 0;
    for (const position of positions) {
      const value = values.get(position.id);
      if (!value) continue;
      const amount0 = value.token0.amount + value.unclaimedFees0;
      const amount1 = value.token1.amount + value.unclaimedFees1;
      try {
        const quote = position.quoteToken;
        const quoteIs0 = quote?.toLowerCase() === value.token0.token.toLowerCase();
        const quoteIs1 = quote?.toLowerCase() === value.token1.token.toLowerCase();
        if (quote && (quoteIs0 || quoteIs1) && prices.has(quote.toLowerCase()) && (value.range?.currentSqrtPrice ?? value.priceMarker) > 1n) {
          const marked = value.range
            ? quoteValueAtSqrtPrice(amount0, amount1, quoteIs0, value.range.currentSqrtPrice)
            : quoteValueAtPriceMarker(amount0, amount1, quoteIs0, value.priceMarker);
          activeLpUsd += await valueUsd(quote, marked);
        } else {
          activeLpUsd += await valueUsd(value.token0.token, amount0) + await valueUsd(value.token1.token, amount1);
        }
      } catch { issues.push(`${chain}: konversi LP ${position.positionKey} gagal`); }
    }
    log.info({ chain, blockNumber: String(blockNumber), lpCount: positions.length, cacheHits,
      lpIndividualReads: missing.filter(p => !grouped.has(p.id)).length, lpGroupChildren: grouped.size,
      ownershipCalls: nfts.length }, "portfolio LP read budget");
    return { walletUsd, activeLpUsd, issues: [...new Set(issues)] };
  }

  private async walletBalances(chain: ChainName, excluded: Set<string>, blockNumber: bigint, issues: string[], hasPositions: boolean): Promise<TokenBalance[]> {
    const { client } = this.chains.getForScan(chain);
    const amounts = new Map<Address, bigint>();
    const known = this.knownTokens.get(chain)!;
    amounts.set(zeroAddress, await client.getBalance({ address: this.config.executorAddress, blockNumber }));
    let pages = 0;
    let enumerationAttempts = 0;
    let fallbackCalls = 0;
    try {
      const endpoint = this.config.alchemyHttp[chain];
      if (!endpoint) throw new Error("Alchemy endpoint unavailable");
      let pageKey: string | undefined;
      const seenPages = new Set<string>();
      do {
        enumerationAttempts++;
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getTokenBalances",
            params: pageKey ? [this.config.executorAddress, "erc20", { pageKey }] : [this.config.executorAddress, "erc20"] }),
          signal: AbortSignal.timeout(15_000),
        });
        pages++;
        if (!response.ok) throw new Error("Token enumeration failed");
        const payload = await response.json() as { error?: unknown; result?: { tokenBalances?: Array<{ contractAddress: string; tokenBalance: string | null; error?: string }>; pageKey?: string } };
        if (payload.error || !Array.isArray(payload.result?.tokenBalances)) throw new Error("Invalid token balance response");
        for (const item of payload.result.tokenBalances) {
          if (!isAddress(item.contractAddress)) throw new Error("Invalid token address");
          const address = item.contractAddress.toLowerCase() as Address;
          if (excluded.has(address) || address === zeroAddress) continue;
          if (item.error || item.tokenBalance === null) {
            known.add(address);
            throw new Error("Token balance unavailable");
          }
          const amount = BigInt(item.tokenBalance);
          if (amount > 0n) known.add(address);
          amounts.set(address, amount);
        }
        pageKey = payload.result.pageKey;
        if (pageKey && seenPages.has(pageKey)) throw new Error("Repeated token page");
        if (pageKey) seenPages.add(pageKey);
      } while (pageKey);
      // Enumeration is latest-only. If the chain advanced, reconcile at the LP block
      // so a withdrawal cannot appear in both the LP and wallet components.
      if (hasPositions && await client.getBlockNumber({ cacheTime: 0 }) !== blockNumber) {
        await this.readKnownBalances(chain, known, excluded, blockNumber, amounts, issues);
        fallbackCalls += [...known].filter(a => a !== zeroAddress && !excluded.has(a)).length;
      }
    } catch {
      issues.push(`${chain}: daftar token wallet belum lengkap (fallback RPC)`);
      await this.readKnownBalances(chain, known, excluded, blockNumber, amounts, issues);
      fallbackCalls += [...known].filter(a => a !== zeroAddress && !excluded.has(a)).length;
    }
    const balances: TokenBalance[] = [];
    let metadataReads = 0;
    for (const [address, amount] of amounts) {
      if (amount === 0n) continue;
      try {
        if (address !== zeroAddress && !this.decimals.has(`${chain}:${address}`)) metadataReads++;
        balances.push({ address, amount, decimals: await this.tokenDecimals(chain, address) });
      } catch { issues.push(`${chain}: decimals ${address} belum tersedia`); }
    }
    log.info({ chain, alchemyRequests: enumerationAttempts, alchemyPages: pages, balanceOfCalls: fallbackCalls, metadataReads, nativeBalanceCalls: 1 }, "portfolio wallet read budget");
    return balances;
  }

  private async readKnownBalances(chain: ChainName, known: Set<Address>, excluded: Set<string>, blockNumber: bigint,
    amounts: Map<Address, bigint>, issues: string[]): Promise<void> {
    const addresses = [...known].filter(a => a !== zeroAddress && !excluded.has(a));
    if (!addresses.length) return;
    // Drop latest balances before reconciliation, including failed calls.
    for (const address of addresses) amounts.delete(address);
    try {
      const results = await this.chains.getForScan(chain).client.multicall({ multicallAddress: MULTICALL3, blockNumber, contracts: addresses.map(address => ({
        address, abi: erc20Abi, functionName: "balanceOf" as const, args: [this.config.executorAddress] as const,
      })) });
      results.forEach((result, i) => {
        if (result.status === "success") amounts.set(addresses[i]!, result.result);
        else issues.push(`${chain}: saldo ${addresses[i]} gagal dibaca`);
      });
    } catch { issues.push(`${chain}: saldo ERC-20 gagal dibaca`); }
  }

  private async tokenDecimals(chain: ChainName, address: Address): Promise<number> {
    if (address.toLowerCase() === zeroAddress) return 18;
    const key = `${chain}:${address.toLowerCase()}`;
    const cached = this.decimals.get(key);
    if (cached !== undefined) return cached;
    const decimals = await this.chains.getForScan(chain).client.readContract({ address, abi: erc20Abi, functionName: "decimals" });
    this.decimals.set(key, decimals);
    return decimals;
  }

  private readonly staleNativeChains = new Set<ChainName>();
  private async tokenPrices(chain: ChainName, addresses: readonly Address[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    const stableAddresses = new Set<string>();
    for (const quote of this.config.quoteTokens[chain]) {
      if (isUsdStableSymbol(quote.symbol)) {
        const address = quote.address.toLowerCase();
        stableAddresses.add(address);
        prices.set(address, 1);
      }
    }
    const wrappedAddress = chainRegistry[chain].wrappedNative.toLowerCase();
    this.staleNativeChains.delete(chain);
    if (wrappedAddress) {
      const nativeUsd = await this.canonicalWethPrice(chain, wrappedAddress, stableAddresses);
      if (nativeUsd !== null) this.lastNativeUsd.set(chain, nativeUsd);
      else if (chain === "robinhood" && this.lastNativeUsd.has(chain)) this.staleNativeChains.add(chain);
      const cached = this.lastNativeUsd.get(chain);
      if (cached !== undefined) {
        prices.set(wrappedAddress, cached);
        prices.set(zeroAddress, cached);
      }
    }
    const nonStable = [...new Set([...addresses.map(a => a.toLowerCase()), wrappedAddress])].filter((address) => !prices.has(address.toLowerCase()) && address.toLowerCase() !== zeroAddress);
    for (let offset = 0; offset < nonStable.length; offset += 25) {
      const batch = nonStable.slice(offset, offset + 25);
      try {
        const response = await fetch(`${DEXSCREENER_BASE}/tokens/v1/${chainRegistry[chain].dexScreenerChain}/${batch.join(",")}`, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) continue;
        const pairs = await response.json() as DexTokenPair[];
        for (const pair of pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))) {
          const price = Number(pair.priceUsd);
          const base = pair.baseToken?.address?.toLowerCase();
          if (base && Number.isFinite(price) && price > 0 && !prices.has(base)) prices.set(base, price);
        }
        } catch {
          // Tokens without a DexScreener USD price are excluded from the total.
        }
    }
    const nativePrice = prices.get(wrappedAddress);
    if (nativePrice !== undefined) prices.set(zeroAddress, nativePrice);
    return prices;
  }

  private async canonicalWethPrice(chain: ChainName, wethAddress: string, stableAddresses: Set<string>): Promise<number | null> {
    if (chain !== "robinhood") return null;
    try {
      const response = await fetch(`${DEXSCREENER_BASE}/latest/dex/pairs/robinhood/${ROBINHOOD_USDG_WETH_PAIR}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return null;
      const payload = await response.json() as DexPairResponse;
      for (const pair of payload.pairs ?? []) {
        const base = pair.baseToken?.address?.toLowerCase();
        const quote = pair.quoteToken?.address?.toLowerCase();
        const price = Number(pair.priceUsd);
        const nativePrice = Number(pair.priceNative);
        if (quote === wethAddress && base && stableAddresses.has(base)
          && Number.isFinite(price) && price > 0 && Number.isFinite(nativePrice) && nativePrice > 0) {
          return price / nativePrice;
        }
      }
    } catch {
      // Preserve the most recent valid WETH price when DexScreener is temporarily unavailable.
    }
    return null;
  }

}
