import { StorageService } from "../../apps/server/src/storage/storage-service.js";
import type { CreateTradeInput } from "../../packages/shared/src/storage.js";

export async function createMemoryStorage(now?: () => Date): Promise<StorageService> {
  const storage = new StorageService({ databaseFile: ":memory:", now });
  await storage.initialize();
  return storage;
}

export function plannedTradeInput(overrides: Partial<CreateTradeInput> = {}): CreateTradeInput {
  return {
    symbol: "GPS_USDT",
    mode: "PAPER",
    side: "LONG",
    status: "PLANNED",
    ...overrides,
  };
}
