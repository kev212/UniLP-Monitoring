import type { Log, PublicClient } from "viem";

import { isTransientRpcError } from "../rpc.js";

const MAX_GET_LOGS_ATTEMPTS = 5;

let lastGetLogsAt = 0;
let getLogsTail: Promise<unknown> = Promise.resolve();

export function isLogRangeError(error: unknown): boolean {
  const message = collectErrorText(error);
  return /query returned more than|query exceeds|block range is too (?:large|wide)|too many results|response size|eth_getLogs.*range|log response size exceeded|range limit/i.test(message);
}

export async function getLogsChunked(
  client: PublicClient,
  params: { fromBlock: bigint; toBlock: bigint; [key: string]: unknown },
  options: { maxBlockRange: bigint; delayMs: number },
): Promise<Log[]> {
  const all: Log[] = [];
  let start = params.fromBlock;
  const end = params.toBlock;
  while (start <= end) {
    const windowEnd = minBigInt(end, start + options.maxBlockRange - 1n);
    const page = await getLogsAdaptive(client, { ...params, fromBlock: start, toBlock: windowEnd }, options.delayMs);
    all.push(...page);
    if (windowEnd >= end) break;
    start = windowEnd + 1n;
  }
  return all;
}

async function getLogsAdaptive(
  client: PublicClient,
  params: { fromBlock: bigint; toBlock: bigint; [key: string]: unknown },
  delayMs: number,
): Promise<Log[]> {
  try {
    return await throttledGetLogs(client, params as Parameters<PublicClient["getLogs"]>[0], delayMs);
  } catch (error) {
    if (!isLogRangeError(error) || params.fromBlock >= params.toBlock) throw error;
    const mid = params.fromBlock + ((params.toBlock - params.fromBlock) / 2n);
    const left = await getLogsAdaptive(client, { ...params, toBlock: mid }, delayMs);
    const right = await getLogsAdaptive(client, { ...params, fromBlock: mid + 1n }, delayMs);
    return [...left, ...right];
  }
}

async function throttledGetLogs(
  client: PublicClient,
  params: Parameters<PublicClient["getLogs"]>[0],
  delayMs: number,
): Promise<Log[]> {
  const run = getLogsTail.then(async () => {
    const elapsed = Date.now() - lastGetLogsAt;
    if (delayMs > 0 && elapsed < delayMs) await sleep(delayMs - elapsed);
    lastGetLogsAt = Date.now();
    return getLogsWithRetry(client, params);
  });
  getLogsTail = run.then(() => undefined, () => undefined);
  return run;
}

async function getLogsWithRetry(client: PublicClient, params: Parameters<PublicClient["getLogs"]>[0]): Promise<Log[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_GET_LOGS_ATTEMPTS; attempt += 1) {
    try {
      return await withGetLogsTimeout(client.getLogs(params) as Promise<Log[]>, 8_000);
    } catch (error) {
      lastError = error;
      const text = collectErrorText(error);
      if (isLogRangeError(error) || text.includes("eth_getLogs timed out") || !isTransientRpcError(error)) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    const value = current as { message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };
    parts.push(String(value.message ?? ""), String(value.shortMessage ?? ""), String(value.details ?? ""));
    current = value.cause;
  }
  return parts.join(" ");
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withGetLogsTimeout(promise: Promise<Log[]>, timeoutMs: number): Promise<Log[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<Log[]>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`eth_getLogs timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
