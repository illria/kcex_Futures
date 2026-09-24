// All selectors are conservative candidates and remain UNVERIFIED/DEFERRED
// until an explicitly approved manual KCEX review confirms the live DOM.
export const KCEX_SELECTORS = {
  accountMenu:
    '[data-testid="user-menu"], [data-testid="account-menu"], [aria-label="Account menu"], [aria-label="User menu"]',
  loginForm:
    'form[action*="login"], [data-testid="login-form"]',
  loginControl:
    'a[href*="login"], button[data-testid="login-button"], [aria-label*="log in"], [aria-label*="sign in"]',
  symbolLabel:
    '[data-testid="contract-symbol"], [data-testid="futures-symbol"], [data-testid="trading-pair"], [data-role="contract-symbol"], [aria-label="Current contract"], h1',
  accountInput:
    'input[name="email"], input[name="username"], input[autocomplete="username"], input[type="email"]',
  passwordInput:
    'input[name="password"], input[autocomplete="current-password"], input[type="password"]',
  loginSubmit:
    'button[type="submit"], [data-testid="login-submit"], [aria-label*="log in"], [aria-label*="sign in"]',
  otpInput:
    'input[name="code"], input[name="otp"], input[autocomplete="one-time-code"], input[data-testid="otp-input"]',
  otpSubmit:
    'button[type="submit"], [data-testid="otp-submit"], [aria-label*="verify"]',
  captcha:
    '[data-testid*="captcha"], [id*="captcha"], [class*="captcha"], [data-testid*="security-challenge"]',
  loginError:
    '[role="alert"], [data-testid="login-error"], [data-testid="auth-error"]',
} as const;
