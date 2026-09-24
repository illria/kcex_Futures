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

export { TRUSTED_KCEX_HOSTNAME };
