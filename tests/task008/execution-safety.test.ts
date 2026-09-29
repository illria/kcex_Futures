import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const executionRoot = join(process.cwd(), "apps/server/src/execution");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && /\.(?:ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  }));
  return paths.flat();
}

describe("TASK-008 execution mutation boundary", () => {
  it("contains no browser mutation API or direct KCEX request in the execution package", async () => {
    const patterns: Array<[string, RegExp]> = [
      ["Playwright dependency", /playwright/i],
      ["KCEX authentication adapter", /KcexAuthAdapter/],
      ["authenticated browser page source", /KcexAuthenticatedPageSource/],
      ["click", /\.click\s*\(/],
      ["fill", /\.fill\s*\(/],
      ["press", /\.press\s*\(/],
      ["type", /\.type\s*\(/],
      ["selectOption", /selectOption\s*\(/],
      ["locator", /locator\s*\(/],
      ["page interaction", /\bpage\s*\./],
      ["direct KCEX request", /fetch\s*\(\s*["'`]https:\/\/www\.kcex\.com/i],
    ];
    const paths = await sourceFiles(executionRoot);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const source = await readFile(path, "utf8");
      for (const [description, pattern] of patterns) {
        expect(source, `${relative(executionRoot, path)} must not contain ${description}`).not.toMatch(pattern);
      }
    }
  });
});
