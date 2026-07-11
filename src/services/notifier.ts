import { Bot, Context, type CommandContext } from "grammy";
import { isAddress, zeroAddress, type Address } from "viem";

import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type { ExitTrigger, PnlSnapshot, PositionRecord } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import type { Executor } from "./executor.js";
import type { PnlService } from "./pnl.js";
import type { PoolScanner, ScoredPool } from "./pool-scanner.js";

type ChatContext = CommandContext<Context>;

export class Notifier {
  private readonly bot?: Bot;
  private readonly lastStatusCache = new Map<string, PositionRecord[]>();

  constructor(
    private readonly config: RuntimeConfig,
    private readonly chains: ChainClients,
  ) {
    this.bot = config.telegram ? new Bot(config.telegram.token) : undefined;
  }

  registerCommands(database: Database, pnl: PnlService, executor: Executor, scanner: PoolScanner): void {
    if (!this.bot) return;
    void this.bot.api.setMyCommands([
      { command: "status", description: "Tampilkan status semua posisi LP aktif" },
      { command: "close", description: "Tutup posisi LP — /close <nomor> atau /close <key>" },
      { command: "scan", description: "Scan pool Uniswap V3/V4 untuk token — /scan <contract>" },
    ]);
    this.bot.command("status", async (ctx: ChatContext) => {
      await this.handleStatus(ctx, database, pnl);
    });
    this.bot.command("close", async (ctx: ChatContext) => {
      await this.handleClose(ctx, database, executor);
    });
    this.bot.command("scan", async (ctx: ChatContext) => {
      await this.handleScan(ctx, scanner);
    });
  }

  async positionDiscovered(position: PositionRecord): Promise<void> {
    if (!this.bot || !this.config.telegram) return;
    const t0 = await this.tokenLabel(position.token0, position.chainId);
    const t1 = await this.tokenLabel(position.token1, position.chainId);
    const liq = position.liquidity === null ? "N/A" : await this.formatLiquidity(position, position.liquidity);
    await this.send([
      "🟢 LP DETECTED",
      `${position.protocol.toUpperCase()} | chain ${position.chainId}`,
      `position: ${position.positionKey}`,
      `pair: ${t0} / ${t1}`,
      `liquidity: ${liq}`,
      `status: ${position.status}`,
    ]);
  }

  async armed(position: PositionRecord, snapshot: PnlSnapshot): Promise<void> {
    if (!this.bot || !this.config.telegram) return;
    const t0 = await this.tokenLabel(position.token0, position.chainId);
    const t1 = await this.tokenLabel(position.token1, position.chainId);
    const qtSymbol = this.quoteSymbol(position.quoteToken);
    const qtDec = await this.decimals(position.quoteToken, position.chainId);
    const meta = position.metadata as Record<string, unknown>;
    const tickLower = meta.tickLower as number | undefined;
    const tickUpper = meta.tickUpper as number | undefined;
    const sl = this.config.stopLossPercent;
    const tp = this.config.takeProfitPercent;

    const lines: string[] = [
      "🔔 LP ARMED",
      `${position.protocol.toUpperCase()} | chain ${position.chainId}`,
      `position: ${position.positionKey}`,
      `pair: ${t0} / ${t1}`,
    ];
    const liveLiquidity = snapshot.liquidity ?? position.liquidity;
    if (liveLiquidity !== null && liveLiquidity !== undefined) {
      lines.push(`liquidity: ${await this.formatLiquidity(position, liveLiquidity)}`);
    }
    if (tickLower !== undefined && tickUpper !== undefined) {
      lines.push(`range: [${tickLower} → ${tickUpper}]`);
    }
    lines.push("");
    lines.push(`💵 Deposit   : ${formatToken(snapshot.depositsQuote, qtDec)} ${qtSymbol}`);
    lines.push(`🪙 Fees      : ${formatToken(snapshot.realizedQuote, qtDec)} ${qtSymbol}`);
    lines.push(`💰 Value now : ${formatToken(snapshot.liquidationQuote, qtDec)} ${qtSymbol}`);
    lines.push(`📈 PnL       : ${formatBps(snapshot.pnlBps)}% (${formatToken(snapshot.pnlQuote, qtDec)} ${qtSymbol})`);
    lines.push("");
    lines.push(`SL: ${sl}% | TP: +${tp}% | Trail: +${this.config.trailingStopActivationPercent}% / -${this.config.trailingStopDrawdownPercent}%`);
    lines.push(`block: ${snapshot.blockNumber.toString()}`);

    await this.send(lines);
  }

  async logPnL(position: PositionRecord, snapshot: PnlSnapshot): Promise<void> {
    const t0 = await this.tokenLabel(position.token0, position.chainId);
    const t1 = await this.tokenLabel(position.token1, position.chainId);
    const qtSymbol = this.quoteSymbol(position.quoteToken);
    const qtDec = await this.decimals(position.quoteToken, position.chainId);
    const pair = position.quoteToken?.toLowerCase() === position.token0.toLowerCase() ? `${t1}/${t0}` : `${t0}/${t1}`;
    const usdg = this.config.quoteTokens.robinhood[0]?.address;
    const usdgDec = usdg ? 6 : 0;
    const usdgSymbol = usdg ? "USDG" : "??";
    const feeParts: string[] = [formatToken(snapshot.feeQuote, qtDec, 2)];
    if (snapshot.feeNonQuote) {
      const nqSymbol = await this.tokenLabel(snapshot.feeNonQuote.token, position.chainId);
      const nqAmount = formatToken(snapshot.feeNonQuote.amount, await this.decimals(snapshot.feeNonQuote.token, position.chainId), 2);
      feeParts.push(`+ ${nqAmount} ${nqSymbol}`);
    }
    const feeDisplay = snapshot.feeNonQuote
      ? `${feeParts.join(" ")} (≈ ${formatToken(snapshot.feeQuoteUsdg, usdgDec, 4)} ${usdgSymbol})`
      : `${formatToken(snapshot.feeQuoteUsdg, usdgDec, 4)} ${usdgSymbol}`;
    log.info({ Pool: `${position.positionKey} ${pair} | CV: ${formatToken(snapshot.liquidationQuote, qtDec, 2)} ${qtSymbol} | Fees: ${feeDisplay} | PnL: ${formatBps(snapshot.pnlBps)}%` });
  }

  async trigger(position: PositionRecord, snapshot: PnlSnapshot, reason: ExitTrigger): Promise<void> {
    if (!this.bot || !this.config.telegram) return;
    const label = reason === "stop_loss"
      ? "stop loss"
      : reason === "take_profit"
        ? "take profit"
      : reason === "trailing_take_profit"
        ? "trailing take profit"
        : "manual";
    const pair = await this.pairLabel(position);
    const qtSymbol = this.quoteSymbol(position.quoteToken);
    const qtDec = await this.decimals(position.quoteToken, position.chainId);
    await this.send([
      `🔔 LP EXIT — ${label}`,
      `V4 #${position.positionKey} ${pair}`,
      `CV: ${formatToken(snapshot.liquidationQuote, qtDec, 2)} ${qtSymbol} | PnL: ${pnlEmoji(snapshot.pnlBps)} ${formatBps(snapshot.pnlBps)}% | Fees: ${formatToken(snapshot.feeQuoteUsdg, 6, 4)} USDG`,
      this.config.dryRun ? "DRY_RUN: transaction not broadcast" : "Auto-exit started...",
    ]);
  }

  async transaction(position: PositionRecord, stage: string, hash: string): Promise<void> {
    const pair = await this.pairLabel(position);
    const label = stage === "remove_liquidity"
      ? "🔓 Liquidity removed"
      : stage === "swap_to_quote"
        ? "💱 Swap completed"
        : `✅ ${stage.replace(/_/g, " ")}`;
    await this.send([label, `V4 #${position.positionKey} ${pair}`, `tx: ${hash}`]);
  }

  async settled(position: PositionRecord): Promise<void> {
    const pair = await this.pairLabel(position);
    const meta = position.metadata as Record<string, unknown>;
    const total = typeof meta.totalReceived === "string" ? meta.totalReceived : undefined;
    const lines = [`✅ LP settled`, `V4 #${position.positionKey} ${pair}`];
    if (total) {
      const qtDec = await this.decimals(position.quoteToken, position.chainId);
      lines.push(`Total: ~${formatToken(BigInt(total), qtDec, 2)} ${this.quoteSymbol(position.quoteToken)}`);
    }
    await this.send(lines);
  }

  async failure(position: PositionRecord, message: string): Promise<void> {
    const pair = await this.pairLabel(position);
    const meta = position.metadata as Record<string, unknown>;
    const retry = meta.exitRetry;
    const attempt = retry && typeof retry === "object" && !Array.isArray(retry)
      ? (retry as Record<string, unknown>).attempts : undefined;
    const reason = retry && typeof retry === "object" && !Array.isArray(retry)
      ? (retry as Record<string, unknown>).reason : undefined;
    const lines = ["❌ LP close failed", `V4 #${position.positionKey} ${pair}`];
    if (reason) lines.push(`trigger: ${reason}`);
    if (attempt !== undefined) lines.push(`retry #${attempt}`);
    lines.push(`error: ${message.slice(0, 500)}`);
    await this.send(lines);
  }

  async startBot(): Promise<void> {
    if (!this.bot) return;
    log.info("Telegram bot polling started");
    await this.bot.start();
  }

  async stopBot(): Promise<void> {
    if (!this.bot) return;
    await this.bot.stop();
  }

  private async handleStatus(ctx: ChatContext, database: Database, pnl: PnlService): Promise<void> {
    const chatId = ctx.chat.id.toString();
    if (!this.authorized(chatId)) return;

    const positions: PositionRecord[] = [];
    const blocks: Record<number, bigint> = {};
    for (const chain of this.config.chains) {
      const { client, registry } = this.chains.get(chain);
      const block = await client.getBlockNumber();
      blocks[registry.chain.id] = block;
      positions.push(...(await database.listActivePositions(registry.chain.id)));
    }

    const active = positions.filter((position) => position.status !== "paused");

    if (active.length === 0) {
      this.lastStatusCache.delete(chatId);
      await ctx.reply("No active positions.");
      return;
    }

    this.lastStatusCache.set(chatId, active);

    const sl = this.config.stopLossPercent;
    const tp = this.config.takeProfitPercent;
    let replied = false;
    let message = "LP STATUS\n";

    for (let index = 0; index < active.length; index++) {
      const position = active[index]!;
      const line = await this.formatStatusLine(position, pnl, blocks[position.chainId], index + 1);
      if (message.length + line.length + 1 > 3800) {
        await ctx.reply(message);
        replied = true;
        message = "";
      }
      message += line;
    }

    message += `\n\nSL: ${sl}% | TP: +${tp}% | Trail: +${this.config.trailingStopActivationPercent}% / -${this.config.trailingStopDrawdownPercent}%\n⚠️ NEEDS REVIEW adalah manual-only\n— /close <nomor> atau /close <key>`;
    if (replied || message.length > 100) await ctx.reply(message);
  }

  private async formatStatusLine(position: PositionRecord, pnl: PnlService, blockNumber: bigint | undefined, index: number): Promise<string> {
    const t0 = await this.tokenLabel(position.token0, position.chainId);
    const t1 = await this.tokenLabel(position.token1, position.chainId);
    const pair = position.quoteToken?.toLowerCase() === position.token0.toLowerCase() ? `${t1}/${t0}` : `${t0}/${t1}`;
    const statusLabel = statusDisplay(position.status);
    const reviewReason = position.status === "needs_review"
      ? ` | ${reviewReasonDisplay(position.metadata)}`
      : "";
    const base = `${index}. ${statusLabel} ${position.protocol.toUpperCase()} #${position.positionKey} ${pair}${reviewReason}`;

    if (!position.quoteToken || !blockNumber) return `${base}\n`;
    try {
      const valued = await pnl.value(position, blockNumber);
      const qtSymbol = this.quoteSymbol(position.quoteToken);
      const qtDec = await this.decimals(position.quoteToken, position.chainId);
      const cv = formatToken(valued.snapshot.liquidationQuote, qtDec, 2);
      let feeStr = formatToken(valued.snapshot.feeQuote, qtDec, 2);
      if (valued.snapshot.feeNonQuote) {
        const nqSymbol = await this.tokenLabel(valued.snapshot.feeNonQuote.token, position.chainId);
        feeStr += ` + ${formatToken(valued.snapshot.feeNonQuote.amount, await this.decimals(valued.snapshot.feeNonQuote.token, position.chainId), 2)} ${nqSymbol}`;
      }
      const usdgDec = 6;
      const feeDisplay = valued.snapshot.feeNonQuote
        ? `${feeStr} (≈ ${formatToken(valued.snapshot.feeQuoteUsdg, usdgDec, 4)} USDG)`
        : `${formatToken(valued.snapshot.feeQuoteUsdg, usdgDec, 4)} USDG`;
      const pnlText = `${pnlEmoji(valued.snapshot.pnlBps)} ${formatBps(valued.snapshot.pnlBps)}%`;
      const trailingPeak = trailingPeakDisplay(position.metadata);
      return `${base} | 💰 ${cv} ${qtSymbol} | 🪙 ${feeDisplay} | 📊 ${pnlText}${trailingPeak}\n`;
    } catch {
      return `${base}\n`;
    }
  }

  private lastScanAt = 0;

  private async handleScan(ctx: ChatContext, scanner: PoolScanner): Promise<void> {
    const chatId = ctx.chat.id.toString();
    if (!this.authorized(chatId)) return;

    const raw = ctx.match.trim();
    if (!raw) {
      await ctx.reply("Gunakan /scan <token-contract-address>");
      return;
    }
    if (!isAddress(raw)) {
      await ctx.reply("Address tidak valid.");
      return;
    }

    const elapsed = Date.now() - this.lastScanAt;
    if (elapsed < 15_000) {
      await ctx.reply(`Tunggu ${Math.ceil((15_000 - elapsed) / 1_000)} detik sebelum scan berikutnya.`);
      return;
    }
    this.lastScanAt = Date.now();

    await ctx.reply(`🔍 Mencari pool Uniswap V3/V4 untuk ${shortAddress(raw)} di Robinhood...`);

    let scan;
    try {
      scan = await scanner.scan(raw as Address);
    } catch (error) {
      await ctx.reply(`Scan gagal: ${error instanceof Error ? error.message.slice(0, 500) : "unknown error"}`);
      return;
    }

    if (scan.active.length === 0 && scan.watchlist.length === 0) {
      await ctx.reply(`Tidak ditemukan pool Uniswap V3/V4 dengan TVL > $0 dan Vol 1h >= $100 untuk token ini.`);
      return;
    }

    const lines: string[] = [
      `🔍 SCAN: ${shortAddress(raw)}`,
      "Chain: Robinhood (4663)",
      `Top active: ${scan.active.length} | Watchlist: ${scan.watchlist.length}`,
      "",
    ];
    const medals = ["🥇", "🥈", "🥉"];

    for (let i = 0; i < scan.active.length; i++) {
      lines.push(...formatScanPool(scan.active[i]!, medals[i]!));
    }
    if (scan.watchlist.length > 0) {
      lines.push("", "⚠️ WATCHLIST: zero active liquidity");
      for (const pool of scan.watchlist) {
        lines.push(...formatScanPool(pool, "•"));
      }
    }

    lines.push("", "Rumus: (vol1h × feeRate / TVL) × √(TVL / (TVL + $1M))");

    await ctx.reply(lines.join("\n"));
  }

  private async handleClose(ctx: ChatContext, database: Database, executor: Executor): Promise<void> {
    const chatId = ctx.chat.id.toString();
    if (!this.authorized(chatId)) return;

    const key = ctx.match.trim();
    if (!key) { await ctx.reply("Gunakan /close <nomor> atau /close <key>. Jalankan /status dulu."); return; }

    let found: PositionRecord | null = null;

    // Index-based lookup from last /status cache
    const index = parseInt(key, 10);
    if (!isNaN(index) && index >= 1) {
      const cached = this.lastStatusCache.get(chatId);
      if (cached && index <= cached.length) {
        found = cached[index - 1]!;
      }
    }

    // Fallback: search by position key across chains/protocols
    if (!found) {
      for (const chain of this.config.chains) {
        const { registry } = this.chains.get(chain);
        for (const protocol of ["v4", "v3", "v2"] as const) {
          found = await database.findPositionByKey(registry.chain.id, protocol, key);
          if (found) break;
        }
        if (found) break;
      }
    }

    if (!found) {
      await ctx.reply(`Posisi "${key}" tidak ditemukan. Jalankan /status dulu, lalu gunakan nomor (contoh: /close 1) atau position key (contoh: /close 33850).`);
      return;
    }
    if (found.status === "closing" || found.status === "settled") {
      await ctx.reply(`Posisi ${found.positionKey} sudah ${found.status === "closing" ? "sedang ditutup" : "settled"}.`);
      return;
    }
    if (found.status === "needs_review") {
      await ctx.reply(`Posisi ${found.positionKey} manual-only: ${reviewReasonDisplay(found.metadata)}.`);
      return;
    }

    await ctx.reply(`Menutup ${found.protocol.toUpperCase()} #${found.positionKey}...`);
    try {
      await executor.execute(found, "manual");
      await ctx.reply(`Posisi ${found.positionKey} — penutupan dimulai.`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Close gagal: ${message.slice(0, 500)}`);
    }
  }

  private authorized(chatId: string): boolean {
    if (!this.config.telegram || chatId !== this.config.telegram.chatId) return false;
    return true;
  }

  private async pairLabel(position: PositionRecord): Promise<string> {
    const t0 = await this.tokenLabel(position.token0, position.chainId);
    const t1 = await this.tokenLabel(position.token1, position.chainId);
    return position.quoteToken?.toLowerCase() === position.token0.toLowerCase() ? `${t1}/${t0}` : `${t0}/${t1}`;
  }

  private async tokenLabel(address: Address | null, chainId?: number): Promise<string> {
    if (!address) return "0x0";
    if (address.toLowerCase() === zeroAddress) return "ETH";
    const qt = this.config.quoteTokens.robinhood.concat(this.config.quoteTokens.base).find(q => q.address.toLowerCase() === address.toLowerCase());
    if (qt) return qt.symbol;
    const cached = this.chains.getCachedToken(address);
    if (cached) return cached.symbol;
    try {
      const { client } = chainId === undefined ? this.chains.get("robinhood") : this.chains.getById(chainId);
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address, abi: [{ name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }], functionName: "symbol" }),
        client.readContract({ address, abi: [{ name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }], functionName: "decimals" }),
      ]);
      this.chains.cacheToken(address, { decimals, symbol });
      return symbol;
    } catch {
      return shortAddress(address);
    }
  }

  private quoteSymbol(address: Address | null): string {
    if (!address) return "?";
    for (const chain of ["robinhood", "base"] as const) {
      const qt = this.config.quoteTokens[chain].find(q => q.address.toLowerCase() === address.toLowerCase());
      if (qt) return qt.symbol;
    }
    return shortAddress(address);
  }

  private async decimals(address: Address | null, chainId?: number): Promise<number> {
    if (!address) return 18;
    const cached = this.chains.getCachedToken(address);
    if (cached) return cached.decimals;
    try {
      const { client } = chainId === undefined ? this.chains.get("robinhood") : this.chains.getById(chainId);
      const d = await client.readContract({ address, abi: [{ name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }], functionName: "decimals" });
      return d;
    } catch {
      return 18;
    }
  }

  private async formatLiquidity(position: PositionRecord, liquidity: bigint): Promise<string> {
    if (position.protocol === "v2" && position.poolAddress) {
      const decimals = await this.decimals(position.poolAddress, position.chainId);
      return `${formatToken(liquidity, decimals)} LP`;
    }
    return `${liquidity.toString()} units`;
  }

  private sendQueue: Promise<void> = Promise.resolve();
  private lastSendAt = 0;

  private async send(lines: string[]): Promise<void> {
    if (!this.bot || !this.config.telegram) return;
    const run = this.sendQueue.then(async () => {
      const elapsed = Date.now() - this.lastSendAt;
      if (elapsed < 300) await sleep(300 - elapsed);
      this.lastSendAt = Date.now();
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await this.bot!.api.sendMessage(this.config.telegram!.chatId, lines.join("\n"));
          return;
        } catch (error: unknown) {
          const code = (error as { error_code?: number })?.error_code;
          if (code === 429 && attempt < 3) {
            const retryAfter = Number((error as { parameters?: { retry_after?: number } })?.parameters?.retry_after ?? 5);
            log.warn({ retryAfter, attempt }, "Telegram rate-limited — retrying");
            await sleep(retryAfter * 1000);
            continue;
          }
          log.warn({ err: error }, "could not send Telegram notification");
          return;
        }
      }
    });
    this.sendQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBps(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function formatToken(value: bigint, decimals: number, maxDecimals?: number): string {
  if (decimals === 0 || value === 0n) return value.toString();
  const divisor = 10n ** BigInt(Math.min(decimals, 18));
  const integer = value / divisor;
  const fraction = value % divisor;
  if (fraction === 0n) return integer.toString();
  let fracStr = fraction.toString().padStart(Math.min(decimals, 18), "0").replace(/0+$/, "");
  if (maxDecimals !== undefined && fracStr.length > maxDecimals) {
    fracStr = fracStr.slice(0, maxDecimals);
  }
  return `${integer}.${fracStr}`;
}

function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function statusDisplay(status: string): string {
  if (status === "needs_review") return "⚠️ NEEDS REVIEW";
  if (status === "closing") return "⏳ CLOSING";
  if (status === "paused") return "⏸️ PAUSED";
  if (status === "armed") return "🟢 ARMED";
  if (status === "syncing") return "🔄 SYNCING";
  if (status === "discovered") return "🆕 NEW";
  return status.toUpperCase();
}

function pnlEmoji(pnlBps: bigint): string {
  if (pnlBps > 0n) return "📈";
  if (pnlBps < 0n) return "📉";
  return "➖";
}

function trailingPeakDisplay(metadata: Record<string, unknown>): string {
  const raw = metadata.trailingStop;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const peak = (raw as Record<string, unknown>).peakPnlBps;
  if (typeof peak !== "string") return "";
  try {
    return ` | 🎯 Peak ${formatBps(BigInt(peak))}%`;
  } catch {
    return "";
  }
}

function reviewReasonDisplay(metadata: Record<string, unknown>): string {
  const reason = typeof metadata.reason === "string" ? metadata.reason : "requires manual review";
  if (reason === "native_currency_v4_requires_manual_settlement") return "native ETH requires manual settlement";
  return reason.length > 120 ? `${reason.slice(0, 117)}...` : reason;
}

function scoreStars(score: number): string {
  if (score >= 0.01) return "★★★★★";
  if (score >= 0.005) return "★★★★☆";
  if (score >= 0.001) return "★★★☆☆";
  if (score >= 0.0001) return "★★☆☆☆";
  if (score > 0) return "★☆☆☆☆";
  return "☆☆☆☆☆";
}

function formatScanPool(pool: ScoredPool, label: string): string[] {
  const effectiveFee = pool.currentLpFee ?? pool.feeTier;
  const feePct = (effectiveFee / 10_000).toFixed(2);
  const dynamicLabel = pool.dynamicFee ? " (dynamic)" : "";
  const lines = [
    `${label} ${scoreStars(pool.score)} ${pool.protocol.toUpperCase()} ${pool.pair} | ${feePct}%${dynamicLabel}`,
    `   TVL: $${fmtUsd(pool.tvlUsd)} | Vol 1h: $${fmtUsd(pool.volume1hUsd)} | Est. gross fees 1h: $${fmtUsd(pool.estimatedPoolFees1hUsd)}`,
    `   Score: ${pool.score.toFixed(6)} | Uniswap: ${pool.uniswapUrl}`,
  ];
  if (pool.warnings.length > 0) lines.push(`   ⚠️ ${pool.warnings.join(", ")}`);
  return lines;
}

function fmtUsd(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toExponential(2);
}
