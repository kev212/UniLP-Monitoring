import { describe, expect, it } from "vitest";

import { canRequestManualClose, clampDashboardPage, formatRangePrices, isExpiredCallbackError, parseDashboardAction, parseScanInput, parseScanV2Input, positionRangeBins } from "../src/services/notifier.js";

describe("Telegram dashboard callbacks", () => {
  it("parses chain-aware token scan input", () => {
    const token = "0x833589fCD6EDB6E08f4c7C32D4f71b54bdA02913";
    expect(parseScanInput(`base ${token}`)).toEqual({ chain: "base", token });
    expect(parseScanInput(token)).toEqual({ chain: "robinhood", token });
    expect(parseScanInput("base 0xinvalid")).toBeNull();
  });

  it("parses concentrated scan input with default and custom ranges", () => {
    const token = "0x833589fCD6EDB6E08f4c7C32D4f71b54bdA02913";
    expect(parseScanV2Input(token)).toEqual({ chain: "robinhood", token, range: 35 });
    expect(parseScanV2Input(`base ${token} 40%`)).toEqual({ chain: "base", token, range: 40 });
    expect(parseScanV2Input(`base ${token} 4`)).toBeNull();
  });

  it("parses dashboard navigation callbacks", () => {
    expect(parseDashboardAction("lp:refresh:2")).toEqual({ type: "refresh", page: 2 });
    expect(parseDashboardAction("lp:close:0")).toEqual({ type: "close", page: 0 });
    expect(parseDashboardAction("lp:status:4")).toEqual({ type: "status", page: 4 });
  });

  it("parses a position selection callback", () => {
    expect(parseDashboardAction("lp:confirm:1:4663:v4:49339")).toEqual({
      type: "confirm",
      page: 1,
      chainId: 4663,
      protocol: "v4",
      positionKey: "49339",
    });
  });

  it("parses pool-scan dashboard callbacks", () => {
    expect(parseDashboardAction("lp:scan_pools:0")).toEqual({ type: "scan_pools", page: 0 });
    expect(parseDashboardAction("lp:cfg:yield")).toEqual({ type: "config_edit", key: "yield" });
    expect(parseDashboardAction("lp:cfgquote:WETH")).toEqual({ type: "config_quote", quote: "WETH" });
  });

  it("parses UTC calendar callbacks", () => {
    expect(parseDashboardAction("lp:calendar:2026-07")).toEqual({ type: "calendar", year: 2026, month: 7 });
    expect(parseDashboardAction("lp:calnav:2026-06")).toEqual({ type: "calendar_page", year: 2026, month: 6 });
    expect(parseDashboardAction("lp:histpg:2")).toEqual({ type: "history_page", page: 2 });
    expect(parseDashboardAction("lp:calendar:2026-13")).toBeNull();
  });

  it("rejects malformed or unsupported callbacks", () => {
    expect(parseDashboardAction("lp:confirm:1:4663:v5:49339")).toBeNull();
    expect(parseDashboardAction("lp:select:-1:4663:v4:49339")).toBeNull();
    expect(parseDashboardAction("lp:select:0:0:v4:49339")).toBeNull();
    expect(parseDashboardAction("lp:delete:0")).toBeNull();
  });

  it("clamps pages to the available dashboard range", () => {
    expect(clampDashboardPage(-1, 3)).toBe(0);
    expect(clampDashboardPage(9, 3)).toBe(2);
    expect(clampDashboardPage(0, 0)).toBe(0);
  });

  it("does not offer close controls for unsafe statuses", () => {
    expect(canRequestManualClose("armed")).toBe(true);
    expect(canRequestManualClose("failed")).toBe(true);
    expect(canRequestManualClose("closing")).toBe(false);
    expect(canRequestManualClose("needs_review")).toBe(false);
    expect(canRequestManualClose("settled")).toBe(false);
  });

  it("identifies callback queries Telegram can no longer acknowledge", () => {
    expect(isExpiredCallbackError(new Error("400: Bad Request: query is too old and response timeout expired"))).toBe(true);
    expect(isExpiredCallbackError(new Error("400: Bad Request: query ID is invalid"))).toBe(true);
    expect(isExpiredCallbackError(new Error("400: Bad Request: message is not modified"))).toBe(false);
  });

  it("renders a centered bin marker for an in-range price", () => {
    const bins = positionRangeBins(0n, 100n, 50n);
    expect(bins.marker).toBe("🟨");
    expect(bins.markerIndex).toBe(4);
    expect([...bins.bar].filter((value) => value === "🟨")).toHaveLength(1);
    expect(bins.bar).toContain("🟩");
    expect(bins.bar).toContain("🟦");
  });

  it("pins the marker to the edge when price is outside the range", () => {
    expect(positionRangeBins(100n, 200n, 50n)).toMatchObject({ marker: "◀", markerIndex: 0 });
    expect(positionRangeBins(100n, 200n, 250n)).toMatchObject({ marker: "▶", markerIndex: 9 });
  });

  it("shows prices normally when all values are at least 0.001", () => {
    const SCALE = 10n ** 18n;
    const result = formatRangePrices(10n ** 15n, 1383n * 10n ** 15n, 2n * 10n ** 16n, "USDG");
    expect(result.scale).toBe("");
    expect(result.low).toBe("$0.001");
    expect(result.high).toBe("$0.02");
  });

  it("uses shared integer scale for very small prices", () => {
    const result = formatRangePrices(7758n * 10n ** 8n, 1383n * 10n ** 9n, 169n * 10n ** 10n, "ETH");
    expect(result.scale).toContain("×10");
    expect(result.low).toBe("776");
    expect(result.cur).toBe("1383");
    expect(result.high).toBe("1690");
  });

});
