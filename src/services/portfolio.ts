import { zeroAddress, type Address } from "viem";

import { erc20Abi } from "../abi.js";
import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import type { ChainName } from "../types.js";
import type { ChainClients } from "./chain-client.js";

const REFRESH_INTERVAL_MS = 3 * 60_000;
const DEXSCREENER_BASE = "https://api.dexscreener.com";
const ROBINHOOD_USDG_WETH_PAIR = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca";

export interface PortfolioSnapshot {
  totalUsd: number;
  walletUsd: number;
  activeLpUsd: number;
  updatedAt: Date;
  calculating: boolean;
}

interface TokenBalance {
  address: Address;
  amount: bigint;
  decimals: number;
}

interface DexTokenPair {
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  priceUsd?: string | null;
  priceNative?: string | null;
  liquidity?: { usd?: number | null };
}

interface DexPairResponse {
  pairs?: DexTokenPair[] | null;
}

export class PortfolioService {
  private snapshot: PortfolioSnapshot = {
    totalUsd: 0,
    walletUsd: 0,
    activeLpUsd: 0,
    updatedAt: new Date(0),
    calculating: true,
  };
  private refreshRunning = false;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private lastWethUsd?: number;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly chains: ChainClients,
    private readonly database: Database,
  ) {}

  getSnapshot(): PortfolioSnapshot {
    return this.snapshot;
  }

  start(): void {
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  async refresh(): Promise<void> {
    if (this.refreshRunning) return;
    this.refreshRunning = true;
    try {
      const totals = await Promise.all(this.config.chains
        .filter((chain): chain is ChainName => chain === "base" || chain === "robinhood")
        .map((chain) => this.refreshChain(chain)));
      const walletUsd = totals.reduce((total, current) => total + current.walletUsd, 0);
      const activeLpUsd = totals.reduce((total, current) => total + current.activeLpUsd, 0);
      this.snapshot = {
        totalUsd: walletUsd + activeLpUsd,
        walletUsd,
        activeLpUsd,
        updatedAt: new Date(),
        calculating: false,
      };
    } catch {
      this.snapshot = { ...this.snapshot, calculating: false };
    } finally {
      this.refreshRunning = false;
    }
  }

  private async refreshChain(chain: ChainName): Promise<{ walletUsd: number; activeLpUsd: number }> {
    const chainId = this.chains.get(chain).registry.chain.id;
    const [allPositions, groups] = await Promise.all([
      this.database.listActivePositions(chainId),
      this.database.listPositionGroups(chainId),
    ]);
    const positions = allPositions
      .filter((position) => position.status === "armed"
        && position.owner.toLowerCase() === this.config.executorAddress.toLowerCase()
        && !isManagedGroupChild(position));
    const activeGroups = groups.filter((group) => group.status === "active");
    const excludedWalletTokens = new Set(
      positions
        .filter((position) => position.protocol === "v2" && position.poolAddress)
        .map((position) => position.poolAddress!.toLowerCase()),
    );
    const balances = await this.walletBalances(chain, excludedWalletTokens);
    const snapshots = await this.database.getLatestSnapshots(positions.map((position) => position.id));
    const addresses = [...new Set([
      ...balances.map((balance) => balance.address.toLowerCase()),
      ...positions.flatMap((position) => position.quoteToken ? [position.quoteToken] : []),
      ...activeGroups.map((group) => group.quoteToken),
      ...this.config.quoteTokens[chain].map((token) => token.address),
    ])] as Address[];
    const prices = await this.tokenPrices(chain, addresses);
    const stable = this.config.quoteTokens[chain].find((token) => token.symbol === "USDG");
    const stableDecimals = stable ? await this.tokenDecimals(chain, stable.address) : 6;
    let walletUsd = 0;
    for (const balance of balances) {
      const price = this.usdPrice(chain, balance.address, prices);
      if (price === null) {
        continue;
      }
      walletUsd += Number(balance.amount) / 10 ** balance.decimals * price;
    }

    let activeLpUsd = 0;
    for (const position of positions) {
      if (!position.quoteToken) continue;
      const snapshot = snapshots.get(position.id);
      if (!snapshot) continue;
      const quotePrice = this.usdPrice(chain, position.quoteToken, prices);
      if (quotePrice === null) continue;
      const decimals = await this.tokenDecimals(chain, position.quoteToken);
      activeLpUsd += Number(snapshot.liquidationQuote) / 10 ** decimals * quotePrice;
      activeLpUsd += Number(snapshot.feeQuoteUsdg) / 10 ** stableDecimals;
    }
    for (const group of activeGroups) {
      const snapshot = await this.database.getLatestPositionGroupPnlSnapshot(group.id);
      if (!snapshot) continue;
      const quotePrice = this.usdPrice(chain, group.quoteToken, prices);
      if (quotePrice === null) continue;
      const decimals = await this.tokenDecimals(chain, group.quoteToken);
      activeLpUsd += Number(snapshot.liquidationQuote + snapshot.feeQuote) / 10 ** decimals * quotePrice;
    }
    return { walletUsd, activeLpUsd };
  }

  private async walletBalances(chain: ChainName, excluded: Set<string>): Promise<TokenBalance[]> {
    const { client } = this.chains.getForScan(chain);
    const native = await client.getBalance({ address: this.config.executorAddress });
    const balances: TokenBalance[] = [{ address: zeroAddress, amount: native, decimals: 18 }];
    try {
      let pageKey: string | undefined;
      do {
        const response = await client.request({
          method: "alchemy_getTokenBalances" as never,
          params: pageKey
            ? [this.config.executorAddress, "erc20", { pageKey }]
            : [this.config.executorAddress, "erc20"],
        } as never) as unknown as { tokenBalances?: Array<{ contractAddress: string; tokenBalance: string }>; pageKey?: string };
        for (const item of response.tokenBalances ?? []) {
          const address = item.contractAddress.toLowerCase() as Address;
          if (excluded.has(address)) continue;
          const amount = BigInt(item.tokenBalance || "0x0");
          if (amount === 0n) continue;
          balances.push({ address, amount, decimals: await this.tokenDecimals(chain, address) });
        }
        pageKey = response.pageKey;
      } while (pageKey);
    } catch {
      // Native balance remains available when the Alchemy token endpoint is unavailable.
    }
    return balances;
  }

  private async tokenDecimals(chain: ChainName, address: Address): Promise<number> {
    if (address.toLowerCase() === zeroAddress) return 18;
    const cached = this.chains.getCachedToken(address);
    if (cached) return cached.decimals;
    const { client } = this.chains.getForScan(chain);
    const decimals = await client.readContract({ address, abi: erc20Abi, functionName: "decimals" });
    const symbol = await client.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => "?");
    this.chains.cacheToken(address, { decimals, symbol });
    return decimals;
  }

  private async tokenPrices(chain: ChainName, addresses: readonly Address[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    const stableAddresses = new Set<string>();
    for (const quote of this.config.quoteTokens[chain]) {
      if (quote.symbol === "USDG" || quote.symbol === "USDC") {
        const address = quote.address.toLowerCase();
        stableAddresses.add(address);
        prices.set(address, 1);
      }
    }
    const wethAddress = this.config.quoteTokens[chain].find((token) => token.symbol === "WETH")?.address.toLowerCase();
    if (wethAddress) {
      const wethUsd = await this.canonicalWethPrice(chain, wethAddress, stableAddresses);
      if (wethUsd !== null) this.lastWethUsd = wethUsd;
      if (this.lastWethUsd !== undefined) {
        prices.set(wethAddress, this.lastWethUsd);
        prices.set(zeroAddress, this.lastWethUsd);
      }
    }
    const nonStable = addresses.filter((address) => !prices.has(address.toLowerCase()) && address.toLowerCase() !== zeroAddress);
    for (let offset = 0; offset < nonStable.length; offset += 25) {
      const batch = nonStable.slice(offset, offset + 25);
      try {
        const response = await fetch(`${DEXSCREENER_BASE}/tokens/v1/${chain}/${batch.join(",")}`, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) continue;
        const pairs = await response.json() as DexTokenPair[];
        for (const pair of pairs) {
          const price = Number(pair.priceUsd);
          const base = pair.baseToken?.address?.toLowerCase();
          if (base && Number.isFinite(price) && price > 0 && !prices.has(base)) prices.set(base, price);
        }
        } catch {
          // Tokens without a DexScreener USD price are excluded from the total.
        }
    }
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

  private usdPrice(chain: ChainName, address: Address | null, prices: Map<string, number>): number | null {
    if (!address) return null;
    return prices.get(address.toLowerCase()) ?? null;
  }
}

function isManagedGroupChild(position: { metadata: Record<string, unknown> }): boolean {
  return position.metadata.managedBy === "position_group"
    && typeof position.metadata.positionGroupId === "string";
}
