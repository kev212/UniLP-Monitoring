import { describe, expect, it } from "vitest";

import { loadConfig, PUBLIC_ROBINHOOD_RPC_HTTP, PUBLIC_ROBINHOOD_SCAN_RPC_HTTP } from "../src/config.js";

function environment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://unilp:unilp@localhost:5432/unilp",
    CHAINS: "base,robinhood",
    EXECUTOR_ADDRESS: "0x0000000000000000000000000000000000000001",
    BASE_RPC_HTTP: "https://mainnet.base.org",
    BASE_RPC_WSS: "",
    ROBINHOOD_RPC_HTTP: "https://rpc.mainnet.chain.robinhood.com",
    ROBINHOOD_RPC_WSS: "",
    BSC_RPC_HTTP: "https://bsc-dataseed.bnbchain.org",
    QUOTE_TOKEN_ALLOWLIST_BASE: "USDC:0x833589fCD6EDB6E08f4c7C32D4f71b54bdA02913,WETH:0x4200000000000000000000000000000000000006",
    QUOTE_TOKEN_ALLOWLIST_ROBINHOOD: "USDG:0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,WETH:0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73,NVDA:0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,SPY:0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
    QUOTE_TOKEN_ALLOWLIST_BSC: "USDT:0x55d398326f99059fF775485246999027B3197955,WBNB:0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c,BNB:0x0000000000000000000000000000000000000000",
    STOP_LOSS_PERCENT: "-10",
    TAKE_PROFIT_PERCENT: "20",
    TRAILING_STOP_ACTIVATION_PERCENT: "5",
    TRAILING_STOP_DRAWDOWN_PERCENT: "1.5",
    TRAILING_EXIT_ESTIMATE_BUFFER_PERCENT: "10",
    PROFIT_OOR_ABOVE_THRESHOLD_PERCENT: "3",
    POSITION_MONITOR_INTERVAL_MS: "5000",
    DISCOVERY_INTERVAL_MS: "30000",
    POSITION_MONITOR_CONCURRENCY: "2",
    MAX_SWAP_SLIPPAGE_BPS: "100",
    SWAP_GAS_LIMIT_MULTIPLIER_PERCENT: "300",
    MAX_TWAP_DEVIATION_BPS: "250",
    TWAP_WINDOW_SECONDS: "300",
    PNL_INCLUDE_GAS: "false",
    APPROVAL_MODE: "exact",
    DRY_RUN: "true",
    CONFIRMATIONS: "2",
    SCAN_BLOCK_RANGE: "2000",
    RPC_BOOTSTRAP_LOOKBACK_BLOCKS: "50000",
    START_BLOCK_BASE: "0",
    START_BLOCK_ROBINHOOD: "0",
    START_BLOCK_BSC: "0",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("parses canonical quote token lists and safety settings", () => {
    const config = loadConfig(environment());

    expect(config.chains).toEqual(["base", "robinhood"]);
    expect(config.quoteTokens.base.map((token) => token.symbol)).toEqual(["USDC", "WETH"]);
    expect(config.quoteTokens.base[0]!.address).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(config.quoteTokens.robinhood.map((token) => token.symbol)).toEqual(["USDG", "WETH", "NVDA", "SPY"]);
    expect(config.dryRun).toBe(true);
    expect(config.pnlIncludeGas).toBe(false);
    expect(config.trailingStopActivationPercent).toBe(5);
    expect(config.trailingStopDrawdownPercent).toBe(1.5);
    expect(config.trailingExitEstimateBufferPercent).toBe(10);
    expect(config.profitOorAboveThresholdPercent).toBe(3);
    expect(config.slTwapGuardMaxWaitMs).toBe(15_000);
    expect(config.trailingTwapGuardMaxWaitMs).toBe(15_000);
    expect(config.positionMonitorIntervalMs).toBe(5_000);
    expect(config.discoveryIntervalMs).toBe(30_000);
    expect(config.maxLogBlockRange).toBe(2_000n);
    expect(config.rpcRequestDelayMs).toBe(0);
    expect(config.blinkRescuePollIntervalMs).toBe(15_000);
    expect(config.oorAboveMinDistancePercent).toBe(10);
    expect(config.oorAboveMinDurationMs).toBe(3_600_000);
    expect(config.oorAboveProfitDurationMs).toBe(300_000);
    expect(config.positionMonitorConcurrency).toBe(2);
    expect(config.uniswapApiKey).toBeUndefined();
    expect(config.kyberswapEnabled).toBe(true);
    expect(config.kyberswapClientId).toBe("UniLP-Monitoring-kev212");
    expect(config.settlementSwapSlippageBps).toBe(200);
    expect(config.settlementSwapMaxSlippageBps).toBe(500);
    expect(config.swapGasLimitMultiplierPercent).toBe(300);
    expect(config.removeLiquiditySlippageBps).toBe(200);
    expect(config.removeLiquidityMaxSlippageBps).toBe(500);
    expect(config.swapApiTimeoutMs).toBe(2_500);
    expect(config.poolScanDefaults).toEqual({
      minMarketCapUsd: 500_000,
      minPoolTvlUsd: 10_000,
      minTotalActiveTvlUsd: 70_000,
      minPoolAgeSeconds: 3_600,
      minYieldHourlyPercent: 1,
      maxResults: 10,
      allowedQuotes: ["USDG", "WETH", "ETH"],
    });
    expect(config.poolScanCandidatePages).toBe(3);
    expect(config.scanV2Enabled).toBe(false);
    expect(config.bidAskLadderEnabled).toBe(false);
    expect(config.bidAskLadderProtocols).toEqual(["v3", "v4"]);
    expect(config.bidAskLadderMaxBins).toBe(16);
    expect(config.bidAskLadderMaxPriceDeviationBps).toBe(100);
    expect(config.bidAskLadderAtomicMaxBlockGasBps).toBe(8_000);
    expect(config.bidAskLadderTransactionDeadlineSeconds).toBe(300);
    expect(config.bidAskLadderMaxRetries).toBe(3);
  });

  it("keeps discovery log defaults bounded when Alchemy archive access is configured", () => {
    const config = loadConfig(environment({ ALCHEMY_ROBINHOOD_HTTP: "https://robinhood-mainnet.g.alchemy.com/v2/test" }));

    expect(config.maxLogBlockRange).toBe(2_000n);
    expect(config.rpcRequestDelayMs).toBe(0);
  });

  it("strictly parses Bid-Ask ladder settings", () => {
    const config = loadConfig(environment({
      BIDASK_LADDER_ENABLED: "true",
      BIDASK_LADDER_PROTOCOLS: "v4",
      BIDASK_LADDER_MAX_BINS: "4",
      BIDASK_LADDER_MAX_PRICE_DEVIATION_BPS: "125",
      BIDASK_LADDER_ATOMIC_MAX_BLOCK_GAS_BPS: "7500",
      BIDASK_LADDER_TRANSACTION_DEADLINE_SECONDS: "600",
      BIDASK_LADDER_MAX_RETRIES: "0",
    }));

    expect(config.bidAskLadderEnabled).toBe(true);
    expect(config.bidAskLadderProtocols).toEqual(["v4"]);
    expect(config.bidAskLadderMaxBins).toBe(4);
    expect(config.bidAskLadderMaxPriceDeviationBps).toBe(125);
    expect(config.bidAskLadderAtomicMaxBlockGasBps).toBe(7_500);
    expect(config.bidAskLadderTransactionDeadlineSeconds).toBe(600);
    expect(config.bidAskLadderMaxRetries).toBe(0);

    expect(() => loadConfig(environment({ BIDASK_LADDER_ENABLED: "yes" }))).toThrow("BIDASK_LADDER_ENABLED");
    expect(() => loadConfig(environment({ BIDASK_LADDER_PROTOCOLS: "v2" }))).toThrow("BIDASK_LADDER_PROTOCOLS");
    expect(() => loadConfig(environment({ BIDASK_LADDER_MAX_BINS: "4.5" }))).toThrow("BIDASK_LADDER_MAX_BINS");
  });

  it("enables scanv2 only when explicitly configured", () => {
    expect(loadConfig(environment({ SCANV2_ENABLED: "true" })).scanV2Enabled).toBe(true);
    expect(() => loadConfig(environment({ SCANV2_ENABLED: "yes" }))).toThrow("SCANV2_ENABLED");
  });

  it("configures BSC Uniswap V4 discovery explicitly", () => {
    const config = loadConfig(environment({ CHAINS: "bsc", START_BLOCK_BSC: "26956207" }));
    expect(config.chains).toEqual(["bsc"]);
    expect(config.rpcHttp.bsc).toBe("https://bsc-dataseed.bnbchain.org");
    expect(config.quoteTokens.bsc.map((token) => token.symbol)).toEqual(["USDT", "WBNB", "BNB"]);
    expect(config.startBlocks.bsc).toBe(26_956_207n);
    expect(config.autoExitChains).toEqual(["base", "robinhood", "bsc"]);
    expect(config.chainMonitorIntervalMs.bsc).toBe(10_000);
  });

  it("loads a local Uniswap Trading API key", () => {
    expect(loadConfig(environment({ UNISWAP_API_KEY: "api-key" })).uniswapApiKey).toBe("api-key");
  });

  it("validates dual-provider settlement settings", () => {
    const config = loadConfig(environment({
      KYBERSWAP_ENABLED: "false",
      KYBERSWAP_CLIENT_ID: "custom-client",
      SETTLEMENT_SWAP_SLIPPAGE_BPS: "250",
      SETTLEMENT_SWAP_MAX_SLIPPAGE_BPS: "400",
      SWAP_API_TIMEOUT_MS: "1500",
    }));

    expect(config.kyberswapEnabled).toBe(false);
    expect(config.kyberswapClientId).toBe("custom-client");
    expect(config.settlementSwapSlippageBps).toBe(250);
    expect(config.settlementSwapMaxSlippageBps).toBe(400);
    expect(config.swapApiTimeoutMs).toBe(1_500);
    expect(() => loadConfig(environment({ SETTLEMENT_SWAP_SLIPPAGE_BPS: "500", SETTLEMENT_SWAP_MAX_SLIPPAGE_BPS: "200" }))).toThrow("MAX_SLIPPAGE");
  });

  it("requires an allowlisted user for Telegram group chats", () => {
    expect(() => loadConfig(environment({
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    }))).toThrow("TELEGRAM_USER_ID");

    expect(loadConfig(environment({
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
      TELEGRAM_USER_ID: "123456",
    })).telegram).toEqual({ token: "bot-token", chatId: "-100123", userId: "123456" });
  });

  it("rejects ambiguous quote-token configuration", () => {
    expect(() => loadConfig(environment({ QUOTE_TOKEN_ALLOWLIST_BASE: "USDC:0x833589fCD6EDB6E08f4c7C32D4f71b54bdA02913,FAKE:0x833589fCD6EDB6E08f4c7C32D4f71b54bdA02913" }))).toThrow("duplicate");
  });

  it("configures Alchemy before the public Robinhood RPC fallback", () => {
    const config = loadConfig(environment({
      BASE_RPC_HTTP: "https://mainnet.base.org",
      ROBINHOOD_RPC_HTTP: "https://rpc.mainnet.chain.robinhood.com",
      ALCHEMY_BASE_HTTP: "https://base-mainnet.g.alchemy.com/v2/example",
      ALCHEMY_ROBINHOOD_HTTP: "https://robinhood-mainnet.g.alchemy.com/v2/example",
    }));

    expect(config.rpcHttp.base).toBe("https://mainnet.base.org");
    expect(config.rpcHttp.robinhood).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(config.rpcHttpFallback.robinhood).toBe(PUBLIC_ROBINHOOD_RPC_HTTP);
    expect(config.rpcHttpScanFallback.robinhood).toBe(PUBLIC_ROBINHOOD_SCAN_RPC_HTTP);
    expect(config.alchemyHttp.base).toContain("alchemy.com");
    expect(config.alchemyHttp.robinhood).toContain("alchemy.com");
  });

  it("allows an explicit Robinhood fallback override", () => {
    const config = loadConfig(environment({ ROBINHOOD_RPC_HTTP_FALLBACK: "https://public-fallback.example/rpc" }));

    expect(config.rpcHttpFallback.robinhood).toBe("https://public-fallback.example/rpc");
  });

  it("allows an explicit heavy-scan fallback without changing transaction fallback", () => {
    const config = loadConfig(environment({ ROBINHOOD_SCAN_RPC_HTTP: "https://rpc.arrowrpc.com" }));

    expect(config.rpcHttpScanFallback.robinhood).toBe("https://rpc.arrowrpc.com");
    expect(config.rpcHttpFallback.robinhood).toBe(PUBLIC_ROBINHOOD_RPC_HTTP);
  });

  it("rejects remove-liquidity max slippage below base", () => {
    expect(() => loadConfig(environment({
      REMOVE_LIQUIDITY_SLIPPAGE_BPS: "500",
      REMOVE_LIQUIDITY_MAX_SLIPPAGE_BPS: "200",
    }))).toThrow("REMOVE_LIQUIDITY_MAX_SLIPPAGE_BPS must be at least");
  });
});
