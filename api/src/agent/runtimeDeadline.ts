export const MAX_RUNTIME_GUARDRAIL = "maxRuntimeSecPerRun";

export class AgentRuntimeDeadlineExceededError extends Error {
  constructor(
    public readonly phase: string,
    public readonly maxRuntimeSec: number,
    public readonly elapsedMs: number
  ) {
    super(`Agent runtime exceeded ${MAX_RUNTIME_GUARDRAIL} during ${phase}.`);
    this.name = "AgentRuntimeDeadlineExceededError";
  }
}

export class AgentRuntimeDeadline {
  private readonly startedAtMs = Date.now();
  private readonly expiresAtMs: number;
  private readonly controller = new AbortController();

  constructor(public readonly maxRuntimeSec: number) {
    const boundedSeconds = Number.isFinite(maxRuntimeSec) && maxRuntimeSec > 0
      ? Math.trunc(maxRuntimeSec)
      : 1;
    this.expiresAtMs = this.startedAtMs + Math.max(1, boundedSeconds) * 1000;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  remainingMs(): number {
    return Math.max(0, this.expiresAtMs - Date.now());
  }

  throwIfExpired(phase: string): void {
    if (this.remainingMs() > 0 && !this.controller.signal.aborted) {
      return;
    }
    const error = this.errorForPhase(phase);
    this.abort(error);
    throw error;
  }

  async run<T>(phase: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.throwIfExpired(phase);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = this.errorForPhase(phase);
        this.abort(error);
        reject(error);
      }, this.remainingMs());
      if (typeof timeout === "object" && "unref" in timeout && typeof timeout.unref === "function") {
        timeout.unref();
      }
    });

    try {
      return await Promise.race([
        action(this.controller.signal),
        timeoutPromise
      ]);
    } catch (error) {
      if (this.controller.signal.aborted && isAbortLikeError(error)) {
        throw this.errorForPhase(phase);
      }
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private abort(reason: AgentRuntimeDeadlineExceededError): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }
  }

  private errorForPhase(phase: string): AgentRuntimeDeadlineExceededError {
    return new AgentRuntimeDeadlineExceededError(
      phase,
      this.maxRuntimeSec,
      Date.now() - this.startedAtMs
    );
  }
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybe = error as { name?: unknown; code?: unknown };
  return maybe.name === "AbortError" || maybe.code === "ABORT_ERR";
}
