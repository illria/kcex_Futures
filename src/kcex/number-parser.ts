/**
 * Parse one plainly displayed number without guessing from surrounding text.
 * Financial values that do not match this narrow grammar remain null.
 */
export function parseStrictNumeric(value: string | null | undefined): number | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (!/^[+-]?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?(?:\s*(?:x|usdt))?$/i.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized.replace(/,/g, "").replace(/\s*(?:x|usdt)$/i, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
