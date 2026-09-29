import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const executionRoot = join(process.cwd(), "apps/server/src/execution");

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return entry.isFile() && /\.(?:ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

describe("TASK-009 confirmation safety boundary", () => {
  it("keeps confirmation fixture-only and free of browser or mutation APIs", async () => {
    const forbidden: Array<[string, RegExp]> = [
      ["Playwright", /playwright/i],
      ["KCEX auth adapter", /KcexAuthAdapter/],
      ["browser Page", /\bPage\b/],
      ["locator", /locator\s*\(/],
      ["click", /\.click\s*\(/],
      ["fill", /\.fill\s*\(/],
      ["press", /\.press\s*\(/],
      ["type", /\.type\s*\(/],
      ["check", /\.check\s*\(/],
      ["uncheck", /\.uncheck\s*\(/],
      ["selectOption", /selectOption\s*\(/],
      ["setInputFiles", /setInputFiles\s*\(/],
      ["drag", /\.drag\s*\(/],
      ["placeOrder", /placeOrder\s*\(/i],
      ["cancelOrder", /cancelOrder\s*\(/i],
      ["closePosition", /closePosition\s*\(/i],
      ["setLeverage", /setLeverage\s*\(/i],
      ["setMarginMode", /setMarginMode\s*\(/i],
      ["direct exchange request", /fetch\s*\(\s*["'`]https:\/\//i],
      ["KCEX host", /www\.kcex\.com/i],
      ["axios", /\baxios\b/i],
      ["undici", /\bundici\b/i],
    ];
    const paths = await collectSourceFiles(executionRoot);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const source = await readFile(path, "utf8");
      for (const [name, pattern] of forbidden) {
        expect(source, `${relative(executionRoot, path)} must not contain ${name}`).not.toMatch(pattern);
      }
    }
  });
});
