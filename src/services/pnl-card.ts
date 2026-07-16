import sharp from "sharp";

import type { CloseHistoryRecord, PnlCardDetail } from "../types.js";

const W = 1600;
const H = 1067;
const PAD = 64;
const FONT = "Noto Sans Mono, monospace";
const LIME = "#ccff00";
const LIME_DIM = "#8ab300";
const RED = "#ff4444";
const BG = "#0d0f0a";
const TEXT = "#f0f5d8";
const MUTED = "#aab58c";

export async function renderPnlCard(
  record: CloseHistoryRecord,
  pair: string,
  quoteDecimals: number,
  quoteSymbol: string,
  detail: PnlCardDetail | null,
  customBg?: Buffer | null,
  duration?: string,
): Promise<Buffer> {
  const profit = record.finalPnlBps >= 0n;
  const accent = profit ? LIME : RED;
  const pnlUsd = record.finalPnlUsd !== 0n ? formatUsd(record.finalPnlUsd) : `${formatToken(record.finalPnlQuote, quoteDecimals)} ${quoteSymbol}`;
  const feeTier = detail?.feePips === null || detail?.feePips === undefined ? "FEE N/A" : `FEE ${formatFeeTier(detail.feePips)}`;
  const bg = customBg?.length
    ? (await sharp(customBg).rotate().resize(W, H, { fit: "cover" }).png().toBuffer()).toString("base64")
    : null;
  const details = detail ?? { depositsQuote: 0n, settlementQuote: 0n, feesQuote: 0n, feePips: null };
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<defs><pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M0 0H24V24" fill="none" stroke="#354013" stroke-opacity=".14"/></pattern></defs>`,
    `<rect width="${W}" height="${H}" fill="${BG}"/>`,
    bg ? `<image x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,${bg}" opacity=".35"/>` : `<rect width="${W}" height="${H}" fill="url(#grid)"/>`,
    `<rect width="${W}" height="${H}" fill="#000000" opacity="${bg ? ".20" : ".10"}"/>`,
    `<text x="${PAD}" y="86" font-family="${FONT}" font-size="30" font-weight="bold" fill="${LIME}">UNILP GUARDIAN</text>`,
    `<text x="${W - PAD}" y="86" font-family="${FONT}" font-size="26" fill="${MUTED}" text-anchor="end">ROBINHOOD CHAIN</text>`,
    `<text x="${PAD}" y="182" font-family="${FONT}" font-size="27" fill="${MUTED}">DURATION</text>`,
    `<text x="${PAD}" y="258" font-family="${FONT}" font-size="62" font-weight="bold" fill="${TEXT}">${escape(duration?.replace("DURATION ", "") ?? "N/A")}</text>`,
    badge(PAD, 326, record.protocol.toUpperCase(), "#22271b", TEXT),
    badge(PAD + 135, 326, feeTier, "#30230d", "#ffb347"),
    `<text x="${PAD}" y="500" font-family="${FONT}" font-size="82" font-weight="bold" fill="${TEXT}">${escape(pair)}</text>`,
    `<text x="${PAD}" y="620" font-family="${FONT}" font-size="32" fill="${MUTED}">PNL</text>`,
    `<rect x="${PAD + 92}" y="580" width="185" height="58" rx="10" fill="${profit ? "#103624" : "#3a1515"}"/>`,
    `<text x="${PAD + 184}" y="620" font-family="${FONT}" font-size="31" font-weight="bold" fill="${accent}" text-anchor="middle">${formatBps(record.finalPnlBps)}</text>`,
    `<text x="${PAD}" y="740" font-family="${FONT}" font-size="96" font-weight="bold" fill="${accent}">${pnlUsd}</text>`,
    `<text x="920" y="182" font-family="${FONT}" font-size="30" fill="${MUTED}">DETAILS</text>`,
    detailRow(920, 275, "TOTAL DEPOSITS", `${formatToken(details.depositsQuote, quoteDecimals)} ${quoteSymbol}`),
    detailRow(920, 365, "SETTLEMENT RECEIVED", `${formatToken(details.settlementQuote, quoteDecimals)} ${quoteSymbol}`),
    detailRow(920, 455, "REALIZED FEES", `${formatToken(details.feesQuote, quoteDecimals)} ${quoteSymbol}`),
    `<rect x="${PAD}" y="${H - 137}" width="150" height="58" rx="10" fill="#283027"/>`,
    `<text x="${PAD + 75}" y="${H - 98}" font-family="${FONT}" font-size="27" font-weight="bold" fill="${TEXT}" text-anchor="middle">CLOSED</text>`,
    `<text x="${W - PAD}" y="${H - 94}" font-family="${FONT}" font-size="24" fill="${MUTED}" text-anchor="end">${fmtUtc(record.settledAt)} UTC</text>`,
    `<text x="${W - PAD}" y="${H - 52}" font-family="${FONT}" font-size="18" fill="${MUTED}" text-anchor="end">${escape(triggerDisplay(record.trigger))}</text>`,
    `</svg>`,
  ];
  return sharp(Buffer.from(svg.join("\n"))).png().toBuffer();
}

function badge(x: number, y: number, label: string, fill: string, color: string): string {
  const width = Math.max(118, label.length * 18 + 32);
  return `<rect x="${x}" y="${y}" width="${width}" height="55" rx="10" fill="${fill}"/><text x="${x + width / 2}" y="${y + 37}" font-family="${FONT}" font-size="25" font-weight="bold" fill="${color}" text-anchor="middle">${escape(label)}</text>`;
}

function detailRow(x: number, y: number, label: string, value: string): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="25" fill="${MUTED}">${label}</text><text x="${W - PAD}" y="${y}" font-family="${FONT}" font-size="31" font-weight="bold" fill="${TEXT}" text-anchor="end">${escape(value)}</text>`;
}

function formatFeeTier(feePips: number): string {
  const value = feePips / 10_000;
  return `${value.toFixed(value >= 1 ? 2 : 3).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

function formatBps(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : "+"}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}%`;
}

function formatUsd(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-$" : "+$"}${absolute / 1_000_000n}.${((absolute % 1_000_000n) / 10_000n).toString().padStart(2, "0")}`;
}

function formatToken(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(Math.min(decimals, 18));
  const integer = absolute / divisor;
  const fraction = (absolute % divisor).toString().padStart(Math.min(decimals, 18), "0").slice(0, 4).replace(/0+$/, "");
  return `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
}

function triggerDisplay(trigger: string): string {
  return trigger.replace(/_/g, " ").toUpperCase();
}

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function fmtUtc(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}
