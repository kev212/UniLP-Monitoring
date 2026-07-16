import type { PositionStatus } from "../types.js";

export function hasPendingSwap(metadata: Record<string, unknown>): boolean {
  const pending = metadata.pendingSwap;
  return Boolean(pending && typeof pending === "object" && !Array.isArray(pending));
}

export function hasPendingSettlement(status: PositionStatus, metadata: Record<string, unknown>): boolean {
  return status === "closing" || hasPendingSwap(metadata);
}
