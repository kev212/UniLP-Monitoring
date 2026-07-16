import pino from "pino";

function stripLevel(line: string): string {
  return line.replace(/"level":\d+,/, "");
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
        delete data.err;
        delete data.error;
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
