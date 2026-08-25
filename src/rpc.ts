export function isTransientRpcError(error: unknown): boolean {
  const values: Array<{ code?: unknown; status?: unknown; message?: unknown }> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current !== "object") {
      values.push({ message: current });
      break;
    }
    const value = current as { code?: unknown; status?: unknown; message?: unknown; cause?: unknown };
    values.push(value);
    current = value.cause;
  }

  for (const value of values) {
    const code = value.code;
    const status = value.status;
    if (code === 408 || code === 425 || code === 429 || code === 500 || code === 502 || code === 503 || code === 504 || code === 520 || code === 521 || code === 522 || code === 523 || code === 524 || code === 525 || code === 526 || code === 527 || code === 530 || code === -32005 || code === -32603) return true;
    if (typeof status === "number" && [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530].includes(status)) return true;
  }

  const message = values.map((value) => String(value.message ?? "")).join(" ");
  return /\b(?:408|425|429|500|502|503|504|520|521|522|523|524|525|526|527|530)\b|too many requests|rate limit|timed out|timeout|aborted|econnreset|econnrefused|enotfound|network|fetch failed|service unavailable|gateway|origin (?:is )?(?:unreachable|down)|unsupported block number|header not found|block(?:\s+number)?\s+(?:is\s+)?(?:not found|unavailable)|missing trie node/i.test(message);
}

export function isRpcRateLimited(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current !== "object") {
      return /429|too many requests|rate.?limit/i.test(String(current));
    }
    const value = current as { code?: unknown; status?: unknown; message?: unknown; cause?: unknown };
    if (value.code === 429 || value.status === 429) return true;
    if (/429|too many requests|rate.?limit/i.test(String(value.message ?? ""))) return true;
    current = value.cause;
  }
  return false;
}
