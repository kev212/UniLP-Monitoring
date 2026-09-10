import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface EvaluationContext {
  readonly id: string;
  readonly kind: "position" | "group";
  readonly entityId: string;
  generation?: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
  stage?: string;
}

const evaluations = new AsyncLocalStorage<EvaluationContext | undefined>();

export class EvaluationCancelledError extends Error {
  constructor(message = "monitoring evaluation expired or cancelled") {
    super(message);
    this.name = "EvaluationCancelledError";
  }
}

export function currentEvaluation(): EvaluationContext | undefined {
  return evaluations.getStore();
}

export function assertEvaluationActive(context = currentEvaluation()): void {
  if (context && (context.signal.aborted || Date.now() >= context.deadline)) {
    throw new EvaluationCancelledError();
  }
}

export function runEvaluation<T>(context: EvaluationContext, work: () => T): T {
  assertEvaluationActive(context);
  return evaluations.run(context, work);
}

// A transaction handed to the executor has its own lease and recovery lifecycle.
export function withoutEvaluation<T>(work: () => T): T {
  return evaluations.run(undefined, work);
}

export function evaluationCacheKey(): string {
  return currentEvaluation()?.id ?? "shared";
}

export function combinedEvaluationSignal(timeoutMs: number): AbortSignal {
  const context = currentEvaluation();
  assertEvaluationActive(context);
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(context
    ? Math.min(timeoutMs, context.deadline - Date.now()) : timeoutMs)));
  return context ? AbortSignal.any([context.signal, timeout]) : timeout;
}

/** A deadline must work even when a dependency ignores AbortSignal. */
export async function evaluationWait<T>(pending: Promise<T>, context = currentEvaluation()): Promise<T> {
  // Attach a rejection handler even if the context has already expired.
  void pending.catch(() => {});
  if (!context) return pending;
  assertEvaluationActive(context);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        abort = () => reject(new EvaluationCancelledError());
        context.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(abort, Math.max(0, context.deadline - Date.now()));
        if (context.signal.aborted) abort();
      }),
    ]);
    assertEvaluationActive(context);
    return result;
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", abort);
  }
}

/** Optional work expires independently, without cancelling the parent evaluation. */
export async function childEvaluation<T>(timeoutMs: number, work: () => Promise<T>): Promise<T> {
  const parent = currentEvaluation();
  const controller = new AbortController();
  const abort = () => controller.abort();
  assertEvaluationActive(parent);
  parent?.signal.addEventListener("abort", abort, { once: true });
  const context: EvaluationContext = {
    id: randomUUID(),
    kind: parent?.kind ?? "position",
    entityId: parent?.entityId ?? "",
    generation: parent?.generation,
    deadline: Math.min(parent?.deadline ?? Infinity, Date.now() + timeoutMs),
    signal: controller.signal,
  };
  try {
    return await runEvaluation(context, () => evaluationWait(Promise.resolve().then(work), context));
  } finally {
    controller.abort();
    parent?.signal.removeEventListener("abort", abort);
  }
}
