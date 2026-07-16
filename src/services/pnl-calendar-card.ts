import sharp from "sharp";

import type { PnlCalendarDay, PnlCalendarMonth } from "../types.js";

const W = 1600;
const H = 1200;
const PAD = 52;
const GRID_TOP = 255;
const GRID_BOTTOM = 1095;
const RAIL_W = 245;
const GRID_W = W - PAD * 2 - RAIL_W - 28;
const CELL_W = GRID_W / 7;
const CELL_H = (GRID_BOTTOM - GRID_TOP) / 6;
const FONT = "Noto Sans Mono, monospace";
const LIME = "#ccff00";
const LIME_DIM = "#8ab300";
const RED = "#ff4444";
const BG = "#0d0f0a";
const TEXT = "#f0f5d8";
const MUTED = "#5a6340";

export async function renderPnlCalendarCard(calendar: PnlCalendarMonth, now = new Date()): Promise<Buffer> {
  const byDate = new Map(calendar.days.map((day) => [day.date, day]));
  const first = new Date(Date.UTC(calendar.year, calendar.month - 1, 1));
  const gridStart = new Date(first);
  gridStart.setUTCDate(first.getUTCDate() - first.getUTCDay());
  const today = now.toISOString().slice(0, 10);
  const title = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(first).toUpperCase();
  const winRate = calendar.closeCount === 0 ? "--" : `${((calendar.winCount * 100) / calendar.closeCount).toFixed(1)}%`;
  const svg: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<defs><pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M0 0H24V24" fill="none" stroke="#354013" stroke-opacity=".13"/></pattern></defs>`,
    `<rect width="${W}" height="${H}" fill="${BG}"/>`,
    `<rect width="${W}" height="${H}" fill="url(#grid)"/>`,
    `<text x="${PAD}" y="82" font-family="${FONT}" font-size="26" font-weight="bold" fill="${LIME}">UNILP GUARDIAN</text>`,
    `<text x="${PAD}" y="177" font-family="${FONT}" font-size="74" font-weight="bold" fill="${TEXT}">${title}</text>`,
    `<text x="${W - PAD}" y="92" font-family="${FONT}" font-size="23" fill="${MUTED}" text-anchor="end">REALIZED SETTLEMENTS · UTC</text>`,
    `<text x="${W - PAD}" y="164" font-family="${FONT}" font-size="26" fill="${TEXT}" text-anchor="end">MONTHLY PNL: <tspan fill="${calendar.pnlUsd >= 0n ? LIME : RED}">${formatUsd(calendar.pnlUsd)}</tspan>  ${calendar.activeDays} ACTIVE DAYS</text>`,
    `<text x="${W - PAD}" y="202" font-family="${FONT}" font-size="19" fill="${MUTED}" text-anchor="end">${calendar.closeCount} LP CLOSES · ${winRate} WIN RATE</text>`,
  ];

  for (const [index, label] of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].entries()) {
    svg.push(`<text x="${PAD + CELL_W * index + CELL_W / 2}" y="232" font-family="${FONT}" font-size="22" fill="${MUTED}" text-anchor="middle">${label}</text>`);
  }

  const weekly = new Array<bigint>(6).fill(0n);
  const activeByWeek = new Array<number>(6).fill(0);
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);
    const dateKey = date.toISOString().slice(0, 10);
    const day = byDate.get(dateKey);
    const row = Math.floor(index / 7);
    if (day) {
      weekly[row] = weekly[row]! + day.pnlUsd;
      activeByWeek[row] = activeByWeek[row]! + 1;
    }
    const x = PAD + (index % 7) * CELL_W;
    const y = GRID_TOP + row * CELL_H;
    const inMonth = date.getUTCMonth() === calendar.month - 1;
    const active = day !== undefined;
    const fill = !active ? "#10120d" : day.pnlUsd >= 0n ? "#10271c" : "#2a1111";
    const border = dateKey === today ? LIME : "#354013";
    svg.push(`<rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" fill="${fill}" fill-opacity="${inMonth ? 0.9 : 0.35}" stroke="${border}" stroke-width="${dateKey === today ? 3 : 1}"/>`);
    svg.push(`<text x="${x + CELL_W - 16}" y="${y + 29}" font-family="${FONT}" font-size="20" fill="${inMonth ? TEXT : MUTED}" text-anchor="end">${date.getUTCDate()}</text>`);
    if (day) renderDay(svg, x, y, day);
  }

  const railX = PAD + GRID_W + 28;
  svg.push(`<text x="${railX}" y="232" font-family="${FONT}" font-size="22" fill="${MUTED}">WEEK</text>`);
  for (let week = 0; week < 6; week += 1) {
    const y = GRID_TOP + week * CELL_H;
    const hasActivity = activeByWeek[week]! > 0;
    svg.push(`<line x1="${railX}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="#354013"/>`);
    svg.push(`<text x="${railX}" y="${y + 60}" font-family="${FONT}" font-size="25" fill="${TEXT}">WEEK ${week + 1}</text>`);
    svg.push(`<text x="${railX}" y="${y + 100}" font-family="${FONT}" font-size="25" font-weight="bold" fill="${weekly[week]! >= 0n ? LIME : RED}">${hasActivity ? formatUsd(weekly[week]!) : "$0.00"}</text>`);
    svg.push(`<text x="${railX}" y="${y + 132}" font-family="${FONT}" font-size="18" fill="${MUTED}">${activeByWeek[week]} active days</text>`);
  }
  svg.push(`<line x1="${railX}" y1="${GRID_BOTTOM}" x2="${W - PAD}" y2="${GRID_BOTTOM}" stroke="#354013"/>`);
  svg.push(`<text x="${W - PAD}" y="${H - 38}" font-family="${FONT}" font-size="18" fill="${MUTED}" text-anchor="end">GENERATED ${now.toISOString().replace("T", " ").slice(0, 19)} UTC</text>`);
  svg.push(`</svg>`);
  return sharp(Buffer.from(svg.join("\n"))).png().toBuffer();
}

function renderDay(svg: string[], x: number, y: number, day: PnlCalendarDay): void {
  const color = day.pnlUsd >= 0n ? LIME : RED;
  const rate = day.closeCount === 0 ? "--" : `${((day.winCount * 100) / day.closeCount).toFixed(1)}%`;
  svg.push(`<text x="${x + CELL_W / 2}" y="${y + 84}" font-family="${FONT}" font-size="24" font-weight="bold" fill="${color}" text-anchor="middle">${formatUsd(day.pnlUsd)}</text>`);
  svg.push(`<text x="${x + CELL_W / 2}" y="${y + 116}" font-family="${FONT}" font-size="17" fill="${TEXT}" text-anchor="middle">${day.closeCount} LP closes</text>`);
  svg.push(`<text x="${x + CELL_W / 2}" y="${y + 132}" font-family="${FONT}" font-size="17" fill="${TEXT}" text-anchor="middle">${rate} win rate</text>`);
}

function formatUsd(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const dollars = absolute / 1_000_000n;
  const cents = (absolute % 1_000_000n) / 10_000n;
  return `${negative ? "-$" : "+$"}${dollars}.${cents.toString().padStart(2, "0")}`;
}
