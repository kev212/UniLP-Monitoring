import sharp from "sharp";
import type { CloseHistoryRecord } from "../types.js";

const W = 1440;
const H = 900;
const PAD = 60;
const RADIUS = 32;

const FONT = "Noto Sans Mono, monospace";

const RH = "#ccff00";
const RH_DIM = "#8ab300";
const BG_DARK = "#0d0f0a";
const BG_CARD = "#11150a";
const TEXT_PRIMARY = "#f0f5d8";
const TEXT_SECONDARY = "#aab58c";
const TEXT_MUTED = "#5a6340";
const RED_ACCENT = "#ff4444";
const RED_BG = "#1a0d0d";
const RED_TEXT = "#ffaaaa";

function rhTheme(isProfit: boolean) {
  return {
    accent: isProfit ? RH : RED_ACCENT,
    border: isProfit ? RH_DIM : RED_ACCENT,
    bgStart: isProfit ? BG_CARD : RED_BG,
    bgEnd: isProfit ? BG_DARK : "#0f0808",
    textHighlight: isProfit ? RH : RED_TEXT,
    textSecondary: isProfit ? TEXT_PRIMARY : "#f0e0e0",
  };
}

export async function renderPnlCard(
  record: CloseHistoryRecord,
  pair: string,
  qtDecimals: number,
  qtSymbol: string,
  customBg?: Buffer | null,
): Promise<Buffer> {
  const isProfit = record.finalPnlBps >= 0n;
  const t = rhTheme(isProfit);
  const sign = isProfit ? "+" : "";
  const label = isProfit ? "PROFIT" : "LOSS";

  const pnlPct = fmtBps(record.finalPnlBps);
  const maxDec = qtSymbol === "ETH" || qtSymbol === "WETH" ? 4 : undefined;
  const pnlAmt = fmtToken(record.finalPnlQuote, qtDecimals, maxDec);
  const pnlUsd = fmtToken(record.finalPnlUsd, 6, 2);
  const hasUsd = record.finalPnlUsd !== 0n;
  const protoLabel = record.protocol.toUpperCase();
  const settledStr = fmtUtc(record.settledAt);
  const triggerLabel = triggerDisplay(record.trigger);

  const hasCustomBg = customBg && customBg.length > 0;

  let bgPngBase64: string | null = null;
  if (hasCustomBg) {
    bgPngBase64 = (await sharp(customBg).rotate().resize(W, H, { fit: "cover" }).png().toBuffer()).toString("base64");
  }

  const svgParts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<defs>`,
    `<linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">`,
  ];
  if (hasCustomBg) {
    svgParts.push(`<stop offset="0%" stop-color="#000000" stop-opacity="0.80"/>`);
    svgParts.push(`<stop offset="100%" stop-color="#000000" stop-opacity="0.80"/>`);
  } else {
    svgParts.push(`<stop offset="0%" stop-color="${t.bgStart}"/>`);
    svgParts.push(`<stop offset="100%" stop-color="${t.bgEnd}"/>`);
  }
  svgParts.push(
    `</linearGradient>`,
    `<linearGradient id="accentGrad" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0%" stop-color="${t.accent}"/>`,
    `<stop offset="100%" stop-color="${isProfit ? RH_DIM : "#cc3333"}"/>`,
    `</linearGradient>`,
    `<clipPath id="cardClip">`,
    `<rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}"/>`,
    `</clipPath>`,
    `</defs>`,
  );

  if (bgPngBase64) {
    svgParts.push(
      `<image x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cardClip)" href="data:image/png;base64,${bgPngBase64}"/>`,
    );
  }

  svgParts.push(
    `<rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}" fill="url(#bgGrad)" stroke="${t.border}" stroke-width="3"/>`,

    // Header
    `<text x="${PAD}" y="${PAD + 38}" font-family="${FONT}" font-size="22" fill="${TEXT_SECONDARY}">${xmlEscape(pair)}</text>`,
    `<text x="${PAD}" y="${PAD + 68}" font-family="${FONT}" font-size="16" fill="${TEXT_MUTED}">${protoLabel} · #${record.positionKey}</text>`,

    // Large PnL %
    `<text x="${W / 2}" y="${H / 2 - 48}" font-family="${FONT}" font-size="120" font-weight="bold" fill="url(#accentGrad)" text-anchor="middle">${sign}${pnlPct}%</text>`,

    // PnL quote amount
    `<text x="${W / 2}" y="${H / 2 + 42}" font-family="${FONT}" font-size="28" fill="${t.textSecondary}" text-anchor="middle">${sign}${pnlAmt} ${qtSymbol} ${label}</text>`,

    // USD line
    hasUsd
      ? `<text x="${W / 2}" y="${H / 2 + 82}" font-family="${FONT}" font-size="22" fill="${TEXT_SECONDARY}" text-anchor="middle">≈ ${sign}$${pnlUsd}</text>`
      : "",

    // Divider
    `<line x1="${PAD}" y1="${H - 120}" x2="${W - PAD}" y2="${H - 120}" stroke="${TEXT_MUTED}" stroke-opacity="0.12" stroke-width="2"/>`,

    // Footer left: trigger
    `<text x="${PAD}" y="${H - 80}" font-family="${FONT}" font-size="18" fill="${TEXT_SECONDARY}">${triggerLabel}</text>`,

    // Footer right: time
    `<text x="${W - PAD}" y="${H - 80}" font-family="${FONT}" font-size="18" fill="${TEXT_MUTED}" text-anchor="end">${settledStr} UTC</text>`,

    `</svg>`,
  );

  return sharp(Buffer.from(svgParts.join("\n"), "utf-8")).png().toBuffer();
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  let fracStr = fraction
    .toString()
    .padStart(Math.min(decimals, 18), "0")
    .replace(/0+$/, "");
  if (maxDec !== undefined && fracStr.length > maxDec) {
    fracStr = fracStr.slice(0, maxDec);
  }
  return `${negative ? "-" : ""}${integer}.${fracStr}`;
}

function triggerDisplay(trigger: string): string {
  switch (trigger) {
    case "stop_loss":
      return "Stop Loss";
    case "take_profit":
      return "Take Profit";
    case "trailing_take_profit":
      return "Trailing Take Profit";
    case "manual":
      return "Manual Close";
    default:
      return trigger.replace(/_/g, " ");
  }
}

export function fmtUtc(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}
