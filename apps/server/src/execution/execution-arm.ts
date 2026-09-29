export const EXECUTION_ARM_ACKNOWLEDGEMENT = "ARM ASSISTED LIVE EXECUTION" as const;
export const DEFAULT_EXECUTION_ARM_TTL_MS = 5 * 60 * 1000;

export class ExecutionArmService {
  private armedUntilMs: number | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_EXECUTION_ARM_TTL_MS,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > DEFAULT_EXECUTION_ARM_TTL_MS) {
      throw new RangeError("Arm duration is outside the supported limit.");
    }
  }

  arm(acknowledgement: string): string {
    if (acknowledgement !== EXECUTION_ARM_ACKNOWLEDGEMENT) throw new Error("INVALID_ARM_ACKNOWLEDGEMENT");
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error("INVALID_CLOCK");
    this.armedUntilMs = now + this.ttlMs;
    return new Date(this.armedUntilMs).toISOString();
  }

  isArmed(): boolean {
    const now = this.now();
    if (!Number.isFinite(now)) {
      this.armedUntilMs = null;
      return false;
    }
    if (this.armedUntilMs === null || now >= this.armedUntilMs) {
      this.armedUntilMs = null;
      return false;
    }
    return true;
  }

  getArmedUntil(): string | null {
    return this.isArmed() && this.armedUntilMs !== null
      ? new Date(this.armedUntilMs).toISOString()
      : null;
  }

  consume(): boolean {
    const wasArmed = this.isArmed();
    this.armedUntilMs = null;
    return wasArmed;
  }

  disarm(): void {
    this.armedUntilMs = null;
  }
}
