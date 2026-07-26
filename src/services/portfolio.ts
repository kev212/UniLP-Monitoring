import { zeroAddress, type Address } from "viem";

import { erc20Abi } from "../abi.js";
import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import type { ChainName, PositionRecord } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import type { PnlService } from "./pnl.js";

const REFRESH_INTERVAL_MS = 3 * 60_000;
const DEXSCREENER_BASE = "https://api.dexscreener.com";

export interface PortfolioSnapshot {
  totalUsd: number;
  walletUsd: number;
  activeLpUsd: number;
  unpricedTokens: number;
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
  liquidity?: { usd?: number | null };
}

export class PortfolioService {
  private snapshot: PortfolioSnapshot = {
    totalUsd: 0,
    walletUsd: 0,
    activeLpUsd: 0,
    unpricedTokens: 0,
    updatedAt: new Date(0),
    calculating: true,
  };
  private refreshRunning = false;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly chains: ChainClients,
    private readonly database: Database,
    private readonly pnl: PnlService,
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
      const results = await Promise.all(this.config.chains.map((chain) => this.refreshChain(chain)));
      const walletUsd = results.reduce((sum, result) => sum + result.walletUsd, 0);
      const activeLpUsd = results.reduce((sum, result) => sum + result.activeLpUsd, 0);
      const unpricedTokens = results.reduce((sum, result) => sum + result.unpricedTokens, 0);
      this.snapshot = {
        totalUsd: walletUsd + activeLpUsd,
        walletUsd,
        activeLpUsd,
        unpricedTokens,
        updatedAt: new Date(),
        calculating: false,
      };
    } catch {
      this.snapshot = { ...this.snapshot, calculating: false };
    } finally {
      this.refreshRunning = false;
    }
  }

  private async refreshChain(chain: ChainName): Promise<{ walletUsd: number; activeLpUsd: number; unpricedTokens: number }> {
    const { client } = this.chains.getForScan(chain);
    const positions = (await this.database.listActivePositions(this.chains.get(chain).registry.chain.id))
      .filter((position) => position.status === "armed" && position.owner.toLowerCase() === this.config.executorAddress.toLowerCase());
    const excludedWalletTokens = new Set(
      positions
        .filter((position) => position.protocol === "v2" && position.poolAddress)
        .map((position) => position.poolAddress!.toLowerCase()),
    );
    const balances = await this.walletBalances(chain, excludedWalletTokens);
    const addresses = [...new Set([
      ...balances.map((balance) => balance.address.toLowerCase()),
      ...positions.flatMap((position) => [position.token0, position.token1]),
      ...this.config.quoteTokens[chain].map((token) => token.address),
    ])] as Address[];
    const prices = await this.tokenPrices(chain, addresses);
    let unpricedTokens = 0;
    let walletUsd = 0;
    for (const balance of balances) {
      const price = this.usdPrice(chain, balance.address, prices);
      if (price === null) {
        unpricedTokens += 1;
        continue;
      }
      walletUsd += Number(balance.amount) / 10 ** balance.decimals * price;
    }

    let activeLpUsd = 0;
    for (const position of positions) {
      try {
        if (!position.quoteToken) continue;
        const valued = await this.pnl.value(position, await client.getBlockNumber(), this.config.maxSwapSlippageBps, false);
        const quotePrice = this.usdPrice(chain, position.quoteToken, prices);
        if (quotePrice !== null) {
          const decimals = await this.tokenDecimals(chain, position.quoteToken);
          const totalQuote = valued.snapshot.liquidationQuote + valued.snapshot.feeQuote;
          activeLpUsd += Number(totalQuote) / 10 ** decimals * quotePrice;
        }
      } catch {
        unpricedTokens += 1;
      }
    }
    return { walletUsd, activeLpUsd, unpricedTokens };
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
    for (const quote of this.config.quoteTokens[chain]) {
      if (quote.symbol === "USDG" || quote.symbol === "USDC") prices.set(quote.address.toLowerCase(), 1);
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
          const quote = pair.quoteToken?.address?.toLowerCase();
          if (quote && Number.isFinite(price) && price > 0 && !prices.has(quote)) prices.set(quote, price);
        }
      } catch {
        // Individual unpriced tokens are reported through unpricedTokens.
      }
    }
    const nativePrice = prices.get(this.config.quoteTokens[chain].find((token) => token.symbol === "WETH")?.address.toLowerCase() ?? "");
    if (nativePrice !== undefined) prices.set(zeroAddress, nativePrice);
    return prices;
  }

  private usdPrice(chain: ChainName, address: Address | null, prices: Map<string, number>): number | null {
    if (!address) return null;
    return prices.get(address.toLowerCase()) ?? null;
  }
}
