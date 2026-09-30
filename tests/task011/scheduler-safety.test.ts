import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCHEDULER_ROOT = join(process.cwd(), "apps/server/src/scheduler");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("TASK-011 scheduler safety boundary", () => {
  it("contains no browser, network, KCEX, or exchange mutation capability", async () => {
    const files = await sourceFiles(SCHEDULER_ROOT);
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    const forbidden = [
      /playwright/i,
      /\bPage\b/,
      /locator\s*\(/i,
      /\.(?:click|fill|press)\s*\(/i,
      /placeOrder|cancelOrder|closePosition|setLeverage|setMarginMode|reduceOnly/i,
      /www\.kcex\.com/i,
      /\.(?:armRuntime|createPreview|confirm|submit)\s*\(/i,
      /fetch\s*\(|https?:\/\//i,
    ];
    for (const pattern of forbidden) expect(source).not.toMatch(pattern);
  });

  it("does not contain live trading or catch-up execution controls", async () => {
    const files = await sourceFiles(SCHEDULER_ROOT);
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/LIVE_TRADING\s*=\s*true/i);
    expect(source).not.toMatch(/executeNow|autoTrade|catchUp|forceClose|shiftSchedule/i);
  });
});
