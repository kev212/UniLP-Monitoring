import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertEvaluationActive, childEvaluation, currentEvaluation, evaluationCacheKey,
  EvaluationCancelledError, evaluationWait, runEvaluation, withoutEvaluation,
} from "../src/services/evaluation-context.js";

afterEach(() => vi.useRealTimers());

describe("evaluation cancellation", () => {
  const context = (controller = new AbortController()) => ({
    id: "attempt-a", kind: "group" as const, entityId: "group-a",
    generation: "1", deadline: Date.now() + 60_000, signal: controller.signal,
  });

  it("expires a never-resolving operation without cooperative cancellation", async () => {
    vi.useFakeTimers();
    const ctx = context();
    const outcome = runEvaluation(ctx, () => evaluationWait(new Promise(() => {}))).catch(error => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome).toBeInstanceOf(EvaluationCancelledError);
  });

  it("prevents late continuations from treating an expired attempt as active", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const delayed = new Promise<void>(done => { resolve = done; });
    const effect = vi.fn();
    const ctx = context();
    const pending = runEvaluation(ctx, async () => {
      await delayed;
      assertEvaluationActive();
      effect();
    });
    const outcome = evaluationWait(pending, ctx).catch(error => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome).toBeInstanceOf(EvaluationCancelledError);
    resolve();
    await expect(pending).rejects.toBeInstanceOf(EvaluationCancelledError);
    expect(effect).not.toHaveBeenCalled();
  });

  it("expires optional work after 15s while the parent remains valid", async () => {
    vi.useFakeTimers();
    const parent = context();
    let childKey: string | undefined;
    const outcome = runEvaluation(parent, () => childEvaluation(15_000, async () => {
      childKey = evaluationCacheKey();
      expect(currentEvaluation()?.generation).toBe("1");
      return new Promise(() => {});
    })).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await outcome).toBeInstanceOf(EvaluationCancelledError);
    expect(childKey).not.toBe(parent.id);
    expect(() => assertEvaluationActive(parent)).not.toThrow();
  });

  it("keeps executor work detached even after the originating attempt aborts", async () => {
    const controller = new AbortController();
    await runEvaluation(context(controller), async () => {
      await withoutEvaluation(async () => {
        controller.abort();
        await Promise.resolve();
        expect(currentEvaluation()).toBeUndefined();
        expect(() => assertEvaluationActive()).not.toThrow();
      });
      expect(() => assertEvaluationActive()).toThrow(EvaluationCancelledError);
    });
  });

  it("invalidates late optional work without invalidating a retry", async () => {
    vi.useFakeTimers();
    const parent = context();
    let complete!: () => void;
    let late!: Promise<void>;
    const effect = vi.fn();
    const outcome = runEvaluation(parent, () => childEvaluation(15_000, () => {
      late = new Promise<void>(resolve => { complete = resolve; }).then(() => {
        assertEvaluationActive();
        effect();
      });
      return late;
    })).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await outcome).toBeInstanceOf(EvaluationCancelledError);
    await runEvaluation(parent, () => childEvaluation(15_000, async () => {
      assertEvaluationActive();
      return "retry";
    }));
    complete();
    await expect(late).rejects.toBeInstanceOf(EvaluationCancelledError);
    expect(effect).not.toHaveBeenCalled();
  });
});
