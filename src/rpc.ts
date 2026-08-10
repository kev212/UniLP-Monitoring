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
    if (code === 408 || code === 425 || code === 429 || code === 500 || code === 502 || code === 503 || code === 504 || code === -32005 || code === -32603) return true;
    if (typeof status === "number" && [408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  }

  const message = values.map((value) => String(value.message ?? "")).join(" ");
  return /\b(?:408|425|429|500|502|503|504)\b|too many requests|rate limit|timed out|timeout|aborted|econnreset|econnrefused|enotfound|network|fetch failed|service unavailable|gateway|unsupported block number|header not found|block(?:\s+number)?\s+(?:is\s+)?(?:not found|unavailable)|missing trie node/i.test(message);
}
