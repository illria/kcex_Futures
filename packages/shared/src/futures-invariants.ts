import type { KcexFuturesSnapshot } from "./protocol.js";

/**
 * A futures snapshot is a single read transaction. Mixing fixture and KCEX
 * children would make the dashboard appear more authoritative than its data.
 */
export function assertFuturesSourceConsistency(snapshot: KcexFuturesSnapshot): KcexFuturesSnapshot {
  const sources = [
    snapshot.market.source,
    snapshot.account.source,
    snapshot.contract.source,
    snapshot.position.source,
    snapshot.openOrders.source,
    ...snapshot.openOrders.orders.map((order) => order.source),
  ];
  if (sources.some((source) => source !== snapshot.source)) {
    throw new Error("Futures snapshot contains mixed data sources.");
  }
  return snapshot;
}
