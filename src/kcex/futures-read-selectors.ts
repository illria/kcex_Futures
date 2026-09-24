// Every selector below is UNVERIFIED / DEFERRED MANUAL VERIFICATION. They are
// fixture-oriented read candidates only; no live KCEX DOM claim is made here.
export const KCEX_FUTURES_READ_SELECTORS = {
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  symbol: '[data-testid="contract-symbol"], [data-testid="futures-symbol"], [data-role="contract-symbol"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  lastPrice: '[data-testid="last-price"], [data-role="last-price"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  markPrice: '[data-testid="mark-price"], [data-role="mark-price"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  availableUsdt: '[data-testid="available-usdt"], [data-role="available-usdt"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  marginMode: '[data-testid="margin-mode"], [data-role="margin-mode"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  leverage: '[data-testid="leverage"], [data-role="leverage"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  positionContainer: '[data-testid="position-container"], [data-role="position-container"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  positionSide: '[data-testid="position-side"], [data-role="position-side"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  positionEntry: '[data-testid="position-entry"], [data-role="position-entry"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  positionSize: '[data-testid="position-size"], [data-role="position-size"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  positionUnrealizedPnl: '[data-testid="position-unrealized-pnl"], [data-role="position-unrealized-pnl"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  positionEmpty: '[data-testid="no-position"], [data-role="no-position"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  openOrdersTable: '[data-testid="open-orders-table"], [data-role="open-orders-table"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  openOrderRows: '[data-testid="open-order-row"], [data-role="open-order-row"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  openOrdersEmpty: '[data-testid="open-orders-empty"], [data-role="open-orders-empty"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  openOrderSide: '[data-testid="order-side"], [data-role="order-side"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  openOrderType: '[data-testid="order-type"], [data-role="order-type"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  openOrderPrice: '[data-testid="order-price"], [data-role="order-price"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  openOrderQuantity: '[data-testid="order-quantity"], [data-role="order-quantity"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  openOrderFilled: '[data-testid="order-filled"], [data-role="order-filled"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  openOrderReduceOnly: '[data-testid="order-reduce-only"], [data-role="order-reduce-only"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION
  openOrderStatus: '[data-testid="order-status"], [data-role="order-status"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION; inherited auth candidates.
  captcha: '[data-testid*="captcha"], [id*="captcha"], [class*="captcha"], [data-testid*="security-challenge"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION; inherited auth candidates.
  loginForm: 'form[action*="login"], [data-testid="login-form"]',
  // UNVERIFIED / DEFERRED MANUAL VERIFICATION; inherited auth candidates.
  loginControl: 'a[href*="login"], button[data-testid="login-button"], [aria-label*="log in"], [aria-label*="sign in"]',
} as const;
