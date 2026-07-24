import { Bot, Context, InlineKeyboard, InputFile, type CommandContext } from "grammy";
import { isAddress, parseUnits, zeroAddress, type Address } from "viem";
import sharp from "sharp";

import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type { ChainName, CloseHistoryRecord, ExitTrigger, PnlSnapshot, PoolScanSettings, PositionRangeInfo, PositionRecord, PositionStatus, Protocol, QuoteToken, RiskSettings } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import type { Executor } from "./executor.js";
import type { PnlService } from "./pnl.js";
import type { PositionOpener, OpenPositionPreview } from "./position-opener.js";
import { fmtUtc, renderPnlCard } from "./pnl-card.js";
import { renderPnlCalendarCard } from "./pnl-calendar-card.js";
import type { PoolMarketScan, PoolScanFilters, PoolScanner, ScoredPool } from "./pool-scanner.js";
import { quoteRangeState } from "./quote-range.js";
import { sqrtRatioAtTick } from "./uniswap-math.js";

type ChatContext = CommandContext<Context>;

const DASHBOARD_PAGE_SIZE = 6;
const DASHBOARD_VALUE_CONCURRENCY = 3;
const HISTORY_IDLE_TTL_MS = 30_000;
const CALENDAR_IDLE_TTL_MS = 60_000;

type DashboardAction =
  | { type: "refresh"; page: number }
  | { type: "close"; page: number }
  | { type: "status"; page: number }
  | { type: "scan"; page: number }
  | { type: "scan_pools"; page: number }
  | { type: "config"; page: number }
  | { type: "config_reset"; page: number }
  | { type: "config_edit"; key: PoolSettingKey }
  | { type: "config_quote"; quote: string }
  | { type: "risk"; page: number }
  | { type: "risk_reset"; page: number }
  | { type: "risk_edit"; key: RiskSettingKey }
  | { type: "history"; page: number }
  | { type: "pnl_card"; page: number }
  | { type: "pnl_card_select"; page: number; historyIndex: number }
  | { type: "bg_upload"; page: number }
  | { type: "bg_reset"; page: number }
  | { type: "calendar"; year: number; month: number }
  | { type: "calendar_page"; year: number; month: number }
  | { type: "history_page"; page: number }
  | { type: "open"; page: number }
  | { type: "open_pool_input"; page: number }
  | { type: "open_confirm"; requestId: string }
  | { type: "open_cancel"; page: number }
  | { type: "select" | "confirm"; page: number; chainId: number; protocol: Protocol; positionKey: string };

type PoolSettingKey = "market_cap" | "pool_tvl" | "total_tvl" | "age" | "yield" | "max_results";
type RiskSettingKey = "stop_loss" | "take_profit" | "trailing_activation" | "trailing_drawdown";
type PendingInput =
  | { kind: "scan_token"; chain: ChainName }
  | { kind: "config"; key: PoolSettingKey; dashboardMessageId: number }
  | { kind: "risk"; key: RiskSettingKey; dashboardMessageId: number }
  | { kind: "open_pool"; chain: ChainName; dashboardMessageId: number }
  | { kind: "open_range"; chain: ChainName; poolAddress: string; dashboardMessageId: number }
  | { kind: "open_amount"; chain: ChainName; poolAddress: string; dropPercent: number; quoteToken: QuoteToken; dashboardMessageId: number };

interface DashboardView {
  text: string;
  positions: PositionRecord[];
  page: number;
  pageCount: number;
}

export class Notifier {
  private readonly bot?: Bot;
  private readonly database?: Database;
  private readonly lastStatusCache = new Map<string, PositionRecord[]>();
  private readonly dashboardCloseInFlight = new Set<string>();
  private readonly pendingInput = new Map<string, PendingInput>();
  private readonly pendingBgUpload = new Set<string>();
  private readonly riskDefaults: RiskSettings;
  private poolScanRunning = false;
  private tokenScanRunning = false;
  private scanV2Running = false;
  private deletionTimer: ReturnType<typeof setInterval> | null = null;
  private readonly openConfirmations = new Map<string, OpenPositionPreview>();
  private positionOpener?: PositionOpener;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly chains: ChainClients,
    database?: Database,
  ) {
    this.database = database;
    this.riskDefaults = this.riskSettings();
    if (!config.telegram) return;
    this.bot = new Bot(config.telegram.token);
    this.bot.catch((error) => {
      log.error({ updateId: error.ctx.update.update_id }, "Telegram update failed");
    });
  }

  setPositionOpener(opener: PositionOpener): void {
    this.positionOpener = opener;
  }

  registerCommands(database: Database, pnl: PnlService, executor: Executor, scanner: PoolScanner): void {
    if (!this.bot) return;
    void this.bot.api.setMyCommands([
      { command: "status", description: "Tampilkan status semua posisi LP aktif" },
      { command: "close", description: "Tutup posisi LP — fallback /close <nomor> atau /close <key>" },
      { command: "scan", description: "Scan token — /scan [base|robinhood] <contract>" },
      ...(this.config.scanV2Enabled ? [{ command: "scanv2", description: "Scan concentrated yield — /scanv2 [chain] <contract> [range%]" }] : []),
      { command: "scan_pools", description: "Cari pool V3/V4 dengan estimasi yield 1 jam tertinggi" },
      { command: "history", description: "Tampilkan riwayat posisi close >= ±0.5% PnL" },
      { command: "calendar", description: "Tampilkan kalender realized PnL UTC" },
    ]).catch((error) => {
      log.warn({ err: error }, "Telegram command registration failed; bot will continue without updated commands");
    });
    this.bot.command("status", async (ctx: ChatContext) => {
      void this.queueTemp(ctx.chat!.id.toString(), ctx.message!.message_id);
      await this.handleStatus(ctx, database, pnl);
    });
    this.bot.command("close", async (ctx: ChatContext) => {
      void this.queueTemp(ctx.chat!.id.toString(), ctx.message!.message_id);
      await this.handleClose(ctx, database, executor);
    });
    this.bot.command("scan", async (ctx: ChatContext) => {
      void this.queueTemp(ctx.chat!.id.toString(), ctx.message!.message_id);
      await this.handleScan(ctx, scanner);
    });
    this.bot.command("scanv2", async (ctx: ChatContext) => {
      void this.queueTemp(ctx.chat!.id.toString(), ctx.message!.message_id);
      await this.handleScanV2(ctx, scanner);
    });
    this.bot.command("scan_pools", async (ctx: ChatContext) => {
      void this.queueTemp(ctx.chat!.id.toString(), ctx.message!.message_id);
      await this.handleScanPools(ctx, database, scanner);
    });
    this.bot.command("history", async (ctx: ChatContext) => {
      void this.queueTemp(ctx.chat!.id.toString(), ctx.message!.message_id);
      await this.handleHistoryCommand(ctx, database);
    });
    this.bot.command("calendar", async (ctx: ChatContext) => {
      void this.queueTemp(ctx.chat!.id.toString(), ctx.message!.message_id);
      await this.handleCalendarCommand(ctx, database);
    });
    this.bot.callbackQuery(/^lp:/, async (ctx) => {
      await this.handleDashboardCallback(ctx, database, pnl, executor, scanner);
    });
    this.bot.on("message:text", async (ctx) => {
      void this.queueTemp(ctx.chat!.id.toString(), ctx.message!.message_id);
      await this.handlePendingInput(ctx, database, scanner);
    });
    this.bot.on(":photo", async (ctx) => {
      void this.queueTemp(ctx.chat!.id.toString(), ctx.message!.message_id);
      await this.handlePhotoUpload(ctx, database);
    });
  }

  async positionDiscovered(position: PositionRecord): Promise<void> {
    if (!this.bot || !this.config.telegram) return;
    const t0 = await this.tokenLabel(position.token0, position.chainId);
    const t1 = await this.tokenLabel(position.token1, position.chainId);
    const liq = position.liquidity === null ? "N/A" : await this.formatLiquidity(position, position.liquidity);
    await this.sendTemp([
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

    await this.sendTemp(lines);
  }

  async logPnL(position: PositionRecord, snapshot: PnlSnapshot): Promise<void> {
    const t0 = await this.tokenLabel(position.token0, position.chainId);
    const t1 = await this.tokenLabel(position.token1, position.chainId);
    const qtSymbol = this.quoteSymbol(position.quoteToken);
    const qtDec = await this.decimals(position.quoteToken, position.chainId);
    const pair = position.quoteToken?.toLowerCase() === position.token0.toLowerCase() ? `${t1}/${t0}` : `${t0}/${t1}`;
    const chainName = this.chains.getById(position.chainId).registry.name;
    const stableToken = this.config.quoteTokens[chainName]?.[0];
    const stableDec = stableToken ? (stableToken.symbol === "USDC" || stableToken.symbol === "USDG" ? 6 : 18) : 0;
    const stableSymbol = stableToken?.symbol ?? "??";
    const feeParts: string[] = [formatToken(snapshot.feeQuote, qtDec, 2)];
    if (snapshot.feeNonQuote) {
      const nqSymbol = await this.tokenLabel(snapshot.feeNonQuote.token, position.chainId);
      const nqAmount = formatToken(snapshot.feeNonQuote.amount, await this.decimals(snapshot.feeNonQuote.token, position.chainId), 2);
      feeParts.push(`+ ${nqAmount} ${nqSymbol}`);
    }
    const feeDisplay = snapshot.feeNonQuote
      ? `${feeParts.join(" ")} (≈ ${formatToken(snapshot.feeQuoteUsdg, stableDec, 4)} ${stableSymbol})`
      : `${formatToken(snapshot.feeQuoteUsdg, stableDec, 4)} ${stableSymbol}`;
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
      : reason === "profit_oor_above"
        ? "PROFIT + OOR ABOVE"
      : reason === "out_of_range_above"
        ? "OUT OF RANGE ABOVE"
        : "manual";
    const pair = await this.pairLabel(position);
    const qtSymbol = this.quoteSymbol(position.quoteToken);
    const qtDec = await this.decimals(position.quoteToken, position.chainId);
    await this.sendTemp([
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
    await this.sendTemp([label, `V4 #${position.positionKey} ${pair}`, `tx: ${hash}`]);
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
    await this.sendTemp(lines);
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
    void message;
    lines.push("error: execution failed; inspect restricted service logs");
    await this.sendTemp(lines);
  }

  async startBot(): Promise<void> {
    if (!this.bot) return;
    if (this.database) {
      this.startDeletionWorker();
      void this.runDeletionPass().catch(() => {});
    }
    log.info("Telegram bot polling started");
    await this.bot.start();
  }

  async stopBot(): Promise<void> {
    if (!this.bot) return;
    if (this.deletionTimer !== null) clearInterval(this.deletionTimer);
    await this.bot.stop();
  }

  private startDeletionWorker(): void {
    this.deletionTimer = setInterval(() => {
      void this.runDeletionPass().catch((error) => log.warn({ error: errorMessage(error) }, "deletion worker pass failed"));
    }, 1_000);
  }

  private async runDeletionPass(): Promise<void> {
    if (!this.bot || !this.database) return;
    const items = await this.database.fetchDueDeletions();
    for (const item of items) {
      try {
        await this.bot.api.deleteMessage(item.chatId, item.messageId);
      } catch (error) {
        const msg = errorMessage(error);
        if (msg.includes("message to delete not found") || msg.includes("can't delete") || msg.includes("message can't be deleted")) {
          // Message already gone or bot lacks permission — remove from queue.
        } else {
          log.warn("could not delete queued message");
          await this.database.deferDeletion(item.id);
          continue;
        }
      }
      await this.database.removeDeletion(item.id);
    }
  }

  private async queueTemp(chatId: string, messageId: number, ttlMs = 10_000): Promise<void> {
    if (!this.database) return;
    await this.database.queueMessageDeletion(chatId, messageId, new Date(Date.now() + ttlMs));
  }

  private async dismissOpenReview(ctx: Context, chatId: string, messageId: number): Promise<void> {
    try {
      await ctx.api.deleteMessage(chatId, messageId);
    } catch (error) {
      try {
        await ctx.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } });
      } catch {
        log.warn({ error: errorMessage(error), chatId, messageId }, "could not dismiss open position review");
      }
    }
  }

  private async replyTemp(ctx: Context | ChatContext, text: string, other?: Record<string, unknown>, ttlMs?: number): Promise<void> {
    const sent = await ctx.reply(text, other as any);
    if (sent && "message_id" in sent) {
      await this.queueTemp(ctx.chat!.id.toString(), (sent as any).message_id, ttlMs);
    }
  }

  private async sendTemp(lines: string[], chatId?: string, ttlMs?: number): Promise<void> {
    if (!this.bot || !this.config.telegram) return;
    const targetId = chatId ?? this.config.telegram.chatId;
    const run = this.sendQueue.then(async () => {
      const elapsed = Date.now() - this.lastSendAt;
      if (elapsed < 300) await sleep(300 - elapsed);
      this.lastSendAt = Date.now();
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const sent = await this.bot!.api.sendMessage(targetId, lines.join("\n"));
          await this.queueTemp(targetId, sent.message_id, ttlMs);
          return;
        } catch (error: unknown) {
          const code = (error as { error_code?: number })?.error_code;
          if (code === 429 && attempt < 3) {
            const retryAfter = Number((error as { parameters?: { retry_after?: number } })?.parameters?.retry_after ?? 5);
            log.warn({ retryAfter, attempt }, "Telegram rate-limited — retrying");
            await sleep(retryAfter * 1000);
            continue;
          }
          log.warn("could not send Telegram notification");
          return;
        }
      }
    });
    this.sendQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async handleStatus(ctx: ChatContext, database: Database, pnl: PnlService): Promise<void> {
    const chatId = ctx.chat.id.toString();
    if (!this.authorized(chatId, ctx.from?.id.toString())) return;

    const dashboard = await this.buildDashboard(database, pnl, 0);
    this.lastStatusCache.set(chatId, dashboard.positions);

    const sent = await ctx.reply(dashboard.text, { reply_markup: this.dashboardKeyboard(dashboard.page, dashboard.pageCount) });
    await database.setDashboardMessageId(chatId, sent.message_id);
  }

  private async handleDashboardCallback(ctx: Context, database: Database, pnl: PnlService, executor: Executor, scanner: PoolScanner): Promise<void> {
    const callback = ctx.callbackQuery;
    const message = callback?.message;
    if (!callback || !message || !("chat" in message)) {
      await this.acknowledgeDashboardCallback(ctx, "Dashboard tidak lagi tersedia.", true);
      return;
    }
    const chatId = message.chat.id.toString();
    if (!this.authorized(chatId, ctx.from?.id.toString())) {
      await this.acknowledgeDashboardCallback(ctx, "Tidak diizinkan.", true);
      return;
    }
    const action = parseDashboardAction(callback.data);
    if (!action) {
      await this.acknowledgeDashboardCallback(ctx, "Tombol dashboard tidak valid.", true);
      return;
    }

    if (!await this.acknowledgeDashboardCallback(ctx, action.type === "refresh" ? "Memperbarui..." : undefined)) return;
    try {
      if (action.type === "refresh" || action.type === "status") {
        await this.refreshDashboardMessage(database, pnl, chatId, message.message_id, action.page);
        return;
      }
      if (action.type === "close") {
        await this.showCloseMenu(database, chatId, message.message_id, action.page);
        return;
      }
      if (action.type === "scan") {
        this.pendingInput.set(chatId, { kind: "scan_token", chain: "robinhood" });
        await this.replyTemp(ctx, "Kirim address token Robinhood untuk di-scan, atau gunakan /scan base <address>.", { reply_markup: { force_reply: true, input_field_placeholder: "0x..." } as any });
        return;
      }
      if (action.type === "scan_pools") {
        await this.handleScanPools(ctx as ChatContext, database, scanner);
        return;
      }
      if (action.type === "config") {
        await this.showPoolScanConfig(database, chatId, message.message_id);
        return;
      }
      if (action.type === "config_reset") {
        await database.clearPoolScanSettings(chatId);
        await this.showPoolScanConfig(database, chatId, message.message_id, "Config dikembalikan ke default ENV.");
        return;
      }
      if (action.type === "config_edit") {
        this.pendingInput.set(chatId, { kind: "config", key: action.key, dashboardMessageId: message.message_id });
        await this.replyTemp(ctx, configInputPrompt(action.key), { reply_markup: { force_reply: true } as any });
        return;
      }
      if (action.type === "config_quote") {
        const settings = await this.poolScanSettings(database, chatId);
        const allowedQuotes = settings.allowedQuotes.includes(action.quote)
          ? settings.allowedQuotes.filter((quote) => quote !== action.quote)
          : [...settings.allowedQuotes, action.quote];
        if (allowedQuotes.length === 0) {
          await this.replyTemp(ctx, "Minimal satu quote token harus aktif.");
          return;
        }
        await database.setPoolScanSettings(chatId, { ...settings, allowedQuotes });
        await this.showPoolScanConfig(database, chatId, message.message_id);
        return;
      }
      if (action.type === "risk") {
        await this.showRiskConfig(chatId, message.message_id, action.page);
        return;
      }
      if (action.type === "risk_reset") {
        await database.clearGlobalRiskSettings();
        this.applyRiskSettings(this.riskDefaults);
        await this.showRiskConfig(chatId, message.message_id, action.page, "Risk settings dikembalikan ke default ENV.");
        return;
      }
      if (action.type === "risk_edit") {
        this.pendingInput.set(chatId, { kind: "risk", key: action.key, dashboardMessageId: message.message_id });
        await this.replyTemp(ctx, riskInputPrompt(action.key), { reply_markup: { force_reply: true } as any });
        return;
      }
      if (action.type === "history") {
        await this.showHistory(ctx, database, chatId, action.page);
        return;
      }
      if (action.type === "history_page") {
        await this.queueTemp(chatId, message.message_id, HISTORY_IDLE_TTL_MS);
        await this.showHistory(ctx, database, chatId, action.page);
        return;
      }
      if (action.type === "calendar") {
        await this.showPnlCalendar(ctx, database, action.year, action.month);
        return;
      }
      if (action.type === "calendar_page") {
        await this.queueTemp(chatId, message.message_id, CALENDAR_IDLE_TTL_MS);
        await this.showPnlCalendar(ctx, database, action.year, action.month);
        return;
      }
      if (action.type === "pnl_card") {
        await this.showPnlCardSelection(ctx, database, chatId, action.page);
        return;
      }
      if (action.type === "pnl_card_select") {
        await this.sendPnlCard(ctx, database, chatId, action.historyIndex);
        return;
      }
      if (action.type === "bg_upload") {
        this.pendingBgUpload.add(chatId);
        await this.replyTemp(ctx, "Kirim gambar untuk background PnL card (JPEG/PNG, max 5 MB).", { reply_markup: { force_reply: true } as any });
        return;
      }
      if (action.type === "bg_reset") {
        await database.clearPnlCardBackground(chatId);
        await this.replyTemp(ctx, "✅ Background PnL card dikembalikan ke default.");
        return;
      }
      if (action.type === "open") {
        this.pendingInput.set(chatId, { kind: "open_pool", chain: "robinhood", dashboardMessageId: message.message_id });
        await this.replyTemp(ctx, "🟢 Open Position\nKirim pool address (V3 contract) atau V4 pool ID.", { reply_markup: { force_reply: true, input_field_placeholder: "0x..." } as any });
        return;
      }
      if (action.type === "open_confirm") {
        const preview = this.openConfirmations.get(action.requestId);
        if (!preview) {
          await this.dismissOpenReview(ctx, chatId, message.message_id);
          await this.replyTemp(ctx, "❌ Konfirmasi open position sudah kadaluarsa. Ulangi dari awal.");
          return;
        }
        this.openConfirmations.delete(action.requestId);
        await this.dismissOpenReview(ctx, chatId, message.message_id);
        await this.replyTemp(ctx, "⏳ Membuka posisi...");
        try {
          if (!this.positionOpener) throw new Error("Position opener is not configured");
          const result = await this.positionOpener.executeOpen(preview);
          const hashLabel = result.hash ? `\ntx: ${result.hash.slice(0, 18)}...` : "";
          await this.replyTemp(ctx, `🟢 LP OPENED\n${preview.protocol.toUpperCase()} ${preview.pair} | ${preview.feeLabel}\nRange: ${preview.lowerPrice} → ${preview.upperPrice}\nDeposit: ${(Number(preview.depositAmount) / 10 ** (preview.quoteTokenSymbol === "USDG" ? 6 : 18)).toFixed(2)} ${preview.quoteTokenSymbol}${hashLabel}`);
        } catch (error) {
          await this.replyTemp(ctx, `❌ Open position gagal: ${errorMessage(error).slice(0, 200)}`);
        }
        return;
      }
      if (action.type === "open_cancel") {
        await this.dismissOpenReview(ctx, chatId, message.message_id);
        await this.replyTemp(ctx, "❌ Open position dibatalkan.");
        return;
      }
      if (action.type !== "select" && action.type !== "confirm") {
        await this.refreshDashboardMessage(database, pnl, chatId, message.message_id, action.page);
        return;
      }
      const position = await this.findDashboardPosition(database, action);
      if (!position || !canRequestManualClose(position.status)) {
        await this.showCloseMenu(database, chatId, message.message_id, action.page, "Posisi sudah tidak dapat ditutup dari dashboard.");
        return;
      }
      if (action.type === "select") {
        await this.showCloseConfirmation(chatId, message.message_id, position, action.page);
        return;
      }
      if (this.dashboardCloseInFlight.has(position.id)) {
        await this.refreshDashboardMessage(database, pnl, chatId, message.message_id, action.page, "⏳ Close untuk posisi ini sedang diproses.");
        return;
      }

      this.dashboardCloseInFlight.add(position.id);
      void this.executeDashboardClose(database, pnl, executor, chatId, message.message_id, position, action.page)
        .catch((closeError) => log.error({ error: errorMessage(closeError), positionId: position.id }, "dashboard close flow failed"));
      await this.refreshDashboardMessage(database, pnl, chatId, message.message_id, action.page, `⏳ Menutup ${position.protocol.toUpperCase()} #${position.positionKey}...`);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "dashboard callback failed");
      try {
        await this.editDashboardMessage(chatId, message.message_id, "❌ Dashboard gagal diperbarui. Tekan Refresh untuk mencoba lagi.", this.dashboardKeyboard(0, 1));
      } catch (editError) {
        log.warn({ error: errorMessage(editError) }, "could not render dashboard error state");
      }
    }
  }

  private async acknowledgeDashboardCallback(ctx: Context, text?: string, showAlert = false): Promise<boolean> {
    try {
      if (text) await ctx.answerCallbackQuery({ text, show_alert: showAlert });
      else await ctx.answerCallbackQuery();
      return true;
    } catch (error) {
      const details = errorMessage(error);
      if (isExpiredCallbackError(error)) {
        log.info({ updateId: ctx.update.update_id }, "ignoring expired Telegram callback");
      } else {
        log.warn({ updateId: ctx.update.update_id, error: details }, "could not acknowledge Telegram callback");
      }
      return false;
    }
  }

  private async executeDashboardClose(database: Database, pnl: PnlService, executor: Executor, chatId: string, messageId: number, position: PositionRecord, page: number): Promise<void> {
    try {
      await executor.execute(position, "manual");
      await this.refreshDashboardMessage(database, pnl, chatId, messageId, page);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      try {
        await this.refreshDashboardMessage(database, pnl, chatId, messageId, page, `❌ Close #${position.positionKey} gagal: ${text.slice(0, 400)}`);
      } catch (editError) {
        log.warn({ error: errorMessage(editError), positionId: position.id }, "could not render dashboard close failure");
      }
    } finally {
      this.dashboardCloseInFlight.delete(position.id);
    }
  }

  private async buildDashboard(database: Database, pnl: PnlService, requestedPage: number, notice?: string): Promise<DashboardView> {
    const { active } = await this.activePositions(database, false);
    const pageCount = Math.max(1, Math.ceil(active.length / DASHBOARD_PAGE_SIZE));
    const page = clampDashboardPage(requestedPage, pageCount);
    const first = page * DASHBOARD_PAGE_SIZE;
    const lines = ["LP DASHBOARD", ...(notice ? [notice] : []), `Updated: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`, ""];

    if (active.length === 0) {
      lines.push("Tidak ada posisi aktif.");
    } else {
      const pagePositions = active.slice(first, first + DASHBOARD_PAGE_SIZE);
      const positionIds = pagePositions.map((p) => p.id);
      const [snapshotMap, observationMap] = await Promise.all([
        database.getLatestSnapshots(positionIds),
        database.getLatestObservations(positionIds),
      ]);
      const statusLines = await Promise.all(pagePositions.map((position, index) =>
        this.formatStatusLineFromSnapshot(position, snapshotMap.get(position.id), observationMap.get(position.id), pnl, first + index + 1),
      ));
      lines.push(...statusLines.map((line) => line.trimEnd()));
    }

    lines.push("");
    lines.push(`SL: ${this.config.stopLossPercent}% | TP: +${this.config.takeProfitPercent}% | Trail: +${this.config.trailingStopActivationPercent}% / -${this.config.trailingStopDrawdownPercent}%`);
    if (pageCount > 1) lines.push(`Page ${page + 1}/${pageCount} | ${active.length} posisi aktif`);
    return { text: lines.join("\n"), positions: active, page, pageCount };
  }

  private async activePositions(database: Database, includeBlocks: boolean): Promise<{ active: PositionRecord[]; blocks: Record<number, bigint> }> {
    const blocks: Record<number, bigint> = {};
    const results = await Promise.all(this.config.chains.map(async (chain) => {
      const { client, registry } = this.chains.get(chain);
      const [positions, block] = await Promise.all([
        database.listActivePositions(registry.chain.id),
        includeBlocks ? client.getBlockNumber() : Promise.resolve(undefined),
      ]);
      return { chainId: registry.chain.id, positions, block };
    }));
    for (const result of results) {
      if (result.block !== undefined) blocks[result.chainId] = result.block;
    }
    const positions = results.flatMap((result) => result.positions);
    return { active: positions.filter((position) => position.status !== "paused"), blocks };
  }

  private dashboardKeyboard(page: number, pageCount: number): InlineKeyboard {
    const keyboard = new InlineKeyboard()
      .text("🔄 Refresh", dashboardAction("refresh", page))
      .text("✖️ Close position", dashboardAction("close", page));
    keyboard.row()
      .text("🔍 Scan token", dashboardAction("scan", page))
      .text("🏆 Scan pools", dashboardAction("scan_pools", page));
    keyboard.row()
      .text("🟢 Open position", dashboardAction("open", page));
    keyboard.row()
      .text("📚 History ±0.5%", dashboardAction("history", 0))
      .text("🖼 PnL card", dashboardAction("pnl_card", 0));
    const now = new Date();
    keyboard.row().text("📅 PnL Calendar", calendarAction(now.getUTCFullYear(), now.getUTCMonth() + 1));
    keyboard.row()
      .text("🖼 Background card", dashboardAction("bg_upload", 0))
      .text("⬛ Reset BG", dashboardAction("bg_reset", 0));
    keyboard.row()
      .text("⚙️ Risk settings", dashboardAction("risk", page))
      .text("⚙️ Pool scan config", dashboardAction("config", page));
    if (pageCount > 1) {
      keyboard.row();
      if (page > 0) keyboard.text("← Prev", dashboardAction("status", page - 1));
      if (page < pageCount - 1) keyboard.text("Next →", dashboardAction("status", page + 1));
    }
    return keyboard;
  }

  private async refreshDashboardMessage(database: Database, pnl: PnlService, chatId: string, messageId: number, page: number, notice?: string): Promise<void> {
    const dashboard = await this.buildDashboard(database, pnl, page, notice);
    this.lastStatusCache.set(chatId, dashboard.positions);
    await this.editDashboardMessage(chatId, messageId, dashboard.text, this.dashboardKeyboard(dashboard.page, dashboard.pageCount));
  }

  private async showCloseMenu(database: Database, chatId: string, messageId: number, requestedPage: number, notice?: string): Promise<void> {
    const { active } = await this.activePositions(database, false);
    const closable = active.filter((position) => canRequestManualClose(position.status) && !this.dashboardCloseInFlight.has(position.id));
    const pageCount = Math.max(1, Math.ceil(closable.length / DASHBOARD_PAGE_SIZE));
    const page = clampDashboardPage(requestedPage, pageCount);
    const first = page * DASHBOARD_PAGE_SIZE;
    const keyboard = new InlineKeyboard();
    const lines = ["✖️ SELECT POSITION TO CLOSE", "Pilih posisi, lalu konfirmasi sebelum transaksi dimulai."];
    if (notice) lines.push(`\n${notice}`);

    if (closable.length === 0) {
      lines.push("\nTidak ada posisi yang dapat ditutup.");
    } else {
      for (const position of closable.slice(first, first + DASHBOARD_PAGE_SIZE)) {
        keyboard.text(await this.closeButtonLabel(position), dashboardPositionAction("select", page, position)).row();
      }
      if (pageCount > 1) {
        if (page > 0) keyboard.text("← Prev", dashboardAction("close", page - 1));
        if (page < pageCount - 1) keyboard.text("Next →", dashboardAction("close", page + 1));
        keyboard.row();
      }
    }
    keyboard.text("← Back", dashboardAction("status", page));
    await this.editDashboardMessage(chatId, messageId, lines.join("\n"), keyboard);
  }

  private async showCloseConfirmation(chatId: string, messageId: number, position: PositionRecord, page: number): Promise<void> {
    const pair = await this.pairLabel(position);
    const keyboard = new InlineKeyboard()
      .text("✅ Confirm close", dashboardPositionAction("confirm", page, position))
      .text("Cancel", dashboardAction("close", page));
    await this.editDashboardMessage(chatId, messageId, [
      "⚠️ CONFIRM CLOSE",
      `${position.protocol.toUpperCase()} #${position.positionKey} ${pair}`,
      "Aksi ini menghapus liquidity dan memulai settlement ke quote token.",
    ].join("\n"), keyboard);
  }

  private async closeButtonLabel(position: PositionRecord): Promise<string> {
    const label = `${position.protocol.toUpperCase()} #${position.positionKey} ${await this.pairLabel(position)}`;
    return label.length <= 64 ? label : `${label.slice(0, 61)}...`;
  }

  private async findDashboardPosition(database: Database, action: Extract<DashboardAction, { type: "select" | "confirm" }>): Promise<PositionRecord | null> {
    if (!this.config.chains.some((chain) => this.chains.get(chain).registry.chain.id === action.chainId)) return null;
    return database.findPositionByKey(action.chainId, action.protocol, action.positionKey);
  }

  private async editDashboardMessage(chatId: string, messageId: number, text: string, replyMarkup?: InlineKeyboard): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.editMessageText(chatId, messageId, text, replyMarkup ? { reply_markup: replyMarkup } : { reply_markup: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("message is not modified")) return;
      throw error;
    }
  }

  private async formatStatusLineFromSnapshot(
    position: PositionRecord,
    snapshot: { pnlBps: bigint; liquidationQuote: bigint; realizedQuote: bigint; depositsQuote: bigint; feeQuoteUsdg: bigint; blockNumber: bigint; createdAt: Date } | undefined,
    observation: { liquidity: bigint; token0Amount: bigint; token1Amount: bigint; blockNumber: bigint; rangeStatus: string | null; rangeTickLower: number | null; rangeTickUpper: number | null; rangeCurrentTick: number | null; rangeSqrtPrice: bigint | null } | undefined,
    pnl: PnlService,
    index: number,
  ): Promise<string> {
    const t0 = await this.tokenLabel(position.token0, position.chainId);
    const t1 = await this.tokenLabel(position.token1, position.chainId);
    const pair = position.quoteToken?.toLowerCase() === position.token0.toLowerCase() ? `${t1}/${t0}` : `${t0}/${t1}`;
    const reviewReason = position.status === "needs_review"
      ? ` | ${reviewReasonDisplay(position.metadata)}`
      : "";
    const autoExitDisabled = position.metadata.autoExitDisabled === true ? " | ⚠️ AUTO EXIT DISABLED" : "";
    const operationalStatus = position.status === "armed" ? "" : ` | ${statusDisplay(position.status)}`;
    const base = `${index}. ${position.protocol.toUpperCase()} #${position.positionKey} ${pair}${operationalStatus}${reviewReason}${autoExitDisabled}`;

    if (!snapshot || !position.quoteToken) {
      if (!position.quoteToken) return `${base}\n`;
      const blockNumber = observation?.blockNumber;
      if (!blockNumber) return `${base} | ⏳ LOADING\n`;
      return this.formatStatusLine(position, pnl, blockNumber, index);
    }

    const qtSymbol = this.quoteSymbol(position.quoteToken);
    const qtDec = await this.decimals(position.quoteToken, position.chainId);
    const cv = formatToken(snapshot.liquidationQuote, qtDec, 2);
    const pnlText = `${pnlEmoji(snapshot.pnlBps)} ${formatBps(snapshot.pnlBps)}%`;
    const trailingPeak = trailingPeakDisplay(position.metadata);
    const feeUsdg = snapshot.feeQuoteUsdg ?? 0n;
    const valueLine = `   💰 ${cv} ${qtSymbol} ${pnlText} | 🪙 ≈$${formatToken(feeUsdg, 6, 2)}${trailingPeak}`;

    const rangeInfo = observation?.rangeStatus && observation.rangeTickLower !== null && observation.rangeTickUpper !== null && observation.rangeCurrentTick !== null && observation.rangeSqrtPrice !== null
      ? {
          status: observation.rangeStatus as PositionRangeInfo["status"],
          tickLower: observation.rangeTickLower,
          tickUpper: observation.rangeTickUpper,
          currentTick: observation.rangeCurrentTick,
          currentSqrtPrice: observation.rangeSqrtPrice,
        } as PositionRangeInfo
      : undefined;
    const bins = await this.formatPositionBins(position, rangeInfo);
    return `${base}\n${valueLine}${bins}\n`;
  }

  private async formatStatusLine(position: PositionRecord, pnl: PnlService, blockNumber: bigint | undefined, index: number): Promise<string> {
    const t0 = await this.tokenLabel(position.token0, position.chainId);
    const t1 = await this.tokenLabel(position.token1, position.chainId);
    const pair = position.quoteToken?.toLowerCase() === position.token0.toLowerCase() ? `${t1}/${t0}` : `${t0}/${t1}`;
    const reviewReason = position.status === "needs_review"
      ? ` | ${reviewReasonDisplay(position.metadata)}`
      : "";
    const autoExitDisabled = position.metadata.autoExitDisabled === true ? " | ⚠️ AUTO EXIT DISABLED" : "";
    const operationalStatus = position.status === "armed" ? "" : ` | ${statusDisplay(position.status)}`;
    const base = `${index}. ${position.protocol.toUpperCase()} #${position.positionKey} ${pair}${operationalStatus}${reviewReason}${autoExitDisabled}`;

    if (!position.quoteToken || !blockNumber) return `${base}\n`;
    try {
      const valued = await pnl.value(position, blockNumber);
      const qtSymbol = this.quoteSymbol(position.quoteToken);
      const qtDec = await this.decimals(position.quoteToken, position.chainId);
      const cv = formatToken(valued.snapshot.liquidationQuote, qtDec, 2);
      const pnlText = `${pnlEmoji(valued.snapshot.pnlBps)} ${formatBps(valued.snapshot.pnlBps)}%`;
      const trailingPeak = trailingPeakDisplay(position.metadata);
      const valueLine = `   💰 ${cv} ${qtSymbol} ${pnlText} | 🪙 ≈$${formatToken(valued.snapshot.feeQuoteUsdg, 6, 2)}${trailingPeak}`;
      const bins = await this.formatPositionBins(position, valued.range);
      return `${base}\n${valueLine}${bins}\n`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = message.includes("zero liquidity")
        ? "⚠️ SETTLEMENT RECOVERY PENDING"
        : "⚠️ VALUATION UNAVAILABLE";
      return `${base} | ${detail}\n`;
    }
  }

  private async formatPositionBins(position: PositionRecord, range: import("../types.js").PositionRangeInfo | undefined): Promise<string> {
    if (position.protocol === "v2") return "\n   ████████████████████████████  FULL RANGE";
    if (!range || !position.quoteToken) return "";

    const quoteIsToken0 = position.quoteToken.toLowerCase() === position.token0.toLowerCase();
    const [token0Decimals, token1Decimals] = await Promise.all([
      this.decimals(position.token0, position.chainId),
      this.decimals(position.token1, position.chainId),
    ]);
    const lower = quotePriceScaled(sqrtRatioAtTick(range.tickLower), quoteIsToken0, token0Decimals, token1Decimals);
    const upper = quotePriceScaled(sqrtRatioAtTick(range.tickUpper), quoteIsToken0, token0Decimals, token1Decimals);
    const minimum = lower < upper ? lower : upper;
    const maximum = lower > upper ? lower : upper;
    const quoteSymbol = this.quoteSymbol(position.quoteToken);
    const current = quotePriceScaled(range.currentSqrtPrice, quoteIsToken0, token0Decimals, token1Decimals);
    const bins = positionRangeBins(minimum, maximum, current);
    const prices = formatRangePrices(minimum, current, maximum, quoteSymbol);
    const scaleSuffix = prices.scale ? ` ${prices.scale}` : "";
    const rangeStatus = formatDashboardRangeStatus(quoteRangeState(range, quoteIsToken0)?.status, position.metadata);
    return `\n   ${prices.low} ${bins.bar} ${prices.high}${scaleSuffix}\n   ${bins.marker} ${prices.cur}${rangeStatus}`;
  }

  private lastScanAt = 0;

  private async handleScan(ctx: ChatContext, scanner: PoolScanner): Promise<void> {
    const chatId = ctx.chat.id.toString();
    if (!this.authorized(chatId, ctx.from?.id.toString())) return;

    const parsed = parseScanInput(ctx.match.trim());
    if (!parsed) {
      await this.replyTemp(ctx, "Gunakan /scan <token-address> atau /scan base|robinhood <token-address>.");
      return;
    }

    await this.runTokenScan(ctx, scanner, parsed.token, parsed.chain);
  }

  private async handleScanV2(ctx: ChatContext, scanner: PoolScanner): Promise<void> {
    const chatId = ctx.chat.id.toString();
    if (!this.authorized(chatId, ctx.from?.id.toString())) return;
    if (!this.config.scanV2Enabled) {
      await this.replyTemp(ctx, "Scanv2 sementara dimatikan.");
      return;
    }
    const parsed = parseScanV2Input(ctx.match.trim());
    if (!parsed) {
      await this.replyTemp(ctx, "Gunakan /scanv2 <token>, /scanv2 base <token>, atau tambahkan range 5-90%.");
      return;
    }
    if (this.scanV2Running) {
      await this.replyTemp(ctx, "🔬 Scanv2 masih berjalan. Tunggu hasil sebelumnya.");
      return;
    }
    this.scanV2Running = true;
    await this.replyTemp(ctx, `🔬 Menghitung concentrated yield ${parsed.range}% untuk ${shortAddress(parsed.token)} di ${parsed.chain}...`, undefined, 180_000);
    void this.executeScanV2(scanner, parsed.token, parsed.chain, parsed.range, chatId).catch((error) => log.error({ error: errorMessage(error), token: parsed.token, chain: parsed.chain }, "scanv2 background job failed"));
  }

  private async executeScanV2(scanner: PoolScanner, token: Address, chain: ChainName, range: number, chatId: string): Promise<void> {
    try {
      const scan = await scanner.scanV2(token, chain, range, (completed, total) => {
        if (completed < total) void this.sendTemp([`🔬 Menganalisis concentrated pool ${completed + 1}/${total}...`], chatId, 30_000);
      });
      if (scan.active.length === 0 && scan.watchlist.length === 0) {
        await this.sendTemp(["Tidak ditemukan pool aktif yang bisa dihitung concentrated yield-nya."], chatId, 180_000);
        return;
      }
      const lines = [`🔬 SCAN V2: ${shortAddress(token)}`, `Chain: ${chain === "base" ? "Base (8453)" : "Robinhood (4663)"}`, `Requested range: -${range}%`, ""];
      for (let i = 0; i < scan.active.length; i++) lines.push(...formatScanV2Pool(scan.active[i]!, `${i + 1}.`));
      if (scan.watchlist.length > 0) {
        lines.push("", "⚠️ WATCHLIST");
        for (const pool of scan.watchlist) lines.push(...formatScanV2Pool(pool, "•"));
      }
      lines.push("", "Estimasi gross marginal LP berdasarkan current liquidity map + OHLCV historis. Bukan jaminan return.");
      await this.sendTemp([lines.join("\n")], chatId, 180_000);
    } catch {
      await this.sendTemp(["Scanv2 gagal. Coba lagi nanti."], chatId, 180_000);
    } finally {
      this.scanV2Running = false;
    }
  }

  private async runTokenScan(ctx: Context, scanner: PoolScanner, token: Address, chain: ChainName): Promise<void> {
    const chatId = ctx.chat!.id.toString();
    if (this.tokenScanRunning) {
      await this.replyTemp(ctx, "🔍 Scan token masih berjalan. Tunggu hasil sebelumnya.");
      return;
    }
    const elapsed = Date.now() - this.lastScanAt;
    if (elapsed < 15_000) {
      await this.replyTemp(ctx, `Tunggu ${Math.ceil((15_000 - elapsed) / 1_000)} detik sebelum scan berikutnya.`);
      return;
    }
    this.lastScanAt = Date.now();
    this.tokenScanRunning = true;

    try {
      await this.replyTemp(ctx, `🔍 Mencari pool Uniswap V3/V4 untuk ${shortAddress(token)} di ${chain}...`, undefined, 120_000);
    } catch (error) {
      this.tokenScanRunning = false;
      throw error;
    }
    void this.executeTokenScan(scanner, token, chain, chatId).catch((error) => log.error({ error: errorMessage(error), token, chain }, "token scan background job failed"));
  }

  private async executeTokenScan(scanner: PoolScanner, token: Address, chain: ChainName, chatId: string): Promise<void> {
    try {
      const scan = await scanner.scan(token, chain);
      if (scan.active.length === 0 && scan.watchlist.length === 0) {
        await this.sendTemp(["Tidak ditemukan pool Uniswap V3/V4 dengan TVL > $0 dan Vol 6h >= $100 untuk token ini."], chatId, 120_000);
        return;
      }

      const lines: string[] = [
        `🔍 SCAN: ${shortAddress(token)}`,
        `Chain: ${chain === "base" ? "Base (8453)" : "Robinhood (4663)"}`,
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
      lines.push("", "Yield 1h: (vol1h × feeRate / TVL). Score memakai Vol 6h dan safety factor.");
      await this.sendTemp([lines.join("\n")], chatId, 120_000);
    } catch (error) {
        await this.sendTemp(["Scan gagal. Coba lagi nanti."], chatId, 120_000);
    } finally {
      this.tokenScanRunning = false;
    }
  }

  private async handleScanPools(ctx: Context, database: Database, scanner: PoolScanner): Promise<void> {
    const chatId = ctx.chat?.id.toString();
    if (!chatId || !this.authorized(chatId, ctx.from?.id.toString())) return;
    if (this.poolScanRunning) {
      await this.replyTemp(ctx, "🏆 Scan pools masih berjalan. Tunggu hasil sebelumnya.");
      return;
    }
    this.poolScanRunning = true;
    const progress = await ctx.reply("🏆 Memeriksa kandidat Uniswap V3/V4 Robinhood berdasarkan yield 1h. Scan dapat memerlukan sekitar 2 menit...");
    const messageId = progress.message_id;
    void this.queueTemp(ctx.chat!.id.toString(), messageId, 120_000);
    void this.executePoolScan(database, scanner, chatId, messageId).catch((scanError) => log.error({ error: errorMessage(scanError) }, "pool scan background job failed"));
  }

  private async executePoolScan(database: Database, scanner: PoolScanner, chatId: string, messageId: number): Promise<void> {
    let stage = "Memuat kandidat cache...";
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      void this.refreshPoolScanProgress(chatId, messageId, `${stage}\nElapsed: ${Math.floor((Date.now() - startedAt) / 1_000)}s`);
    }, 20_000);
    try {
      const filters = await this.poolScanFilters(database, chatId);
      const scan = await scanner.scanPools(filters, (nextStage) => { stage = nextStage; });
      const text = formatPoolMarketScan(scan, filters);
      if (!this.bot) return;
      try {
        await this.bot.api.editMessageText(chatId, messageId, text);
      } catch (editError) {
        const details = errorMessage(editError);
        if (!details.includes("message is not modified")) {
          await this.sendTemp([text], chatId, 300_000);
          return;
        }
      }
      await this.queueTemp(chatId, messageId, 300_000);
    } catch (error) {
      const text = "Scan pools gagal. Coba lagi nanti.";
      if (this.bot) {
        try {
          await this.bot.api.editMessageText(chatId, messageId, text);
          await this.queueTemp(chatId, messageId, 300_000);
        } catch {
          await this.sendTemp([text], chatId, 300_000);
        }
      }
    } finally {
      clearInterval(heartbeat);
      this.poolScanRunning = false;
    }
  }

  private async refreshPoolScanProgress(chatId: string, messageId: number, stage: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.editMessageText(chatId, messageId, `🏆 SCAN POOLS BERJALAN\n${stage}`);
      await this.queueTemp(chatId, messageId, 120_000);
    } catch {
      // Final result is sent as a new message if this progress message disappears.
    }
  }

  private async handlePendingInput(ctx: Context, database: Database, scanner: PoolScanner): Promise<void> {
    const chatId = ctx.chat?.id.toString();
    if (!chatId || !this.authorized(chatId, ctx.from?.id.toString())) return;
    const pending = this.pendingInput.get(chatId);
    const text = ctx.message?.text?.trim();
    if (!pending || !text || text.startsWith("/")) return;
    this.pendingInput.delete(chatId);
    if (pending.kind === "scan_token") {
      const parsed = parseScanInput(text);
      if (!parsed) {
        await this.replyTemp(ctx, "Gunakan address token atau format: base <token-address>.");
        return;
      }
      await this.runTokenScan(ctx, scanner, parsed.token, parsed.chain);
      return;
    }
    try {
      if (pending.kind === "open_pool") {
        const poolAddress = parseOpenPoolInput(text);
        if (!poolAddress) {
          await this.replyTemp(ctx, "Address atau link pool Uniswap Robinhood tidak valid.");
          return;
        }
        this.pendingInput.set(chatId, { kind: "open_range", chain: pending.chain, poolAddress, dashboardMessageId: pending.dashboardMessageId });
        await this.replyTemp(ctx, "Kirim range drop % (contoh: -60 untuk 60% di bawah harga sekarang).", { reply_markup: { force_reply: true } as any });
        return;
      }
      if (pending.kind === "open_range") {
        const dropPercent = Number(text.replace(/[%\s,]/g, ""));
        if (!Number.isFinite(dropPercent) || dropPercent <= 0 || dropPercent >= 100) {
          this.pendingInput.set(chatId, pending);
          await this.replyTemp(ctx, "Range tidak valid. Kirim angka 1-99, contoh: -60.");
          return;
        }
        if (!this.positionOpener) throw new Error("Position opener is not configured");
        const quoteToken = await this.positionOpener.detectQuoteToken(pending.poolAddress, pending.chain);
        this.pendingInput.set(chatId, { kind: "open_amount", chain: pending.chain, poolAddress: pending.poolAddress, dropPercent, quoteToken, dashboardMessageId: pending.dashboardMessageId });
        const example = quoteToken.symbol === "USDG" || quoteToken.symbol === "USDC" ? "200" : "0.01";
        await this.replyTemp(ctx, `Kirim jumlah deposit dalam ${quoteToken.symbol} (contoh: ${example}).`, { reply_markup: { force_reply: true } as any });
        return;
      }
      if (pending.kind === "open_amount") {
        const amount = text.replace(/[$,\s]/g, "");
        if (!/^\d+(?:\.\d+)?$/.test(amount) || Number(amount) <= 0) {
          this.pendingInput.set(chatId, pending);
          await this.replyTemp(ctx, "Jumlah tidak valid. Kirim angka positif.");
          return;
        }
        await this.handleOpenPreview(ctx, pending.chain, pending.poolAddress, pending.dropPercent, amount, pending.quoteToken);
        return;
      }
      if (pending.kind === "risk") {
        const next = { ...this.riskSettings(), ...parseRiskSettingInput(pending.key, text) };
        await database.setGlobalRiskSettings(next);
        this.applyRiskSettings(next);
        await this.replyTemp(ctx, "✅ Risk settings diperbarui.");
        await this.showRiskConfig(chatId, pending.dashboardMessageId, 0);
        return;
      }
      const settings = await this.poolScanSettings(database, chatId);
      const next = { ...settings, ...parsePoolScanInput(pending.key, text) };
      await database.setPoolScanSettings(chatId, next);
      await this.replyTemp(ctx, "✅ Pool scan config diperbarui.");
      await this.showPoolScanConfig(database, chatId, pending.dashboardMessageId);
    } catch (error) {
      if (pending.kind === "risk") {
        this.pendingInput.set(chatId, pending);
        await this.replyTemp(ctx, "Risk settings tidak valid. Kirim nilai lagi atau pilih tombol lain.");
      } else {
        await this.replyTemp(ctx, "Config tidak valid.");
      }
    }
  }

  private async handleOpenPreview(ctx: Context, chain: ChainName, poolAddress: string, dropPercent: number, amount: string, quoteToken: QuoteToken): Promise<void> {
    if (!this.positionOpener) {
      await this.replyTemp(ctx, "❌ Position opener belum dikonfigurasi.");
      return;
    }
    const chatId = ctx.chat!.id.toString();

    let preview: OpenPositionPreview;
    try {
      const decimals = await this.positionOpener.quoteTokenDecimals(chain, quoteToken.address);
      preview = await this.positionOpener.prepareOpen(poolAddress, chain, dropPercent, parseUnits(amount, decimals), quoteToken);
    } catch (error) {
      await this.replyTemp(ctx, `❌ Gagal membaca pool: ${errorMessage(error).slice(0, 200)}`);
      return;
    }

    const requestId = `${chatId}-${Date.now()}`;
    this.openConfirmations.set(requestId, preview);

    const depositFormatted = amount;
    const lines = [
      "🟢 OPEN POSITION — REVIEW",
      "",
      `${preview.protocol.toUpperCase()} ${preview.pair} | ${preview.feeLabel}`,
      `Current price: ${preview.currentPrice}`,
      `Range: ${preview.lowerPrice} → ${preview.upperPrice}`,
      `Ticks: ${preview.tickLower} → ${preview.tickUpper} | current ${preview.currentTick}`,
      `Drop: -${dropPercent}%`,
      `Deposit: ${depositFormatted} ${preview.quoteTokenSymbol}`,
      `Quote side: single-side ${preview.quoteTokenSymbol}`,
      "",
      `${this.config.dryRun ? "⚠️ DRY_RUN — simulasi tanpa broadcast" : "Konfirmasi untuk eksekusi."}`,
    ];

    const keyboard = new InlineKeyboard()
      .text("✅ Confirm", `lp:open_confirm:${requestId}`)
      .text("❌ Cancel", `lp:open_cancel:0`);
    await this.replyTemp(ctx, lines.join("\n"), { reply_markup: keyboard as any }, 120_000);
  }

  private async poolScanSettings(database: Database, chatId: string): Promise<PoolScanSettings> {
    return { ...this.config.poolScanDefaults, ...(await database.getPoolScanSettings(chatId)) };
  }

  private riskSettings(): RiskSettings {
    return {
      stopLossPercent: this.config.stopLossPercent,
      takeProfitPercent: this.config.takeProfitPercent,
      trailingStopActivationPercent: this.config.trailingStopActivationPercent,
      trailingStopDrawdownPercent: this.config.trailingStopDrawdownPercent,
    };
  }

  private applyRiskSettings(settings: RiskSettings): void {
    this.config.stopLossPercent = settings.stopLossPercent;
    this.config.takeProfitPercent = settings.takeProfitPercent;
    this.config.trailingStopActivationPercent = settings.trailingStopActivationPercent;
    this.config.trailingStopDrawdownPercent = settings.trailingStopDrawdownPercent;
  }

  private async showRiskConfig(chatId: string, messageId: number, page: number, notice?: string): Promise<void> {
    const settings = this.riskSettings();
    const keyboard = new InlineKeyboard()
      .text("SL", "lp:riskcfg:stop_loss")
      .text("TP", "lp:riskcfg:take_profit")
      .row()
      .text("Trailing activation", "lp:riskcfg:trailing_activation")
      .text("Trailing drawdown", "lp:riskcfg:trailing_drawdown")
      .row()
      .text("Reset ENV", dashboardAction("risk_reset", page))
      .text("← Back", dashboardAction("status", page));
    const lines = [
      "⚙️ GLOBAL RISK SETTINGS",
      `Stop loss: ${settings.stopLossPercent}%`,
      `Take profit: +${settings.takeProfitPercent}%`,
      `Trailing activation: +${settings.trailingStopActivationPercent}%`,
      `Trailing drawdown: -${settings.trailingStopDrawdownPercent}%`,
      "",
      "Berlaku untuk semua posisi pada siklus monitor berikutnya.",
    ];
    if (notice) lines.push("", notice);
    await this.editDashboardMessage(chatId, messageId, lines.join("\n"), keyboard);
  }

  private async poolScanFilters(database: Database, chatId: string): Promise<PoolScanFilters> {
    const settings = await this.poolScanSettings(database, chatId);
    const allowedQuoteAddresses = settings.allowedQuotes.map((symbol) => {
      const quote = this.config.quoteTokens.robinhood.find((entry) => entry.symbol === symbol);
      if (!quote) throw new Error(`Quote token ${symbol} tidak ada di QUOTE_TOKEN_ALLOWLIST_ROBINHOOD`);
      return quote.address;
    });
    return { ...settings, allowedQuoteAddresses, candidatePages: this.config.poolScanCandidatePages };
  }

  private async showPoolScanConfig(database: Database, chatId: string, messageId: number, notice?: string): Promise<void> {
    const settings = await this.poolScanSettings(database, chatId);
    const keyboard = new InlineKeyboard()
      .text("Min MC", "lp:cfg:market_cap")
      .text("Min pool TVL", "lp:cfg:pool_tvl")
      .row()
      .text("Min total TVL", "lp:cfg:total_tvl")
      .row()
      .text("Min usia", "lp:cfg:age")
      .text("Min yield/h", "lp:cfg:yield")
      .row()
      .text("Top N", "lp:cfg:max_results")
      .row();
    for (const quote of ["USDG", "WETH", "ETH"]) {
      keyboard.text(`${settings.allowedQuotes.includes(quote) ? "✅" : "⬜"} ${quote}`, `lp:cfgquote:${quote}`);
    }
    keyboard.row().text("Reset ENV", "lp:cfgreset:0").text("← Back", dashboardAction("status", 0));
    const lines = [
      "⚙️ POOL SCAN CONFIG",
      `Min market cap: $${fmtUsd(settings.minMarketCapUsd)}`,
      `Min TVL per pool: $${fmtUsd(settings.minPoolTvlUsd)}`,
      `Min total active TVL V3/V4: $${fmtUsd(settings.minTotalActiveTvlUsd)}`,
      `Min usia pool tertua: ${fmtDuration(settings.minPoolAgeSeconds)}`,
      `Min gross yield/h: ${fmtPercent(settings.minYieldHourlyPercent)}`,
      `Top results: ${settings.maxResults}`,
      `Quote: ${settings.allowedQuotes.join(", ")}`,
    ];
    if (notice) lines.push("", notice);
    await this.editDashboardMessage(chatId, messageId, lines.join("\n"), keyboard);
  }

  private async replyLong(ctx: Context, text: string): Promise<void> {
    const chatId = ctx.chat!.id.toString();
    let message = "";
    for (const line of text.split("\n")) {
      if (message.length + line.length + 1 > 3_800) {
        await this.replyTemp(ctx, message);
        message = "";
      }
      message += `${message ? "\n" : ""}${line}`;
    }
    if (message) await this.replyTemp(ctx, message);
  }

  private async handlePhotoUpload(ctx: Context, database: Database): Promise<void> {
    const chatId = ctx.chat?.id.toString();
    if (!chatId || !this.authorized(chatId, ctx.from?.id.toString())) return;
    if (!this.pendingBgUpload.has(chatId)) return;
    this.pendingBgUpload.delete(chatId);
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) {
      await this.replyTemp(ctx, "Tidak ada gambar terdeteksi.");
      return;
    }
    const largest = photos[photos.length - 1]!;
    try {
      const file = await ctx.api.getFile(largest.file_id);
      if (!file.file_path) {
        await this.replyTemp(ctx, "Gagal membaca file gambar.");
        return;
      }
      if (file.file_size && file.file_size > 5_000_000) {
        await this.replyTemp(ctx, "Ukuran gambar terlalu besar (max 5 MB).");
        return;
      }
      const url = `https://api.telegram.org/file/bot${this.config.telegram!.token}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const normalized = await sharp(buffer)
        .rotate()
        .resize(1440, 900, { fit: "cover" })
        .png()
        .toBuffer();
      await database.setPnlCardBackground(chatId, normalized);
      await this.replyTemp(ctx, "✅ Background PnL card tersimpan.");
    } catch (error) {
      await this.replyTemp(ctx, "Gagal menyimpan background.");
    }
  }

  private async handleHistoryCommand(ctx: ChatContext, database: Database): Promise<void> {
    const chatId = ctx.chat.id.toString();
    if (!this.authorized(chatId, ctx.from?.id.toString())) return;
    await this.showHistory(ctx, database, chatId, 0);
  }

  private async handleCalendarCommand(ctx: ChatContext, database: Database): Promise<void> {
    const chatId = ctx.chat.id.toString();
    if (!this.authorized(chatId, ctx.from?.id.toString())) return;
    const now = new Date();
    await this.showPnlCalendar(ctx, database, now.getUTCFullYear(), now.getUTCMonth() + 1);
  }

  private async showPnlCalendar(ctx: Context, database: Database, year: number, month: number): Promise<void> {
    const calendar = await database.getPnlCalendarMonth(year, month);
    const png = await renderPnlCalendarCard(calendar);
    const previous = new Date(Date.UTC(year, month - 2, 1));
    const next = new Date(Date.UTC(year, month, 1));
    const now = new Date();
    const keyboard = new InlineKeyboard()
      .text("← Previous", calendarPageAction(previous.getUTCFullYear(), previous.getUTCMonth() + 1))
      .text("This Month", calendarPageAction(now.getUTCFullYear(), now.getUTCMonth() + 1))
      .text("Next →", calendarPageAction(next.getUTCFullYear(), next.getUTCMonth() + 1));
    const sent = await ctx.replyWithPhoto(new InputFile(png, `unilp-calendar-${year}-${String(month).padStart(2, "0")}.png`), {
      caption: `${monthLabel(year, month)} · realized settlements only · UTC`,
      reply_markup: keyboard,
    });
    await this.queueTemp(ctx.chat!.id.toString(), sent.message_id, CALENDAR_IDLE_TTL_MS);
  }

  private async showHistory(ctx: Context, database: Database, chatId: string, page: number): Promise<void> {
    const total = await database.countCloseHistory();
    if (total === 0) {
      await this.replyTemp(ctx, "Tidak ada riwayat posisi close.");
      return;
    }
    const pageCount = Math.max(1, Math.ceil(total / DASHBOARD_PAGE_SIZE));
    const p = clampDashboardPage(page, pageCount);
    const history = await database.listCloseHistoryPage(DASHBOARD_PAGE_SIZE, p * DASHBOARD_PAGE_SIZE);
    const lines = ["📚 RIWAYAT CLOSE", ""];
    for (const item of history) {
      const pair = item.quoteToken.toLowerCase() === item.token0.toLowerCase()
        ? `${await this.tokenLabel(item.token1, item.chainId)}/${await this.tokenLabel(item.token0, item.chainId)}`
        : `${await this.tokenLabel(item.token0, item.chainId)}/${await this.tokenLabel(item.token1, item.chainId)}`;
      const isProfit = item.finalPnlBps >= 0n;
      const prefix = isProfit ? "📈" : "📉";
      const sign = isProfit ? "+" : "";
      lines.push(`${prefix} ${item.protocol.toUpperCase()} #${item.positionKey} ${pair}`);
      const qtDec = await this.decimals(item.quoteToken, item.chainId);
      const qtSymbol = this.quoteSymbol(item.quoteToken);
      const ethDec = (qtSymbol === "ETH" || qtSymbol === "WETH") ? 4 : undefined;
      const usdPart = item.finalPnlUsd !== 0n ? ` | ${sign}$${formatToken(item.finalPnlUsd, 6, 2)}` : "";
       lines.push(`   ${sign}${formatBps(item.finalPnlBps)}% | ${sign}${formatToken(item.finalPnlQuote, qtDec, ethDec)} ${qtSymbol}${usdPart} | ${triggerDisplayShort(item.trigger)}`);
       if (item.swapTransactionHash) lines.push(`   Swap: ${shortHash(item.swapTransactionHash)}`);
       lines.push(`   Settled: ${fmtUtc(item.settledAt)} UTC`);
      lines.push("");
    }
    if (pageCount > 1) lines.push(`Page ${p + 1}/${pageCount} | ${total} riwayat`);
    const keyboard = new InlineKeyboard();
    const hasPager = p > 0 || p < pageCount - 1;
    if (p > 0) keyboard.text("← Prev", historyPageAction(p - 1));
    if (p < pageCount - 1) keyboard.text("Next →", historyPageAction(p + 1));
    await this.replyTemp(ctx, lines.join("\n"), hasPager ? { reply_markup: keyboard } : undefined, HISTORY_IDLE_TTL_MS);
  }

  private async showPnlCardSelection(ctx: Context, database: Database, chatId: string, page: number): Promise<void> {
    const history = await database.listCloseHistory(50);
    if (history.length === 0) {
      await this.replyTemp(ctx, "Tidak ada riwayat posisi close yang lolos ±0.5% untuk dijadikan PnL card.");
      return;
    }
    const pageCount = Math.max(1, Math.ceil(history.length / DASHBOARD_PAGE_SIZE));
    const p = clampDashboardPage(page, pageCount);
    const start = p * DASHBOARD_PAGE_SIZE;
    const pageItems = history.slice(start, start + DASHBOARD_PAGE_SIZE);
    const keyboard = new InlineKeyboard();
    const lines = ["🖼 PILIH POSISI UNTUK PNL CARD", ""];
    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i]!;
      const pair = item.quoteToken.toLowerCase() === item.token0.toLowerCase()
        ? `${await this.tokenLabel(item.token1, item.chainId)}/${await this.tokenLabel(item.token0, item.chainId)}`
        : `${await this.tokenLabel(item.token0, item.chainId)}/${await this.tokenLabel(item.token1, item.chainId)}`;
      const isProfit = item.finalPnlBps >= 0n;
      const sign = isProfit ? "+" : "";
      keyboard.text(`${isProfit ? "📈" : "📉"} ${item.protocol.toUpperCase()} ${pair}`, `lp:pnl_cs:${p}:${start + i}`).row();
      lines.push(`${isProfit ? "📈" : "📉"} ${item.protocol.toUpperCase()} #${item.positionKey} ${pair} | ${sign}${formatBps(item.finalPnlBps)}%`);
    }
    keyboard.text("← Back", dashboardAction("status", 0));
    await this.replyTemp(ctx, lines.join("\n"), { reply_markup: keyboard as any });
  }

  private async sendPnlCard(ctx: Context, database: Database, chatId: string, historyIndex: number): Promise<void> {
    const history = await database.listCloseHistory(50);
    const record = history[historyIndex];
    if (!record) {
      await this.replyTemp(ctx, "Riwayat tidak ditemukan.");
      return;
    }
    const pair = record.quoteToken.toLowerCase() === record.token0.toLowerCase()
      ? `${await this.tokenLabel(record.token1, record.chainId)}/${await this.tokenLabel(record.token0, record.chainId)}`
      : `${await this.tokenLabel(record.token0, record.chainId)}/${await this.tokenLabel(record.token1, record.chainId)}`;
    const qtDec = await this.decimals(record.quoteToken, record.chainId);
    const qtSymbol = this.quoteSymbol(record.quoteToken);
    const bg = await database.getPnlCardBackground(chatId);
    let durationStr: string | undefined;
    if (record.openedAtBlock) {
      try {
        const { client } = this.chains.getById(record.chainId);
        const block = await client.getBlock({ blockNumber: record.openedAtBlock });
        const opened = Number(block.timestamp) * 1000;
        const settled = record.settledAt.getTime();
        const diffMs = settled - opened;
        if (diffMs > 0) {
          const totalMin = Math.floor(diffMs / 60_000);
          const days = Math.floor(totalMin / 1440);
          const hours = Math.floor((totalMin % 1440) / 60);
          const mins = totalMin % 60;
          const parts: string[] = [];
          if (days > 0) parts.push(`${days}D`);
          if (hours > 0 || days > 0) parts.push(`${hours}H`);
          parts.push(`${mins}M`);
          durationStr = `DURATION ${parts.join(" ")}`;
        }
      } catch { /* skip duration if block lookup fails */ }
    }
    const detail = await database.getPnlCardDetail(record.positionId);
    const png = await renderPnlCard(record, pair, qtDec, qtSymbol, detail, bg, durationStr);
    const sent = await ctx.replyWithPhoto(new InputFile(png, "pnl-card.png"));
    if (sent && "message_id" in sent) {
      await this.queueTemp(chatId, (sent as any).message_id, 120_000);
    }
  }

  private async handleClose(ctx: ChatContext, database: Database, executor: Executor): Promise<void> {
    const chatId = ctx.chat.id.toString();
    if (!this.authorized(chatId, ctx.from?.id.toString())) return;

    const key = ctx.match.trim();
    if (!key) { await this.replyTemp(ctx, "Gunakan /close <nomor> atau /close <key>. Jalankan /status dulu."); return; }

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
      await this.replyTemp(ctx, `Posisi "${key}" tidak ditemukan. Jalankan /status dulu, lalu gunakan nomor (contoh: /close 1) atau position key (contoh: /close 33850).`);
      return;
    }
    if (found.status === "closing" || found.status === "settled") {
      await this.replyTemp(ctx, `Posisi ${found.positionKey} sudah ${found.status === "closing" ? "sedang ditutup" : "settled"}.`);
      return;
    }
    if (found.status === "needs_review") {
      await this.replyTemp(ctx, `Posisi ${found.positionKey} manual-only: ${reviewReasonDisplay(found.metadata)}.`);
      return;
    }

    await this.replyTemp(ctx, `Menutup ${found.protocol.toUpperCase()} #${found.positionKey}...`);
    try {
      await executor.execute(found, "manual");
      await this.replyTemp(ctx, `Posisi ${found.positionKey} — penutupan dimulai.`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      void message;
      await this.replyTemp(ctx, "Close gagal. Periksa restricted service logs.");
    }
  }

  private authorized(chatId: string, userId: string | undefined): boolean {
    return Boolean(this.config.telegram
      && chatId === this.config.telegram.chatId
      && userId === this.config.telegram.userId);
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
          log.warn({ error: errorMessage(error) }, "could not send Telegram notification");
          return;
        }
      }
    });
    this.sendQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function dashboardAction(type: "refresh" | "close" | "status" | "scan" | "scan_pools" | "config" | "config_reset" | "risk" | "risk_reset" | "history" | "pnl_card" | "bg_upload" | "bg_reset" | "open", page: number): string {
  return `lp:${type}:${page}`;
}

function calendarAction(year: number, month: number): string {
  return `lp:calendar:${year}-${String(month).padStart(2, "0")}`;
}

function calendarPageAction(year: number, month: number): string {
  return `lp:calnav:${year}-${String(month).padStart(2, "0")}`;
}

function historyPageAction(page: number): string {
  return `lp:histpg:${page}`;
}

function dashboardPositionAction(type: "select" | "confirm", page: number, position: PositionRecord): string {
  return `lp:${type}:${page}:${position.chainId}:${position.protocol}:${position.positionKey}`;
}

export function parseDashboardAction(data: string | undefined): DashboardAction | null {
  if (!data) return null;
  const parts = data.split(":");
  if (parts.length === 3 && parts[0] === "lp" && parts[1] === "calendar") {
    const match = /^(\d{4})-(\d{2})$/.exec(parts[2] ?? "");
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return year >= 2020 && year <= 2100 && month >= 1 && month <= 12 ? { type: "calendar", year, month } : null;
  }
  if (parts.length === 3 && parts[0] === "lp" && parts[1] === "calnav") {
    const match = /^(\d{4})-(\d{2})$/.exec(parts[2] ?? "");
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return year >= 2020 && year <= 2100 && month >= 1 && month <= 12 ? { type: "calendar_page", year, month } : null;
  }
  if (parts.length === 3 && parts[0] === "lp" && parts[1] === "histpg") {
    const page = parseDashboardPage(parts[2]);
    return page === null ? null : { type: "history_page", page };
  }
  if (parts.length === 3 && parts[0] === "lp" && isDashboardAction(parts[1])) {
    const page = parseDashboardPage(parts[2]);
    return page === null ? null : { type: parts[1], page };
  }
  if (parts.length === 6 && parts[0] === "lp" && isPositionAction(parts[1])) {
    const page = parseDashboardPage(parts[2]);
    const chainId = Number(parts[3]);
    const protocol = parts[4];
    const positionKey = parts[5];
    if (page === null || !Number.isSafeInteger(chainId) || chainId <= 0 || !isProtocol(protocol) || !positionKey) return null;
    return { type: parts[1], page, chainId, protocol, positionKey };
  }
  if (parts.length === 3 && parts[0] === "lp" && parts[1] === "cfg" && isPoolSettingKey(parts[2])) {
    return { type: "config_edit", key: parts[2] };
  }
  if (parts.length === 3 && parts[0] === "lp" && parts[1] === "riskcfg" && isRiskSettingKey(parts[2])) {
    return { type: "risk_edit", key: parts[2] };
  }
  if (parts.length === 3 && parts[0] === "lp" && parts[1] === "cfgquote" && ["USDG", "WETH", "ETH"].includes(parts[2] ?? "")) {
    return { type: "config_quote", quote: parts[2]! };
  }
  if (parts.length === 4 && parts[0] === "lp" && parts[1] === "pnl_cs") {
    const page = parseDashboardPage(parts[2]);
    const historyIndex = Number(parts[3]);
    if (page === null || !Number.isSafeInteger(historyIndex) || historyIndex < 0) return null;
    return { type: "pnl_card_select", page, historyIndex };
  }
  if (parts.length === 3 && parts[0] === "lp" && parts[1] === "open_confirm") {
    return { type: "open_confirm", requestId: parts[2]! };
  }
  if (parts.length === 3 && parts[0] === "lp" && parts[1] === "open_cancel") {
    return { type: "open_cancel", page: parseDashboardPage(parts[2]) ?? 0 };
  }
  return null;
}

export function clampDashboardPage(page: number, pageCount: number): number {
  return Math.max(0, Math.min(page, Math.max(1, pageCount) - 1));
}

export function canRequestManualClose(status: PositionStatus): boolean {
  return status !== "closing" && status !== "settled" && status !== "needs_review";
}

function parseDashboardPage(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : null;
}

function isDashboardAction(value: string | undefined): value is "refresh" | "close" | "status" | "scan" | "scan_pools" | "config" | "config_reset" | "risk" | "risk_reset" | "history" | "pnl_card" | "bg_upload" | "bg_reset" | "open" {
  return value === "refresh" || value === "close" || value === "status" || value === "scan" || value === "scan_pools" || value === "config" || value === "config_reset" || value === "risk" || value === "risk_reset" || value === "history" || value === "pnl_card" || value === "bg_upload" || value === "bg_reset" || value === "open";
}

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1))).toUpperCase();
}

function isPositionAction(value: string | undefined): value is "select" | "confirm" {
  return value === "select" || value === "confirm";
}

function isProtocol(value: string | undefined): value is Protocol {
  return value === "v2" || value === "v3" || value === "v4";
}

function isPoolSettingKey(value: string | undefined): value is PoolSettingKey {
  return value === "market_cap" || value === "pool_tvl" || value === "total_tvl" || value === "age" || value === "yield" || value === "max_results";
}

function isRiskSettingKey(value: string | undefined): value is RiskSettingKey {
  return value === "stop_loss" || value === "take_profit" || value === "trailing_activation" || value === "trailing_drawdown";
}

export function isExpiredCallbackError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("query is too old") || message.includes("response timeout expired") || message.includes("query id is invalid");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
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
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(Math.min(decimals, 18));
  const integer = absolute / divisor;
  const fraction = absolute % divisor;
  if (fraction === 0n) return `${negative ? "-" : ""}${integer}`;
  let fracStr = fraction.toString().padStart(Math.min(decimals, 18), "0").replace(/0+$/, "");
  if (maxDecimals !== undefined && fracStr.length > maxDecimals) {
    fracStr = fracStr.slice(0, maxDecimals);
  }
  return `${negative ? "-" : ""}${integer}.${fracStr}`;
}

function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}

export function parseScanInput(raw: string): { chain: ChainName; token: Address } | null {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const chain = parts.length === 2 ? parts[0]?.toLowerCase() : "robinhood";
  const token = parts.length === 2 ? parts[1] : parts[0];
  if ((chain !== "base" && chain !== "robinhood") || !token || !isAddress(token, { strict: false })) return null;
  return { chain, token: token as Address };
}

export function parseOpenPoolInput(raw: string): string | null {
  const value = raw.trim();
  if (isAddress(value, { strict: false })) return value.toLowerCase();
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "app.uniswap.org") return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "explore" || parts[1] !== "pools" || parts[2] !== "robinhood") return null;
  const identifier = parts[3]!;
  if (isAddress(identifier, { strict: false }) || /^0x[0-9a-fA-F]{64}$/.test(identifier)) return identifier.toLowerCase();
  return null;
}

export function parseScanV2Input(raw: string): { chain: ChainName; token: Address; range: number } | null {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const hasChain = parts.length >= 2 && (parts[0] === "base" || parts[0] === "robinhood");
  const chain = (hasChain ? parts.shift() : "robinhood") as ChainName;
  const token = parts.shift();
  const range = parts.length === 0 ? 35 : Number(parts.shift()?.replace("%", ""));
  if (parts.length > 0 || !token || !isAddress(token, { strict: false }) || !Number.isFinite(range) || range < 5 || range > 90) return null;
  return { chain, token: token as Address, range };
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

const QUOTE_PRICE_SCALE = 10n ** 18n;
const Q192 = 1n << 192n;

function quotePriceScaled(sqrtPriceX96: bigint, quoteIsToken0: boolean, token0Decimals: number, token1Decimals: number): bigint {
  const square = sqrtPriceX96 * sqrtPriceX96;
  if (quoteIsToken0) {
    return (Q192 * 10n ** BigInt(token1Decimals) * QUOTE_PRICE_SCALE) / (square * 10n ** BigInt(token0Decimals));
  }
  return (square * 10n ** BigInt(token0Decimals) * QUOTE_PRICE_SCALE) / (Q192 * 10n ** BigInt(token1Decimals));
}

const POSITION_BIN_COUNT = 10;

export function positionRangeBins(minimum: bigint, maximum: bigint, current: bigint): { bar: string; marker: "◀" | "🟨" | "▶"; markerIndex: number } {
  if (maximum <= minimum) {
    return { bar: "🟨" + "🟦".repeat(POSITION_BIN_COUNT - 1), marker: "🟨", markerIndex: 0 };
  }

  const marker = current < minimum ? "◀" : current > maximum ? "▶" : "🟨";
  const markerIndex = current <= minimum
    ? 0
    : current >= maximum
      ? POSITION_BIN_COUNT - 1
      : Number(((current - minimum) * BigInt(POSITION_BIN_COUNT - 1)) / (maximum - minimum));
  const bar = Array.from({ length: POSITION_BIN_COUNT }, (_, index) => index === markerIndex ? "🟨" : index < markerIndex ? "🟩" : "🟦").join("");
  return { bar, marker, markerIndex };
}

const SUPERSCRIPT_MAP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻",
};

function toSuperscript(value: number): string {
  return String(value).split("").map((c) => SUPERSCRIPT_MAP[c] ?? c).join("");
}

export function formatRangePrices(
  minimum: bigint,
  current: bigint,
  maximum: bigint,
  quoteSymbol: string,
): { scale: string; low: string; cur: string; high: string } {
  const prefix = quoteSymbol === "USDG" || quoteSymbol === "USDC" ? "$" : "";
  const SMALL_THRESHOLD = 10n ** 15n;

  if (minimum >= SMALL_THRESHOLD || minimum === 0n) {
    return {
      scale: "",
      low: `${prefix}${formatToken(minimum, 18, 3)}`,
      cur: `${prefix}${formatToken(current, 18, 3)}`,
      high: `${prefix}${formatToken(maximum, 18, 3)}`,
    };
  }

  const minDigits = minimum.toString().length;
  const divisorExp = Math.max(0, minDigits - 3);
  const divisor = 10n ** BigInt(divisorExp);
  const halfDivisor = divisor / 2n;
  const exponent = divisorExp - 18;

  return {
    scale: `×10${toSuperscript(exponent)}`,
    low: ((minimum + halfDivisor) / divisor).toString(),
    cur: ((current + halfDivisor) / divisor).toString(),
    high: ((maximum + halfDivisor) / divisor).toString(),
  };
}

export function formatDashboardRangeStatus(
  status: import("../types.js").PositionRangeInfo["status"] | undefined,
  metadata: Record<string, unknown>,
  now = Date.now(),
): string {
  if (status === "below") return " | ⚠️ OOR BELOW";
  if (status !== "above") return "";
  const seenAt = typeof metadata.oorAboveSeenAt === "number" ? metadata.oorAboveSeenAt : undefined;
  const elapsedMinutes = seenAt === undefined ? null : Math.max(0, Math.floor((now - seenAt) / 60_000));
  return ` | ⚠️ OOR ABOVE${elapsedMinutes === null ? "" : ` ⏳${elapsedMinutes}m`}`;
}

function triggerDisplayShort(trigger: string): string {
  switch (trigger) {
    case "stop_loss": return "SL";
    case "take_profit": return "TP";
    case "trailing_take_profit": return "Trail";
    case "profit_oor_above": return "P+OOR";
    case "out_of_range_above": return "OOR";
    case "manual": return "Manual";
    default: return trigger;
  }
}

function scoreStars(score: number): string {
  if (score >= 0.06) return "★★★★★";
  if (score >= 0.03) return "★★★★☆";
  if (score >= 0.006) return "★★★☆☆";
  if (score >= 0.0006) return "★★☆☆☆";
  if (score > 0) return "★☆☆☆☆";
  return "☆☆☆☆☆";
}

function parsePoolScanInput(key: PoolSettingKey, value: string): Partial<PoolScanSettings> {
  if (key === "age") {
    const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([mhd])$/);
    if (!match?.[1] || !match[2]) throw new Error("usia harus seperti 30m, 1h, atau 2d");
    const amount = Number(match[1]);
    const multiplier = match[2] === "m" ? 60 : match[2] === "h" ? 3_600 : 86_400;
    if (!Number.isFinite(amount) || amount < 0) throw new Error("usia harus angka positif");
    return { minPoolAgeSeconds: Math.floor(amount * multiplier) };
  }
  const number = Number(value.replace(/[$,%\s,]/g, ""));
  if (!Number.isFinite(number) || number < 0) throw new Error("nilai harus angka positif");
  if (key === "market_cap") return { minMarketCapUsd: number };
  if (key === "pool_tvl") return { minPoolTvlUsd: number };
  if (key === "total_tvl") return { minTotalActiveTvlUsd: number };
  if (key === "yield") return { minYieldHourlyPercent: number };
  if (!Number.isInteger(number) || number < 1 || number > 20) throw new Error("Top N harus integer 1 sampai 20");
  return { maxResults: number };
}

function configInputPrompt(key: PoolSettingKey): string {
  if (key === "market_cap") return "Kirim Min market cap, contoh: 500000 atau $500K.";
  if (key === "pool_tvl") return "Kirim Min TVL per pool, contoh: 10000.";
  if (key === "total_tvl") return "Kirim Min total active TVL V3/V4, contoh: 70000.";
  if (key === "age") return "Kirim Min usia pool tertua, contoh: 30m, 1h, atau 2d.";
  if (key === "yield") return "Kirim Min gross yield per jam, contoh: 1 atau 1%.";
  return "Kirim jumlah hasil top, dari 1 sampai 20.";
}

export function parseRiskSettingInput(key: RiskSettingKey, value: string): Partial<RiskSettings> {
  const number = Number(value.trim().replace(/[%\s,]/g, ""));
  if (!Number.isFinite(number)) throw new Error("nilai harus angka");
  if (key === "stop_loss") {
    if (number >= 0 || number < -100) throw new Error("SL harus antara -100 dan kurang dari 0");
    return { stopLossPercent: number };
  }
  if (number <= 0 || number > 1_000) throw new Error("nilai harus lebih dari 0 dan maksimal 1000");
  if (key === "take_profit") return { takeProfitPercent: number };
  if (key === "trailing_activation") return { trailingStopActivationPercent: number };
  return { trailingStopDrawdownPercent: number };
}

function riskInputPrompt(key: RiskSettingKey): string {
  if (key === "stop_loss") return "Kirim Stop Loss dalam persen negatif, contoh: -24.";
  if (key === "take_profit") return "Kirim Take Profit dalam persen positif, contoh: 20.";
  if (key === "trailing_activation") return "Kirim Trailing activation dalam persen positif, contoh: 5.";
  return "Kirim Trailing drawdown dalam persen positif, contoh: 1.5.";
}

function formatPoolMarketScan(scan: PoolMarketScan, filters: PoolScanFilters): string {
  const lines = [
    "🏆 TOP POOL YIELD 1H",
    "Chain: Robinhood (4663) | Uniswap V3/V4",
    `Kandidat cache: ${scan.candidateTokens} | Dievaluasi DexScreener: ${scan.evaluatedTokens} | Lolos filter + on-chain: ${scan.qualifiedTokens}`,
    `Filter: MC > $${fmtUsd(filters.minMarketCapUsd)} | Pool TVL > $${fmtUsd(filters.minPoolTvlUsd)} | Total TVL aktif > $${fmtUsd(filters.minTotalActiveTvlUsd)} | Usia > ${fmtDuration(filters.minPoolAgeSeconds)} | Yield/h > ${fmtPercent(filters.minYieldHourlyPercent)}`,
    `Quote: ${filters.allowedQuotes.join(", ")}`,
    "",
  ];
  if (scan.warming) {
    lines.push("Discovery cache sedang dipanaskan di background. Coba lagi dalam sekitar 1 menit.");
    return lines.join("\n");
  }
  if (scan.pools.length === 0) {
    lines.push("Tidak ada kandidat yang lolos semua filter.");
    return lines.join("\n");
  }
  for (let index = 0; index < scan.pools.length; index++) {
    const pool = scan.pools[index]!;
    const effectiveFee = pool.currentLpFee ?? pool.feeTier;
    lines.push(`${index + 1}. ${pool.protocol.toUpperCase()} ${pool.pair} | ${(effectiveFee / 10_000).toFixed(2)}%${pool.dynamicFee ? " dynamic" : ""}`);
    lines.push(`   Yield/h: ${fmtPercent(pool.estimatedPoolYield1hPercent)} | Vol 1h: $${fmtUsd(pool.volume1hUsd)} | Est. fees 1h: $${fmtUsd(pool.estimatedPoolFees1hUsd)}`);
    const valuationLabel = pool.tokenValuationSource === "fdv" ? "FDV fallback" : "MC";
    lines.push(`   ${valuationLabel}: $${fmtUsd(pool.tokenMarketCapUsd ?? 0)} | Total active TVL V3/V4: $${fmtUsd(pool.tokenTotalActiveTvlUsd ?? 0)} | Usia: ${fmtDuration(pool.tokenOldestPoolAgeSeconds ?? 0)}`);
    lines.push(`   Pool TVL: $${fmtUsd(pool.tvlUsd)} | Uniswap: ${pool.uniswapUrl}`);
  }
  lines.push("", "Yield adalah estimasi gross pool, bukan hasil personal LP.");
  return lines.join("\n");
}

function formatScanPool(pool: ScoredPool, label: string): string[] {
  const effectiveFee = pool.currentLpFee ?? pool.feeTier;
  const feePct = (effectiveFee / 10_000).toFixed(2);
  const dynamicLabel = pool.dynamicFee ? " (dynamic)" : "";
  const lines = [
    `${label} ${scoreStars(pool.score)} ${pool.protocol.toUpperCase()} ${pool.pair} | ${feePct}%${dynamicLabel}`,
    `   TVL: $${fmtUsd(pool.tvlUsd)} | Vol 1h: $${fmtUsd(pool.volume1hUsd)} | Gross yield/h (1h): ${fmtPercent(pool.estimatedPoolYield1hPercent)}`,
    `   Vol 6h: $${fmtUsd(pool.volume6hUsd)} | Est. gross fees 6h: $${fmtUsd(pool.estimatedPoolFees6hUsd)} | Yield/h 6h avg: ${fmtPercent(pool.estimatedPoolYieldHourlyPercent)}`,
    `   Score: ${pool.score.toFixed(6)} | Uniswap: ${pool.uniswapUrl}`,
  ];
  if (pool.warnings.length > 0) lines.push(`   ⚠️ ${pool.warnings.join(", ")}`);
  return lines;
}

function formatScanV2Pool(pool: ScoredPool, label: string): string[] {
  const estimate = pool.concentrated;
  if (!estimate) return [`${label} ${pool.protocol.toUpperCase()} ${pool.pair} | concentrated estimate unavailable`];
  const effectiveFee = pool.currentLpFee ?? pool.feeTier;
  const lines = [
    `${label} ${pool.protocol.toUpperCase()} ${pool.pair} | ${(effectiveFee / 10_000).toFixed(2)}%${pool.dynamicFee ? " dynamic" : ""}`,
    `   Range: -${estimate.actualDownsidePercent.toFixed(2)}% → +${estimate.actualUpsidePercent.toFixed(2)}% | Capital ref: $${fmtUsd(estimate.rangeCapitalUsd)}`,
    `   Yield/h: 1h ${fmtPercent(estimate.yieldHourlyPercent.h1)} | 6h ${fmtPercent(estimate.yieldHourlyPercent.h6)} | 24h ${fmtPercent(estimate.yieldHourlyPercent.h24)}`,
    `   Volume in range: 1h ${fmtPercent(estimate.volumeInRangePercent.h1)} | 6h ${fmtPercent(estimate.volumeInRangePercent.h6)} | 24h ${fmtPercent(estimate.volumeInRangePercent.h24)}`,
    `   TVL: $${fmtUsd(pool.tvlUsd)} | Uniswap: ${pool.uniswapUrl}`,
  ];
  if (estimate.warnings.length > 0) lines.push(`   ⚠️ ${estimate.warnings.join(", ")}`);
  return lines;
}

function fmtUsd(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toExponential(2);
}

function fmtPercent(value: number): string {
  if (value >= 1) return `${value.toFixed(2)}%`;
  if (value >= 0.01) return `${value.toFixed(3)}%`;
  return `${value.toFixed(4)}%`;
}

function fmtDuration(seconds: number): string {
  if (seconds >= 86_400) return `${(seconds / 86_400).toFixed(seconds % 86_400 === 0 ? 0 : 1)}d`;
  if (seconds >= 3_600) return `${(seconds / 3_600).toFixed(seconds % 3_600 === 0 ? 0 : 1)}h`;
  return `${Math.floor(seconds / 60)}m`;
}
