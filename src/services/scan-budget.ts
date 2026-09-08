/** One deadline covers queueing, network reads and result assembly. */
export class ScanBudget {
  readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(readonly deadline: number) {
    this.timer = setTimeout(() => this.controller.abort(), Math.max(0, deadline - Date.now()));
    if (deadline <= Date.now()) this.controller.abort();
  }

  check(): void {
    if (Date.now() >= this.deadline && !this.signal.aborted) this.controller.abort();
    this.signal.throwIfAborted();
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    let onAbort: () => void = () => {};
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new DOMException('Scan deadline reached', 'AbortError'));
          this.signal.addEventListener('abort', onAbort, { once: true });
          if (this.signal.aborted) onAbort();
        }),
      ]);
    } finally {
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  async delay(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await this.run(() => new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })); }
    finally { clearTimeout(timer); }
  }

  close(): void { clearTimeout(this.timer); this.controller.abort(); }
}

/** Retain a slot until an uncancellable RPC actually settles, even after the caller times out. */
export class ScanSlots {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(budget: ScanBudget, work: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) {
      let wake: () => void = () => {};
      try { await budget.run(() => new Promise<void>(resolve => { wake = resolve; this.waiters.push(wake); })); }
      finally { const i = this.waiters.indexOf(wake); if (i >= 0) this.waiters.splice(i, 1); }
    }
    budget.check();
    this.active++;
    const pending = Promise.resolve().then(work).finally(() => {
      this.active--;
      // Wake everyone; each must re-check capacity before taking the slot.
      this.waiters.splice(0).forEach(wake => wake());
    });
    void pending.catch(() => {});
    return budget.run(() => pending);
  }
}
