const SYMBOL_PATTERN = /^([A-Z0-9]{2,})_([A-Z0-9]{2,})$/;
const SYMBOL_IN_TEXT_PATTERN = /[A-Z0-9]{2,}\s*[_/-]\s*[A-Z0-9]{2,}/gi;

export function normalizeSymbol(value: string): string | null {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/\s*[_/-]\s*/g, "_")
    .replace(/_+/g, "_");

  return SYMBOL_PATTERN.test(normalized) ? normalized : null;
}

export function extractSymbols(value: string): string[] {
  const matches = value.match(SYMBOL_IN_TEXT_PATTERN) ?? [];
  return [...new Set(matches.map(normalizeSymbol).filter((symbol): symbol is string => symbol !== null))];
}

export function symbolFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const pathSegments = url.pathname.split("/").filter(Boolean).reverse();

    for (const segment of pathSegments) {
      const symbol = normalizeSymbol(decodeURIComponent(segment));
      if (symbol) return symbol;
    }
  } catch {
    return null;
  }

  return null;
}
