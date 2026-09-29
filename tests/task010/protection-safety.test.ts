import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const protectionRoot = join(process.cwd(), "apps/server/src/protection");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.isFile() && /\.(?:ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

describe("TASK-010 fixture protection mutation boundary", () => {
  it("contains no browser interaction, live writer, network client, or exchange host", async () => {
    const patterns: Array<[string, RegExp]> = [
      ["Playwright", /playwright/i],
      ["browser Page type", /\bPage\b/],
      ["locator", /locator\s*\(/],
      ["click", /\.click\s*\(/],
      ["fill", /\.fill\s*\(/],
      ["press", /\.press\s*\(/],
      ["type", /\.type\s*\(/],
      ["selectOption", /selectOption\s*\(/],
      ["setInputFiles", /setInputFiles\s*\(/],
      ["order placement", /placeOrder\s*\(/],
      ["order cancellation", /cancelOrder\s*\(/],
      ["position close", /closePosition\s*\(/],
      ["leverage mutation", /setLeverage\s*\(/],
      ["margin mode mutation", /setMarginMode\s*\(/],
      ["reduce-only writer", /reduceOnly/i],
      ["KCEX host", /www\.kcex\.com/i],
      ["axios", /\baxios\b/i],
      ["undici", /\bundici\b/i],
      ["external fetch", /fetch\s*\(\s*["']https:\/\//i],
    ];
    const paths = await sourceFiles(protectionRoot);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const source = await readFile(path, "utf8");
      for (const [name, pattern] of patterns) {
        expect(source, relative(protectionRoot, path) + " must not contain " + name).not.toMatch(pattern);
      }
    }
  });
});
