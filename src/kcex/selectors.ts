// These are conservative, read-only candidates. They must be confirmed against
// the live site during the deferred manual verification before relying on them.
export const KCEX_SELECTORS = {
  accountMenu:
    '[data-testid="user-menu"], [data-testid="account-menu"], [aria-label="Account menu"], [aria-label="User menu"]',
  loginForm:
    'form[action*="login"], [data-testid="login-form"]',
  loginControl:
    'a[href*="login"], button[data-testid="login-button"], [aria-label*="log in"], [aria-label*="sign in"]',
  symbolLabel:
    '[data-testid="contract-symbol"], [data-testid="futures-symbol"], [data-testid="trading-pair"], [data-role="contract-symbol"], [aria-label="Current contract"], h1',
} as const;
