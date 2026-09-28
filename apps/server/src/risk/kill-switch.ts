import { lstat } from "node:fs/promises";
import type { KillSwitchStatus } from "../../../../packages/shared/src/risk.js";

export class KillSwitchService {
  constructor(readonly filePath: string) {}

  /** Presence is sufficient; file contents are never opened or interpreted. */
  async getStatus(): Promise<KillSwitchStatus> {
    try {
      await lstat(this.filePath);
      return "ENGAGED";
    } catch (error) {
      if (isMissingPath(error)) return "CLEAR";
      return "UNKNOWN";
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
