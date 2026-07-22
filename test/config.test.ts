import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

function environment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://unilp:unilp@localhost:5432/unilp",
    CHAINS: "base,robinhood",
    EXECUTOR_ADDRESS: "0x0000000000000000000000000000000000000001",
    BASE_RPC_HTTP: "https://mainnet.base.org",
    BASE_RPC_WSS: "",
    ROBINHOOD_RPC_HTTP: "https://rpc.mainnet.chain.robinhood.com",
    ROBINHOOD_RPC_WSS: "",
    QUOTE_TOKEN_ALLOWLIST_BASE: "USDC:0x833589fCD6EDB6E08f4c7C32D4f71b54bdA02913,WETH:0x4200000000000000000000000000000000000006",
    QUOTE_TOKEN_ALLOWLIST_ROBINHOOD: "USDG:0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,WETH:0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
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
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("parses canonical quote token lists and safety settings", () => {
    const config = loadConfig(environment());

    expect(config.chains).toEqual(["base", "robinhood"]);
    expect(config.quoteTokens.base.map((token) => token.symbol)).toEqual(["USDC", "WETH"]);
    expect(config.quoteTokens.robinhood.map((token) => token.symbol)).toEqual(["USDG", "WETH"]);
    expect(config.dryRun).toBe(true);
    expect(config.pnlIncludeGas).toBe(false);
    expect(config.trailingStopActivationPercent).toBe(5);
    expect(config.trailingStopDrawdownPercent).toBe(1.5);
    expect(config.trailingExitEstimateBufferPercent).toBe(10);
    expect(config.profitOorAboveThresholdPercent).toBe(3);
    expect(config.positionMonitorIntervalMs).toBe(5_000);
    expect(config.discoveryIntervalMs).toBe(30_000);
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
  });

  it("enables scanv2 only when explicitly configured", () => {
    expect(loadConfig(environment({ SCANV2_ENABLED: "true" })).scanV2Enabled).toBe(true);
    expect(() => loadConfig(environment({ SCANV2_ENABLED: "yes" }))).toThrow("SCANV2_ENABLED");
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

  it("keeps native RPC for log scans and uses Alchemy only for bootstrap", () => {
    const config = loadConfig(environment({
      BASE_RPC_HTTP: "https://mainnet.base.org",
      ROBINHOOD_RPC_HTTP: "https://rpc.mainnet.chain.robinhood.com",
      ALCHEMY_BASE_HTTP: "https://base-mainnet.g.alchemy.com/v2/example",
      ALCHEMY_ROBINHOOD_HTTP: "https://robinhood-mainnet.g.alchemy.com/v2/example",
    }));

    expect(config.rpcHttp.base).toBe("https://mainnet.base.org");
    expect(config.rpcHttp.robinhood).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(config.alchemyHttp.base).toContain("alchemy.com");
    expect(config.alchemyHttp.robinhood).toContain("alchemy.com");
  });

  it("rejects remove-liquidity max slippage below base", () => {
    expect(() => loadConfig(environment({
      REMOVE_LIQUIDITY_SLIPPAGE_BPS: "500",
      REMOVE_LIQUIDITY_MAX_SLIPPAGE_BPS: "200",
    }))).toThrow("REMOVE_LIQUIDITY_MAX_SLIPPAGE_BPS must be at least");
  });
});
