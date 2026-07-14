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
    POSITION_MONITOR_INTERVAL_MS: "5000",
    DISCOVERY_INTERVAL_MS: "30000",
    POSITION_MONITOR_CONCURRENCY: "2",
    MAX_SWAP_SLIPPAGE_BPS: "100",
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
    expect(config.positionMonitorIntervalMs).toBe(5_000);
    expect(config.discoveryIntervalMs).toBe(30_000);
    expect(config.positionMonitorConcurrency).toBe(2);
    expect(config.uniswapApiKey).toBeUndefined();
    expect(config.poolScanDefaults).toEqual({
      minMarketCapUsd: 500_000,
      minTotalActiveTvlUsd: 70_000,
      minPoolAgeSeconds: 3_600,
      minYieldHourlyPercent: 1,
      maxResults: 10,
      allowedQuotes: ["USDG", "WETH", "ETH"],
    });
  });

  it("loads a local Uniswap Trading API key", () => {
    expect(loadConfig(environment({ UNISWAP_API_KEY: "api-key" })).uniswapApiKey).toBe("api-key");
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
});
