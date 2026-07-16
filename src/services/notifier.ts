import { Bot, Context, InlineKeyboard, InputFile, type CommandContext } from "grammy";
import { isAddress, zeroAddress, type Address } from "viem";
import sharp from "sharp";

import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type { CloseHistoryRecord, ExitTrigger, PnlSnapshot, PoolScanSettings, PositionRecord, PositionStatus, Protocol } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import type { Executor } from "./executor.js";
import type { PnlService } from "./pnl.js";
import { fmtUtc, renderPnlCard } from "./pnl-card.js";
import type { PoolMarketScan, PoolScanFilters, PoolScanner, ScoredPool } from "./pool-scanner.js";
import { sqrtRatioAtTick } from "./uniswap-math.js";

type ChatContext = CommandContext<Context>;

const DASHBOARD_PAGE_SIZE = 6;
const DASHBOARD_VALUE_CONCURRENCY = 3;

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
  | { type: "history"; page: number }
  | { type: "pnl_card"; page: number }
  | { type: "pnl_card_select"; page: number; historyIndex: number }
  | { type: "bg_upload"; page: number }
  | { type: "bg_reset"; page: number }
  | { type: "select" | "confirm"; page: number; chainId: number; protocol: Protocol; positionKey: string };

type PoolSettingKey = "market_cap" | "pool_tvl" | "total_tvl" | "age" | "yield" | "max_results";
type PendingInput = { kind: "scan_token" } | { kind: "config"; key: PoolSettingKey; dashboardMessageId: number };

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
  private poolScanRunning = false;
  private deletionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly chains: ChainClients,
    database?: Database,
  ) {
    this.database = database;
    if (!config.telegram) return;
    this.bot = new Bot(config.telegram.token);
    this.bot.catch((error) => {
      log.error({ updateId: error.ctx.update.update_id, error: errorMessage(error.error) }, "Telegram update failed");
    });
  }

  registerCommands(database: Database, pnl: PnlService, executor: Executor, scanner: PoolScanner): void {
    if (!this.bot) return;
    void this.bot.api.setMyCommands([
      { command: "status", description: "Tampilkan status semua posisi LP aktif" },
      { command: "close", description: "Tutup posisi LP — fallback /close <nomor> atau /close <key>" },
      { command: "scan", description: "Scan pool Uniswap V3/V4 untuk token — /scan <contract>" },
      { command: "scan_pools", description: "Cari pool V3/V4 dengan estimasi yield 1 jam tertinggi" },
      { command: "history", description: "Tampilkan riwayat posisi close >= ±0.5% PnL" },
    ]);
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
    this.bot.command("scan_pools", async (ctx: ChatContext) => {
      void this.queueTemp(ctx.chat!.id.toString(), ctx.message!.message_id);
      await this.handleScanPools(ctx, database, scanner);
    });
    this.bot.command("history", async (ctx: ChatContext) => {
      void this.queueTemp(ctx.chat!.id.toString(), ctx.message!.message_id);
      await this.handleHistoryCommand(ctx, database);
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
    lines.push(`error: ${message.slice(0, 500)}`);
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
          log.warn({ chatId: item.chatId, messageId: item.messageId, error: msg }, "could not delete queued message");
        }
      }
      await this.database.removeDeletion(item.id);
    }
  }

  private async queueTemp(chatId: string, messageId: number, ttlMs = 10_000): Promise<void> {
    if (!this.database) return;
    await this.database.queueMessageDeletion(chatId, messageId, new Date(Date.now() + ttlMs));
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
          log.warn({ error: errorMessage(error) }, "could not send Telegram notification");
          return;
        }
      }
    });
    this.sendQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async handleStatus(ctx: ChatContext, database: Database, pnl: PnlService): Promise<void> {
    const chatId = ctx.chat.id.toString();
    if (!this.authorized(chatId)) return;

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
    if (!this.authorized(chatId)) {
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
        this.pendingInput.set(chatId, { kind: "scan_token" });
        await this.replyTemp(ctx, "Kirim address token Robinhood untuk di-scan.", { reply_markup: { force_reply: true, input_field_placeholder: "0x..." } as any });
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
      if (action.type === "history") {
        await this.showHistory(ctx, database, chatId, action.page);
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
    const { active, blocks } = await this.activePositions(database, true);
    const pageCount = Math.max(1, Math.ceil(active.length / DASHBOARD_PAGE_SIZE));
    const page = clampDashboardPage(requestedPage, pageCount);
    const first = page * DASHBOARD_PAGE_SIZE;
    const lines = ["LP DASHBOARD", ...(notice ? [notice] : []), `Updated: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`, ""];

    if (active.length === 0) {
      lines.push("Tidak ada posisi aktif.");
    } else {
      const pagePositions = active.slice(first, first + DASHBOARD_PAGE_SIZE);
      const statusLines = await mapWithConcurrency(pagePositions, DASHBOARD_VALUE_CONCURRENCY, (position, index) =>
        this.formatStatusLine(position, pnl, blocks[position.chainId], first + index + 1),
      );
      lines.push(...statusLines.map((line) => line.trimEnd()));
    }

    lines.push("");
    lines.push(`SL: ${this.config.stopLossPercent}% (OOR Below only) | TP: +${this.config.takeProfitPercent}% | Trail: +${this.config.trailingStopActivationPercent}% / -${this.config.trailingStopDrawdownPercent}%`);
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
      .text("📚 History ±0.5%", dashboardAction("history", 0))
      .text("🖼 PnL card", dashboardAction("pnl_card", 0));
    keyboard.row()
      .text("🖼 Background card", dashboardAction("bg_upload", 0))
      .text("⬛ Reset BG", dashboardAction("bg_reset", 0));
    keyboard.row().text("⚙️ Pool scan config", dashboardAction("config", page));
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

  private async formatStatusLine(position: PositionRecord, pnl: PnlService, blockNumber: bigint | undefined, index: number): Promise<string> {
    const t0 = await this.tokenLabel(position.token0, position.chainId);
    const t1 = await this.tokenLabel(position.token1, position.chainId);
    const pair = position.quoteToken?.toLowerCase() === position.token0.toLowerCase() ? `${t1}/${t0}` : `${t0}/${t1}`;
    const statusLabel = statusDisplay(position.status);
    const reviewReason = position.status === "needs_review"
      ? ` | ${reviewReasonDisplay(position.metadata)}`
      : "";
    const autoExitDisabled = position.metadata.autoExitDisabled === true ? " | ⚠️ AUTO EXIT DISABLED" : "";
    const base = `${index}. ${statusLabel.split(" ")[0]} ${position.protocol.toUpperCase()} #${position.positionKey} ${pair}${reviewReason}${autoExitDisabled}`;

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
      const pnlText = `PnL ${formatBps(valued.snapshot.pnlBps)}%`;
      const trailingPeak = trailingPeakDisplay(position.metadata);
      const range = await this.formatPositionRange(position, valued.range);
      return `${base} | 💰 ${cv} ${qtSymbol} | 🪙 ${feeDisplay} | 📊 ${pnlText}${trailingPeak}${range}\n`;
    } catch {
      return `${base}\n`;
    }
  }

  private async formatPositionRange(position: PositionRecord, range: import("../types.js").PositionRangeInfo | undefined): Promise<string> {
    if (position.protocol === "v2") return "\n   Range: Full range (V2)";
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
    const status = quoteRangeStatus(range.status, quoteIsToken0, position.metadata);
    return `\n   ${status} | ${formatQuotePrice(minimum, quoteSymbol)} - ${formatQuotePrice(maximum, quoteSymbol)} ${quoteSymbol}`;
  }

  private lastScanAt = 0;

  private async handleScan(ctx: ChatContext, scanner: PoolScanner): Promise<void> {
    const chatId = ctx.chat.id.toString();
    if (!this.authorized(chatId)) return;

    const raw = ctx.match.trim();
    if (!raw) {
      await this.replyTemp(ctx, "Gunakan /scan <token-contract-address>");
      return;
    }
    if (!isAddress(raw)) {
      await this.replyTemp(ctx, "Address tidak valid.");
      return;
    }

    await this.runTokenScan(ctx, scanner, raw as Address);
  }

  private async runTokenScan(ctx: Context, scanner: PoolScanner, token: Address): Promise<void> {
    const elapsed = Date.now() - this.lastScanAt;
    if (elapsed < 15_000) {
      await this.replyTemp(ctx, `Tunggu ${Math.ceil((15_000 - elapsed) / 1_000)} detik sebelum scan berikutnya.`);
      return;
    }
    this.lastScanAt = Date.now();

    await this.replyTemp(ctx, `🔍 Mencari pool Uniswap V3/V4 untuk ${shortAddress(token)} di Robinhood...`, undefined, 120_000);

    let scan;
    try {
      scan = await scanner.scan(token);
    } catch (error) {
      await this.replyTemp(ctx, `Scan gagal: ${errorMessage(error).slice(0, 500)}`, undefined, 120_000);
      return;
    }

    if (scan.active.length === 0 && scan.watchlist.length === 0) {
      await this.replyTemp(ctx, `Tidak ditemukan pool Uniswap V3/V4 dengan TVL > $0 dan Vol 6h >= $100 untuk token ini.`, undefined, 120_000);
      return;
    }

    const lines: string[] = [
      `🔍 SCAN: ${shortAddress(token)}`,
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

    lines.push("", "Yield 1h: (vol1h × feeRate / TVL). Score memakai Vol 6h dan safety factor.");

    await this.replyTemp(ctx, lines.join("\n"), undefined, 120_000);
  }

  private async handleScanPools(ctx: Context, database: Database, scanner: PoolScanner): Promise<void> {
    const chatId = ctx.chat?.id.toString();
    if (!chatId || !this.authorized(chatId)) return;
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
      const text = `Scan pools gagal: ${errorMessage(error).slice(0, 500)}`;
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
    if (!chatId || !this.authorized(chatId)) return;
    const pending = this.pendingInput.get(chatId);
    const text = ctx.message?.text?.trim();
    if (!pending || !text || text.startsWith("/")) return;
    this.pendingInput.delete(chatId);
    if (pending.kind === "scan_token") {
      if (!isAddress(text)) {
        await this.replyTemp(ctx, "Address token tidak valid.");
        return;
      }
      await this.runTokenScan(ctx, scanner, text as Address);
      return;
    }
    try {
      const settings = await this.poolScanSettings(database, chatId);
      const next = { ...settings, ...parsePoolScanInput(pending.key, text) };
      await database.setPoolScanSettings(chatId, next);
      await this.replyTemp(ctx, "✅ Pool scan config diperbarui.");
      await this.showPoolScanConfig(database, chatId, pending.dashboardMessageId);
    } catch (error) {
      await this.replyTemp(ctx, `Config tidak valid: ${errorMessage(error).slice(0, 200)}`);
    }
  }

  private async poolScanSettings(database: Database, chatId: string): Promise<PoolScanSettings> {
    return { ...this.config.poolScanDefaults, ...(await database.getPoolScanSettings(chatId)) };
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
    if (!chatId || !this.authorized(chatId)) return;
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
      await this.replyTemp(ctx, `Gagal menyimpan background: ${errorMessage(error).slice(0, 200)}`);
    }
  }

  private async handleHistoryCommand(ctx: ChatContext, database: Database): Promise<void> {
    const chatId = ctx.chat.id.toString();
    if (!this.authorized(chatId)) return;
    await this.showHistory(ctx, database, chatId, 0);
  }

  private async showHistory(ctx: Context, database: Database, chatId: string, page: number): Promise<void> {
    const history = await database.listCloseHistory(50);
    if (history.length === 0) {
      await this.replyTemp(ctx, "Tidak ada riwayat posisi close yang lolos ambang ±0.5%.");
      return;
    }
    const pageCount = Math.max(1, Math.ceil(history.length / DASHBOARD_PAGE_SIZE));
    const p = clampDashboardPage(page, pageCount);
    const start = p * DASHBOARD_PAGE_SIZE;
    const pageItems = history.slice(start, start + DASHBOARD_PAGE_SIZE);
    const lines = ["📚 RIWAYAT CLOSE ±0.5%", ""];
    for (const item of pageItems) {
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
      lines.push(`   Settled: ${fmtUtc(item.settledAt)} UTC`);
      lines.push("");
    }
    if (pageCount > 1) lines.push(`Page ${p + 1}/${pageCount} | ${history.length} riwayat`);
    await this.replyTemp(ctx, lines.join("\n"));
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
    const png = await renderPnlCard(record, pair, qtDec, qtSymbol, bg, durationStr);
    const sent = await ctx.replyWithPhoto(new InputFile(png, "pnl-card.png"));
    if (sent && "message_id" in sent) {
      await this.queueTemp(chatId, (sent as any).message_id, 120_000);
    }
  }

  private async handleClose(ctx: ChatContext, database: Database, executor: Executor): Promise<void> {
    const chatId = ctx.chat.id.toString();
    if (!this.authorized(chatId)) return;

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
      await this.replyTemp(ctx, `Close gagal: ${message.slice(0, 500)}`);
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
          log.warn({ error: errorMessage(error) }, "could not send Telegram notification");
          return;
        }
      }
    });
    this.sendQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function dashboardAction(type: "refresh" | "close" | "status" | "scan" | "scan_pools" | "config" | "config_reset" | "history" | "pnl_card" | "bg_upload" | "bg_reset", page: number): string {
  return `lp:${type}:${page}`;
}

function dashboardPositionAction(type: "select" | "confirm", page: number, position: PositionRecord): string {
  return `lp:${type}:${page}:${position.chainId}:${position.protocol}:${position.positionKey}`;
}

export function parseDashboardAction(data: string | undefined): DashboardAction | null {
  if (!data) return null;
  const parts = data.split(":");
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
  if (parts.length === 3 && parts[0] === "lp" && parts[1] === "cfgquote" && ["USDG", "WETH", "ETH"].includes(parts[2] ?? "")) {
    return { type: "config_quote", quote: parts[2]! };
  }
  if (parts.length === 4 && parts[0] === "lp" && parts[1] === "pnl_cs") {
    const page = parseDashboardPage(parts[2]);
    const historyIndex = Number(parts[3]);
    if (page === null || !Number.isSafeInteger(historyIndex) || historyIndex < 0) return null;
    return { type: "pnl_card_select", page, historyIndex };
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

function isDashboardAction(value: string | undefined): value is "refresh" | "close" | "status" | "scan" | "scan_pools" | "config" | "config_reset" | "history" | "pnl_card" | "bg_upload" | "bg_reset" {
  return value === "refresh" || value === "close" || value === "status" || value === "scan" || value === "scan_pools" || value === "config" || value === "config_reset" || value === "history" || value === "pnl_card" || value === "bg_upload" || value === "bg_reset";
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

function formatQuotePrice(value: bigint, quoteSymbol: string): string {
  const prefix = quoteSymbol === "USDG" || quoteSymbol === "USDC" ? "$" : "";
  if (value === 0n) return `${prefix}0`;
  const integer = value / QUOTE_PRICE_SCALE;
  if (integer > 0n) return `${prefix}${formatToken(value, 18, integer >= 100n ? 2 : 4)}`;
  const fraction = value.toString().padStart(18, "0");
  const firstSignificant = fraction.search(/[1-9]/);
  const decimals = Math.min(12, firstSignificant + 4);
  return `${prefix}${formatToken(value, 18, decimals)}`;
}

function quoteRangeStatus(status: import("../types.js").PositionRangeInfo["status"], quoteIsToken0: boolean, metadata: Record<string, unknown>): string {
  if (status === "in_range") return "🟢 IN RANGE";
  const aboveQuoteRange = quoteIsToken0 ? status === "below" : status === "above";
  if (!aboveQuoteRange) return "⚠️ BELOW RANGE";
  const seenAt = typeof metadata.oorAboveSeenAt === "number" ? metadata.oorAboveSeenAt : undefined;
  const timer = seenAt ? ` ⏳${Math.floor((Date.now() - seenAt) / 60_000)}m` : "";
  return `⚠️ ABOVE RANGE${timer}`;
}

function triggerDisplayShort(trigger: string): string {
  switch (trigger) {
    case "stop_loss": return "SL";
    case "take_profit": return "TP";
    case "trailing_take_profit": return "Trail";
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
