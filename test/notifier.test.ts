import { describe, expect, it } from "vitest";

import { canRequestManualClose, clampDashboardPage, parseDashboardAction } from "../src/services/notifier.js";

describe("Telegram dashboard callbacks", () => {
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
});
