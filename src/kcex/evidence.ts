import { KCEX_SELECTORS } from "./selectors.js";

export interface PageEvidence {
  url: string;
  visibleText: string;
  accountMenuVisible: boolean;
  loginFormVisible: boolean;
  loginControlVisible: boolean;
  symbolLabels: string[];
}

function isVisible(element: Element): boolean {
  let current: Element | null = element;

  while (current) {
    if (
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }

    const style = (current as HTMLElement).style;
    if (style?.display === "none" || style?.visibility === "hidden") {
      return false;
    }

    current = current.parentElement;
  }

  return true;
}

function collectVisibleText(document: Document): string {
  if (!document.body) return "";

  const nodeFilter = document.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = document.createTreeWalker(document.body, nodeFilter);
  const textNodes: string[] = [];
  let node = walker.nextNode();

  while (node) {
    if (node.parentElement && isVisible(node.parentElement)) {
      const text = node.textContent?.trim();
      if (text) textNodes.push(text);
    }
    node = walker.nextNode();
  }

  return textNodes.join(" ");
}

function anyVisible(document: Document, selector: string): boolean {
  try {
    return Array.from(document.querySelectorAll(selector)).some(isVisible);
  } catch {
    return false;
  }
}

function visibleTexts(document: Document, selector: string): string[] {
  try {
    return Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .map((element) => element.textContent?.trim() ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function collectPageEvidence(
  document: Document,
  url: string,
): PageEvidence {
  return {
    url,
    visibleText: collectVisibleText(document),
    accountMenuVisible: anyVisible(document, KCEX_SELECTORS.accountMenu),
    loginFormVisible: anyVisible(document, KCEX_SELECTORS.loginForm),
    loginControlVisible: anyVisible(document, KCEX_SELECTORS.loginControl),
    symbolLabels: visibleTexts(document, KCEX_SELECTORS.symbolLabel),
  };
}
