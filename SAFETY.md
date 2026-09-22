# Safety Rules

This project can create real leveraged futures positions. Safety defaults are mandatory.

## Mandatory defaults

```
LIVE_TRADING=false
MAX_OPEN_POSITIONS=1
MAX_LEVERAGE=10
MAX_TRADES_PER_DAY=10
```

The exact production values remain user-configurable, but live trading must never auto-enable after restart.

## Hard blocks

The program must refuse to submit if any of the following is true:

- not logged in
- symbol is not in whitelist
- active page symbol does not equal requested symbol
- leverage does not match requested leverage
- margin mode does not match requested mode
- an unexpected open position exists
- balance is insufficient
- requested margin exceeds configured cap
- daily trade count cap reached
- daily loss cap reached
- kill switch is active
- previous order is in UNKNOWN state
- page structure cannot be confidently recognized
- captcha / anti-bot / security challenge is shown

## Unknown outcome rule

If the application clicks submit but cannot prove whether an order was accepted:

```
status = UNKNOWN
halt new entries
require manual inspection
```

Do not automatically try the same order again.

## Selector drift rule

If a critical selector fails, trading halts.

Do not fall back to blind clicking based on approximate screen coordinates.

## Live arming

Recommended final flow:

```
npm run start -- --live
```

Then require typed confirmation such as:

```
YES GPS_USDT 50USDT 10X
```

This confirmation should be runtime-only and never persisted.

## Kill switch

Support at least one simple local emergency mechanism:

```
data/KILL_SWITCH
```

If the file exists, new entries are blocked immediately.

## Audit evidence

For real order attempts save:

- timestamp
- requested side
- symbol
- leverage
- margin mode
- margin amount
- page state snapshot
- before screenshot
- after screenshot
- normalized result
- error or UNKNOWN reason
