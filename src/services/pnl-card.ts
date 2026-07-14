import sharp from "sharp";
import type { CloseHistoryRecord } from "../types.js";

const W = 600;
const H = 360;
const PAD = 28;
const RADIUS = 16;

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
  bg: "#111827",
};

export async function renderPnlCard(record: CloseHistoryRecord, pair: string): Promise<Buffer> {
  const isProfit = record.finalPnlBps >= 0n;
  const accent = isProfit ? colors.profitAccent : colors.lossAccent;
  const border = isProfit ? colors.profitBorder : colors.lossBorder;
  const bg = isProfit ? colors.profitBg : colors.lossBg;
  const pnlText = isProfit ? colors.profitText : colors.lossText;
  const sign = isProfit ? "+" : "";

  const pnlPercent = formatBps(record.finalPnlBps);
  const pnlAmount = formatToken(record.finalPnlQuote, 6);
  const protoLabel = record.protocol.toUpperCase();
  const settledAt = fmtUtc(record.settledAt);
  const triggerLabel = triggerDisplay(record.trigger);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg}"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}" fill="url(#bgGrad)" stroke="${border}" stroke-width="2"/>
  <text x="${PAD}" y="${PAD + 22}" font-family="monospace" font-size="14" fill="${colors.label}">${pair}${protoLabel === "V4" ? " · V4" : " · " + protoLabel}</text>
  <text x="${W - PAD}" y="${PAD + 22}" font-family="monospace" font-size="12" fill="${colors.muted}" text-anchor="end">#${record.positionKey}</text>
  <text x="${W / 2}" y="${H / 2 - 10}" font-family="monospace" font-size="56" font-weight="bold" fill="${accent}" text-anchor="middle">${sign}${pnlPercent}%</text>
  <text x="${W / 2}" y="${H / 2 + 42}" font-family="monospace" font-size="18" fill="${pnlText}" text-anchor="middle">${sign}${pnlAmount} ${isProfit ? "PROFIT" : "LOSS"}</text>
  <line x1="${PAD}" y1="${H - 60}" x2="${W - PAD}" y2="${H - 60}" stroke="${colors.muted}" stroke-opacity="0.2" stroke-width="1"/>
  <text x="${PAD}" y="${H - 34}" font-family="monospace" font-size="12" fill="${colors.label}">${triggerLabel}</text>
  <text x="${W - PAD}" y="${H - 34}" font-family="monospace" font-size="12" fill="${colors.muted}" text-anchor="end">${settledAt} UTC</text>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

function formatBps(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function formatToken(value: bigint, decimals: number): string {
  if (decimals === 0 || value === 0n) return value.toString();
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(Math.min(decimals, 18));
  const integer = absolute / divisor;
  const fraction = absolute % divisor;
  const fracStr = fraction.toString().padStart(Math.min(decimals, 18), "0").replace(/0+$/, "");
  const num = fracStr ? `${integer}.${fracStr}` : integer.toString();
  return `${negative ? "-" : ""}${num}`;
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
