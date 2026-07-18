import { describe, expect, it } from "vitest";

import { canRequestManualClose, clampDashboardPage, isExpiredCallbackError, parseDashboardAction, parseScanInput, parseScanV2Input } from "../src/services/notifier.js";

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
});
