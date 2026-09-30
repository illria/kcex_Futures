# TASK-013 Live Launch Checklist

This checklist is an acceptance record, not an authorization to trade. Complete read-only verification first. The user alone starts the one-time Canary after code review. Keep the app stopped until that checkpoint is explicitly approved.

## Platform and authentication

- [ ] Platform automation authorization confirmed for the account and region
- [ ] KCEX host is exactly `https://www.kcex.com`
- [ ] Password login verified
- [ ] Email OTP verified
- [ ] Manual Google OAuth verified; no Google credentials stored or automated
- [ ] Encrypted KCEX-origin session persistence verified
- [ ] Restart restores only read access and leaves Auto Live `DISARMED`
- [ ] CAPTCHA, 2FA, security challenge, session loss, and UNKNOWN stop for manual action

## Read-only GPS_USDT verification

- [ ] Login marker and account marker
- [ ] GPS_USDT symbol
- [ ] Last price, mark price, and available USDT presence
- [ ] Margin mode and leverage evidence
- [ ] Open-position and empty-position evidence
- [ ] Open-orders and empty-orders evidence
- [ ] Market order tab and LONG/SHORT controls
- [ ] Margin and quantity input controls
- [ ] Isolated and leverage controls
- [ ] Order submit/rejection evidence selectors
- [ ] TP/SL controls and protective-order evidence
- [ ] Report contains only allowed selector IDs, numeric contract metadata, and check status

## Verified contract profile

- [ ] GPS_USDT quantity unit is confirmed: USDT, GPS, or contract
- [ ] Contract size (when contract-denominated), quantity step, min/max quantity, and quantity precision
- [ ] Min/max notional limits (when presented) and allowed notional deviation
- [ ] Price precision and tick size
- [ ] ISOLATED and 10x control semantics
- [ ] MARKET order semantics
- [ ] TP/SL target-price or ROI semantics
- [ ] Position confirmation tolerance verified

## Canary and Auto Live

- [ ] Kill Switch clear
- [ ] RiskEngine limits and daily-loss/failure guards pass
- [ ] Resilience HEALTHY, storage READY, fresh authenticated read
- [ ] Flat position, no open orders, no unresolved execution or protection
- [ ] User explicitly enters Canary side and margin
- [ ] Canary preview reviewed and exact confirmation entered by the user
- [ ] One real entry confirmed from fresh position evidence
- [ ] Real protection evidence confirms both TP and SL
- [ ] UNKNOWN handling and manual recovery confirmed
- [ ] Canary is marked PASS; no retry is available
- [ ] User reviews the separate Auto Live gates and enters `START KCEX LIVE AUTO`
- [ ] Stop Live Automation prevents future entries without closing the open position

## Current status

- Code review: pending GitHub Actions and human review
- Manual KCEX verification: NOT RUN
- Canary: NOT RUN
- Launch: NOT READY
