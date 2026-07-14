import sharp from "sharp";
import type { CloseHistoryRecord } from "../types.js";

const W = 640;
const H = 400;
const PAD = 32;
const RADIUS = 18;

const FONT = "Noto Sans Mono, monospace";

const colors = {
  profitBg: "#0a2e1a",
  profitBorder: "#22c55e",
  profitAccent: "#16a34a",
  profitText: "#86efac",
  lossBg: "#2e0a0a",
  lossBorder: "#ef4444",
  lossAccent: "#dc2626",
  lossText: "#fca5a5",
  label: "#9ca3af",
  value: "#f3f4f6",
  muted: "#6b7280",
};

export async function renderPnlCard(record: CloseHistoryRecord, pair: string, qtDecimals: number, qtSymbol: string): Promise<Buffer> {
  const isProfit = record.finalPnlBps >= 0n;
  const accent = isProfit ? colors.profitAccent : colors.lossAccent;
  const border = isProfit ? colors.profitBorder : colors.lossBorder;
  const bgColor = isProfit ? colors.profitBg : colors.lossBg;
  const pnlTextColor = isProfit ? colors.profitText : colors.lossText;
  const sign = isProfit ? "+" : "";

  const pnlPct = fmtBps(record.finalPnlBps);
  const pnlAmt = fmtToken(record.finalPnlQuote, qtDecimals);
  const pnlUsd = fmtToken(record.finalPnlUsd, 6, 2);
  const hasUsd = record.finalPnlUsd !== 0n;
  const protoLabel = record.protocol.toUpperCase();
  const settledStr = fmtUtc(record.settledAt);
  const triggerLabel = triggerDisplay(record.trigger);

  const lines: string[] = [];

  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  lines.push(`<defs>`);
  lines.push(`<linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">`);
  lines.push(`<stop offset="0%" stop-color="${bgColor}"/>`);
  lines.push(`<stop offset="100%" stop-color="#0f172a"/>`);
  lines.push(`</linearGradient>`);
  lines.push(`</defs>`);

  lines.push(`<rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}" fill="url(#bgGrad)" stroke="${border}" stroke-width="2"/>`);

  // Top row: pair + protocol
  lines.push(`<text x="${PAD}" y="54" font-family="${FONT}" font-size="15" fill="${colors.label}">${xmlEscape(pair)}${protoLabel === "V4" ? " · V4" : " · " + protoLabel}</text>`);
  lines.push(`<text x="${W - PAD}" y="54" font-family="${FONT}" font-size="13" fill="${colors.muted}" text-anchor="end">#${record.positionKey}</text>`);

  // PnL %
  lines.push(`<text x="${W / 2}" y="${H / 2 - 16}" font-family="${FONT}" font-size="60" font-weight="bold" fill="${accent}" text-anchor="middle">${sign}${pnlPct}%</text>`);

  // PnL quote
  lines.push(`<text x="${W / 2}" y="${H / 2 + 32}" font-family="${FONT}" font-size="16" fill="${pnlTextColor}" text-anchor="middle">${sign}${pnlAmt} ${qtSymbol} ${isProfit ? "PROFIT" : "LOSS"}</text>`);

  // USD
  if (hasUsd) {
    lines.push(`<text x="${W / 2}" y="${H / 2 + 56}" font-family="${FONT}" font-size="14" fill="${colors.label}" text-anchor="middle">≈ ${sign}$${pnlUsd}</text>`);
  }

  // Divider
  lines.push(`<line x1="${PAD}" y1="${H - 70}" x2="${W - PAD}" y2="${H - 70}" stroke="${colors.muted}" stroke-opacity="0.15" stroke-width="1"/>`);

  // Bottom: trigger + time
  lines.push(`<text x="${PAD}" y="${H - 42}" font-family="${FONT}" font-size="12" fill="${colors.label}">${triggerLabel}</text>`);
  lines.push(`<text x="${W - PAD}" y="${H - 42}" font-family="${FONT}" font-size="12" fill="${colors.muted}" text-anchor="end">${settledStr} UTC</text>`);

  lines.push(`</svg>`);

  return sharp(Buffer.from(lines.join("\n"), "utf-8")).png().toBuffer();
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtBps(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function fmtToken(value: bigint, decimals: number, maxDec?: number): string {
  if (decimals === 0 || value === 0n) return value.toString();
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(Math.min(decimals, 18));
  const integer = absolute / divisor;
  const fraction = absolute % divisor;
  if (fraction === 0n) return `${negative ? "-" : ""}${integer}`;
  let fracStr = fraction.toString().padStart(Math.min(decimals, 18), "0").replace(/0+$/, "");
  if (maxDec !== undefined && fracStr.length > maxDec) {
    fracStr = fracStr.slice(0, maxDec);
  }
  return `${negative ? "-" : ""}${integer}.${fracStr}`;
}

function triggerDisplay(trigger: string): string {
  switch (trigger) {
    case "stop_loss": return "Stop Loss";
    case "take_profit": return "Take Profit";
    case "trailing_take_profit": return "Trailing Take Profit";
    case "manual": return "Manual Close";
    default: return trigger.replace(/_/g, " ");
  }
}

export function fmtUtc(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}
