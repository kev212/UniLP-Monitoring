import pino from "pino";

function stripLevel(line: string): string {
  return line.replace(/"level":\d+,/, "");
}

function safeError(error: unknown): Record<string, unknown> {
  const value = error as { name?: unknown; code?: unknown; status?: unknown; message?: unknown } | undefined;
  const message = typeof value?.message === "string"
    ? value.message
      .replace(/https?:\/\/\S+/gi, "[URL]")
      .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
      .slice(0, 300)
    : undefined;
  return {
    ...(typeof value?.name === "string" ? { name: value.name } : {}),
    ...(typeof value?.code === "string" || typeof value?.code === "number" ? { code: value.code } : {}),
    ...(typeof value?.status === "number" ? { status: value.status } : {}),
    ...(message ? { message } : {}),
  };
}

export const log = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    base: undefined,
    timestamp: () => `,"time":"${new Date().toLocaleTimeString("en-GB", { hour12: false })}"`,
    formatters: {
      log(object) {
        // Upstream SDK errors can embed URLs or response bodies with credentials.
        const data = object as Record<string, unknown>;
        const error = data.err ?? data.error;
        delete data.err;
        delete data.error;
        if (error) data.error = safeError(error);
        return data;
      },
    },
    redact: {
      paths: ["privateKey", "EXECUTOR_PRIVATE_KEY", "telegramToken", "headers.authorization"],
      censor: "[REDACTED]",
    },
  },
  {
    write(line: string) {
      process.stdout.write(stripLevel(line) + "\n");
    },
    // eslint-disable-next-line @typescript-eslint/no-empty-function
  } as unknown as pino.DestinationStream,
);
