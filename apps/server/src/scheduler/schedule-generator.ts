import { randomInt, randomUUID } from "node:crypto";
import { SchedulerSlotSchema, UtcDateKeySchema, type SchedulerSlot } from "../../../../packages/shared/src/scheduler.js";

export interface RandomSource {
  nextInt(minInclusive: number, maxExclusive: number): number;
}

export const cryptoRandomSource: RandomSource = Object.freeze({
  nextInt: (minInclusive: number, maxExclusive: number) => randomInt(minInclusive, maxExclusive),
});

export interface GeneratedDailySchedule {
  dateKey: string;
  dailyTarget: number;
  slots: SchedulerSlot[];
}

const BUCKETS_PER_DAY = 288;
const SPACING_BUCKETS = 6;
const BUCKET_MS = 5 * 60_000;

export function generateDailySchedule(
  dateKeyValue: string,
  createdAt: Date,
  random: RandomSource = cryptoRandomSource,
  idGenerator: () => string = randomUUID,
): GeneratedDailySchedule {
  const dateKey = UtcDateKeySchema.parse(dateKeyValue);
  if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) throw new RangeError("Scheduler creation clock is invalid.");
  const dailyTarget = drawInt(random, 1, 11);
  const compressedSize = BUCKETS_PER_DAY - (SPACING_BUCKETS - 1) * (dailyTarget - 1);
  if (compressedSize < dailyTarget) throw new RangeError("Daily target cannot fit the minimum slot spacing.");

  const compressedIndices = Array.from({ length: compressedSize }, (_value, index) => index);
  const selected: number[] = [];
  for (let index = 0; index < dailyTarget; index += 1) {
    const chosenIndex = drawInt(random, index, compressedSize);
    [compressedIndices[index], compressedIndices[chosenIndex]] = [compressedIndices[chosenIndex]!, compressedIndices[index]!];
    selected.push(compressedIndices[index]!);
  }
  selected.sort((left, right) => left - right);

  const midnight = Date.parse(`${dateKey}T00:00:00.000Z`);
  const createdTimestamp = createdAt.toISOString();
  const slots = selected.map((compressedIndex, slotIndex) => {
    const expandedIndex = compressedIndex + slotIndex * (SPACING_BUCKETS - 1);
    const dueAt = new Date(midnight + expandedIndex * BUCKET_MS).toISOString();
    return SchedulerSlotSchema.parse({
      id: idGenerator(),
      dateKey,
      slotIndex,
      symbol: "GPS_USDT",
      side: drawInt(random, 0, 2) === 0 ? "LONG" : "SHORT",
      dueAt,
      status: "SCHEDULED",
      executionAttemptId: null,
      completedAt: null,
      missedAt: null,
      missReason: null,
      createdAt: createdTimestamp,
      updatedAt: createdTimestamp,
      version: 1,
    });
  });
  return { dateKey, dailyTarget, slots };
}

function drawInt(random: RandomSource, minInclusive: number, maxExclusive: number): number {
  const value = random.nextInt(minInclusive, maxExclusive);
  if (!Number.isSafeInteger(value) || value < minInclusive || value >= maxExclusive) {
    throw new RangeError("Random source returned an out-of-range integer.");
  }
  return value;
}
