import { describe, expect, it } from "vitest";
import { parseStrictNumeric } from "../../src/kcex/number-parser.js";

describe("strict futures number parser", () => {
  it.each([
    ["0.012345", 0.012345],
    ["1,234.56", 1234.56],
    ["10x", 10],
    ["50.23 USDT", 50.23],
    ["+12.45", 12.45],
    ["-3.18", -3.18],
  ])("parses %s", (value, expected) => {
    expect(parseStrictNumeric(value)).toBe(expected);
  });

  it.each(["", "--", "N/A", "-", "NaN", "Infinity", "Leverage max 125x / current 10x", "12 apples"]) (
    "rejects %s without guessing",
    (value) => expect(parseStrictNumeric(value)).toBeNull(),
  );
});
