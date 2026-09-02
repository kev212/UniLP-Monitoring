import type { PositionStatus } from "../types.js";

export function hasPendingSwap(metadata: Record<string, unknown>): boolean {
  const pending = metadata.pendingSwap;
  return Boolean(pending && typeof pending === "object" && !Array.isArray(pending));
}

export function hasPendingSettlement(status: PositionStatus, metadata: Record<string, unknown>): boolean {
  if (status === "settled") return false;
  const phase = metadata.settlementPhase;
  const hasPendingPhase = phase === "removing_liquidity"
    || phase === "pending_swap"
    || phase === "accounting"
    || phase === "unwrapping_quote";
  return status === "closing" || hasPendingSwap(metadata) || hasPendingPhase;
}
