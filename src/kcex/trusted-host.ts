const TRUSTED_KCEX_HOSTNAME = "www.kcex.com";

export function isTrustedKcexUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === TRUSTED_KCEX_HOSTNAME &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.port.length === 0
    );
  } catch {
    return false;
  }
}

export function assertTrustedKcexUrl(value: string): void {
  if (!isTrustedKcexUrl(value)) {
    throw new Error("KCEX credential operations require the confirmed official KCEX host.");
  }
}

/**
 * The configured KCEX base URL is a stronger boundary than a page URL. It
 * must identify the confirmed origin itself, with no path, query, fragment,
 * port, or embedded credentials that could redirect credential autofill.
 */
export function isTrustedKcexBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return isTrustedKcexUrl(value) && url.pathname === "/" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

export function assertTrustedKcexBaseUrl(value: string): void {
  if (!isTrustedKcexBaseUrl(value)) {
    throw new Error("KCEX_BASE_URL must be exactly the confirmed official KCEX origin.");
  }
}

export { TRUSTED_KCEX_HOSTNAME };
