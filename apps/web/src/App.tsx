import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { FAKE_OTP_CODE } from "../../../packages/shared/src/fake-auth.js";
import { createFakeDashboardSnapshot } from "../../../packages/shared/src/fake-snapshot.js";
import { applySnapshotFreshness } from "../../../packages/shared/src/freshness.js";
import {
  AuthStateSchema,
  DashboardSnapshotSchema,
  MASTER_KEY_MIN_LENGTH,
  parseDashboardEvent,
  type AuthState,
  type DashboardEvent,
  type DashboardSnapshot,
  type KcexFuturesSnapshot,
} from "../../../packages/shared/src/protocol.js";
import { RiskStateSchema, type RiskState } from "../../../packages/shared/src/risk.js";
import {
  AssistedExecutionStateSchema,
  ExecutionPreviewResponseSchema,
  type AssistedExecutionState,
  type AssistedLivePreview,
} from "../../../packages/shared/src/execution.js";
import type { PaperTradingState } from "../../../packages/shared/src/paper-trading.js";

interface ApiError extends Error {
  status?: number;
}

/**
 * Apply the complete reader event as one dashboard state transition. Keeping
 * the child snapshots together prevents a first KCEX event from leaving a
 * MOCK parent with KCEX financial children.
 */
export function applyFuturesSnapshotToDashboard(
  current: DashboardSnapshot,
  futures: KcexFuturesSnapshot,
): DashboardSnapshot {
  return DashboardSnapshotSchema.parse({
    ...current,
    futures,
    market: futures.market,
    account: futures.account,
    contract: futures.contract,
    position: futures.position,
    openOrders: futures.openOrders,
  });
}

type FuturesReadHealthPayload = Extract<DashboardEvent, { type: "futures.read-health" }>["payload"];

/**
 * Reader health is runtime state. It may arrive before the first financial
 * snapshot, so it intentionally has no source-matching guard and never edits
 * the cached financial snapshot.
 */
export function applyReadHealthToDashboard(
  current: DashboardSnapshot,
  payload: FuturesReadHealthPayload,
): DashboardSnapshot {
  return DashboardSnapshotSchema.parse({
    ...current,
    status: {
      ...current.status,
      readHealth: payload.health,
      browser: payload.browserStatus,
    },
  });
}

export function applyPaperStateToDashboard(
  current: DashboardSnapshot,
  paper: PaperTradingState,
): DashboardSnapshot {
  return DashboardSnapshotSchema.parse({ ...current, paper });
}

export function applyRiskStateToDashboard(current: DashboardSnapshot, risk: RiskState): DashboardSnapshot {
  return DashboardSnapshotSchema.parse({
    ...current,
    risk,
    status: { ...current.status, killSwitch: risk.killSwitch },
  });
}

export function applyExecutionStateToDashboard(
  current: DashboardSnapshot,
  execution: AssistedExecutionState,
): DashboardSnapshot {
  return DashboardSnapshotSchema.parse({ ...current, execution: AssistedExecutionStateSchema.parse(execution) });
}

type RiskBlockedPayload = Extract<DashboardEvent, { type: "risk.blocked" }>;

export function applyRiskBlockedToDashboard(
  current: DashboardSnapshot,
  payload: RiskBlockedPayload["payload"],
): DashboardSnapshot {
  const risk = RiskStateSchema.parse({
    ...current.risk,
    status: current.risk.status === "HALTED" ? "HALTED" : "BLOCKED",
    reasons: payload.reasons,
    updatedAt: current.risk.updatedAt,
  });
  return applyRiskStateToDashboard(current, risk);
}

/**
 * Materialize display freshness without changing the immutable read time.
 * A KCEX placeholder stays UNKNOWN until a real KCEX snapshot is received;
 * PARTIAL data ages normally, while UNKNOWN and STOPPED cached data is stale.
 */
export function materializeDashboardFuturesForDisplay(
  snapshot: DashboardSnapshot,
  authProvider: AuthState['authProvider'],
  now: Date | number | string = Date.now(),
): KcexFuturesSnapshot {
  const futures = snapshot.futures;
  if (authProvider === "KCEX" && futures.source !== "KCEX") return futures;
  const forceStale = futures.source === "KCEX"
    && (snapshot.status.browser === "STOPPED" || snapshot.status.readHealth === "UNKNOWN");
  return applySnapshotFreshness(futures, now, { forceStale });
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
      cache: "no-store",
    });
  } catch {
    throw new Error("Cannot reach the local dashboard service.");
  }

  if (!response.ok) {
    const error = new Error(
      response.status === 401
        ? "The local unlock key was not accepted."
        : response.status === 423
          ? "Unlock the vault before continuing."
          : "The local request could not be completed.",
    ) as ApiError;
    error.status = response.status;
    throw error;
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("The local service returned an invalid response.");
  }
}

export function DashboardView({
  snapshot,
  auth,
  webSocketConnected,
  onExecutionStateChange,
}: {
  snapshot: DashboardSnapshot;
  auth: AuthState;
  webSocketConnected: boolean;
  onExecutionStateChange?: (state: AssistedExecutionState) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const futures = materializeDashboardFuturesForDisplay(snapshot, auth.authProvider, now);
  const sourceLabel = futures.source === "KCEX" ? "LIVE READ-ONLY" : "FIXTURE";
  const formatNumber = (value: number | null, digits = 5): string => value === null ? "—" : value.toFixed(digits);
  const formatSigned = (value: number | null): string => value === null ? "—" : `${value.toFixed(2)} USDT`;
  return (
    <main className="dashboard">
      <section className="status-grid" aria-label="Runtime status">
        <StatusTile
          label="KCEX"
          value={auth.status === "AUTHENTICATED" ? `${auth.authProvider} Authenticated` : auth.status}
        />
        <StatusTile label="Browser" value={snapshot.status.browser} />
        <StatusTile label="Mode" value={snapshot.status.mode} />
        <StatusTile label="Trading" value={snapshot.status.trading} />
        <StatusTile label="Kill Switch" value={snapshot.status.killSwitch} />
        <StatusTile label="Read Health" value={snapshot.status.readHealth} />
        <StatusTile label="Freshness" value={futures.freshness} />
        <StatusTile label="Storage" value={snapshot.status.storage} />
      </section>

      <section className="panel risk-panel" aria-label="Risk Controls">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">RISK CONTROLS · READ ONLY</p>
            <h2>Risk Controls</h2>
          </div>
          <span className="source-tag">{snapshot.risk.status}</span>
        </div>
        <div className="metric-grid four">
          <Metric label="Risk Status" value={snapshot.risk.status} />
          <Metric label="Kill Switch" value={snapshot.risk.killSwitch} />
          <Metric label="Max Margin" value={`${snapshot.risk.limits.maxMarginUsdt.toFixed(2)} USDT`} />
          <Metric label="Max Leverage" value={`${snapshot.risk.limits.maxLeverage}x`} />
          <Metric label="Daily Entries" value={`${displayCount(snapshot.risk.metrics.dailyOpenedTrades)} / ${snapshot.risk.limits.maxDailyTrades}`} />
          <Metric label="Daily Realized Loss" value={`${displayMoney(snapshot.risk.metrics.dailyRealizedLossUsdt)} / ${snapshot.risk.limits.maxDailyLossUsdt.toFixed(2)} USDT`} />
          <Metric label="Consecutive Failures" value={`${displayCount(snapshot.risk.metrics.consecutiveFailures)} / ${snapshot.risk.limits.maxConsecutiveFailures}`} />
          <Metric label="Scope" value={snapshot.risk.metrics.mode} />
        </div>
        <p className="muted-note">
          Block reasons: {snapshot.risk.reasons.length ? snapshot.risk.reasons.join(", ") : "None"}
        </p>
        <p className="safety-note">LIVE_TRADING=false · Risk state is read only.</p>
      </section>

      <div className="stream-state" role="status">
        WebSocket: {webSocketConnected ? "CONNECTED" : "DISCONNECTED"} · {sourceLabel} · Provider: {auth.authProvider}
      </div>

      <AssistedExecutionPanel
        execution={snapshot.execution}
        risk={snapshot.risk}
        onExecutionStateChange={onExecutionStateChange}
      />

      <section className="panel market-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Market snapshot · {futures.market.health} · {futures.market.freshness}</p>
            <h2>{futures.symbol}</h2>
          </div>
          <span className="source-tag">{sourceLabel}</span>
        </div>
        <div className="metric-grid two">
          <Metric label="Last Price" value={formatNumber(futures.market.lastPrice)} />
          <Metric label="Mark Price" value={formatNumber(futures.market.markPrice)} />
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Account · {futures.account.health}</p>
        <div className="metric-grid three">
          <Metric label="Available USDT" value={formatNumber(futures.account.availableUsdt, 2)} suffix="USDT" />
          <Metric label="Margin Mode" value={futures.contract.marginMode} />
          <Metric label="Leverage" value={futures.contract.leverage === null ? "—" : `${futures.contract.leverage}x`} />
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">KCEX Read-Only Position · Current Position · {futures.position.health} · {futures.position.freshness}</p>
        <div className="metric-grid four">
          <Metric label="Side" value={futures.position.side} />
          <Metric label="Entry" value={formatNumber(futures.position.entryPrice)} />
          <Metric label="Position Size" value={formatNumber(futures.position.size, 3)} />
          <Metric label="Unrealized PnL" value={formatSigned(futures.position.unrealizedPnl)} />
        </div>
        <p className="muted-note">This KCEX position panel is read only and does not mutate exchange state.</p>
      </section>

      <section className="panel paper-panel" aria-label="Paper simulation state">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">PAPER SIMULATION · NO KCEX ORDER</p>
            <h2>Paper Trading</h2>
          </div>
          <span className="source-tag">{snapshot.paper.status}</span>
        </div>
        {snapshot.paper.status === "IDLE" ? (
          <p className="empty-state">No open paper position.</p>
        ) : snapshot.paper.status === "PLANNED" ? (
          <p className="empty-state">A paper plan is waiting for an explicit internal open command.</p>
        ) : snapshot.paper.status === "ERROR" ? (
          <p className="empty-state" role="status">Paper lifecycle halted because persisted state needs review.</p>
        ) : snapshot.paper.position ? (
          <div className="metric-grid four">
            <Metric label="Side" value={snapshot.paper.position.side} />
            <Metric label="Margin" value={`${formatNumber(snapshot.paper.position.marginUsdt, 2)} USDT`} />
            <Metric label="Leverage" value={`${formatNumber(snapshot.paper.position.leverage, 2)}x`} />
            <Metric label="Entry Price" value={formatNumber(snapshot.paper.position.entryPrice)} />
            <Metric label="Mark Price" value={formatNumber(snapshot.paper.position.markPrice)} />
            <Metric label="Quantity" value={formatNumber(snapshot.paper.position.quantity, 3)} />
            <Metric label="Unrealized PnL" value={formatSigned(snapshot.paper.position.unrealizedPnl)} />
          </div>
        ) : null}
        <p className="muted-note">Deterministic local simulation only. This position is separate from KCEX read-only state.</p>
      </section>

      <section className="panel">
        <p className="eyebrow">Open Orders · {futures.openOrders.ordersHealth}</p>
        {futures.openOrders.orders.length === 0 ? (
          <p className="empty-state">
            {futures.openOrders.ordersHealth === "READY"
              ? "No open orders were observed."
              : futures.openOrders.ordersHealth === "UNKNOWN"
                ? "Open orders unavailable."
                : "Open orders partially available."}
          </p>
        ) : (
          <>
            {futures.openOrders.ordersHealth === "PARTIAL" ? (
              <p className="empty-state">Partial order data.</p>
            ) : null}
            <ul className="runtime-logs">
              {futures.openOrders.orders.map((order, index) => (
                <li key={`${order.symbol}-${index}`}>
                  <span>{order.side} {order.type}</span>
                  <span>Price {formatNumber(order.price)}</span>
                  <span>Qty {formatNumber(order.quantity, 3)}</span>
                  <span>{order.status ?? "—"}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="panel">
        <p className="eyebrow">Automation · display only</p>
        <div className="metric-grid four">
          <Metric label="Daily range" value={`${snapshot.scheduler.dailyMin}-${snapshot.scheduler.dailyMax}`} />
          <Metric label="Today Target" value={String(snapshot.scheduler.todayTarget)} />
          <Metric label="Completed" value={String(snapshot.scheduler.completed)} />
          <Metric label="Next Trade" value="—" />
          <Metric label="Margin" value={`${snapshot.scheduler.marginUsdt} USDT`} />
          <Metric label="Leverage" value={`${snapshot.scheduler.leverage}x`} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Trade History · Storage {snapshot.status.storage}</p>
            <h2>Recent records</h2>
          </div>
        </div>
        {snapshot.history.length === 0 ? (
          <p className="empty-state">No trade history.</p>
        ) : (
          <div className="table-scroll">
            <table className="trade-history-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Mode</th>
                  <th>Side</th>
                  <th>Status</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>PnL</th>
                  <th>Fees</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.history.map((trade) => (
                  <tr key={trade.id}>
                    <td><time dateTime={trade.createdAt}>{new Date(trade.createdAt).toLocaleString()}</time></td>
                    <td>{trade.mode}</td>
                    <td>{trade.side}</td>
                    <td>{trade.status}</td>
                    <td>{formatHistoryNumber(trade.entryPrice)}</td>
                    <td>{formatHistoryNumber(trade.exitPrice)}</td>
                    <td>{formatHistoryMoney(trade.realizedPnl)}</td>
                    <td>
                      {formatHistoryMoney(trade.fees)}
                      {trade.mode === "PAPER" ? <small className="fee-kind">Simulated Fees</small> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <p className="eyebrow">Runtime Logs</p>
        <ul className="runtime-logs">
          {snapshot.logs.map((entry) => (
            <li key={entry.id}>
              <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
              <span className={`log-level ${entry.level}`}>{entry.level.toUpperCase()}</span>
              <span>{entry.message}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="safety-note">Authentication is separate from execution · LIVE_TRADING=false · Real KCEX execution is disabled.</p>
    </main>
  );
}

function AssistedExecutionPanel({
  execution,
  risk,
  onExecutionStateChange,
}: {
  execution: AssistedExecutionState;
  risk: RiskState;
  onExecutionStateChange?: (state: AssistedExecutionState) => void;
}) {
  const [acknowledgement, setAcknowledgement] = useState("");
  const [side, setSide] = useState<"LONG" | "SHORT">("LONG");
  const [marginUsdt, setMarginUsdt] = useState("50");
  const [leverage, setLeverage] = useState("10");
  const [preview, setPreview] = useState<AssistedLivePreview | null>(null);
  const [confirmationToken, setConfirmationToken] = useState("");
  const [busyAction, setBusyAction] = useState<"ARM" | "DISARM" | "PREVIEW" | "CONFIRM" | "RECONCILE" | null>(null);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const fixtureOnly = execution.provider === "FIXTURE";
  const activePreview = execution.activePreview;
  const previewExpired = activePreview !== null && Date.parse(activePreview.expiresAt) <= now;
  const lastSubmissionAt = execution.lastSubmission
    ? execution.lastSubmission.status === "FAILED"
      ? execution.lastSubmission.failedAt
      : execution.lastSubmission.status === "UNKNOWN"
        ? execution.lastSubmission.unknownAt
        : execution.lastSubmission.status === "CONFIRMED"
          ? execution.lastSubmission.confirmedAt
        : execution.lastSubmission.status === "SUBMITTING"
          ? null
          : execution.lastSubmission.submittedAt
    : null;
  const submission = execution.lastSubmission;
  const submissionEvidence = submission && "evidence" in submission ? submission.evidence : null;
  const submissionStartedAt = submission && "submittedAt" in submission ? submission.submittedAt : null;
  const unknownReason = submission?.status === "UNKNOWN" ? submission.reason : "—";
  const unresolved = ["SUBMITTING", "SUBMITTED", "CONFIRMING", "UNKNOWN"].includes(execution.status);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const executionFinished = ["DISARMED", "PRECHECK", "SUBMITTING", "SUBMITTED", "CONFIRMING", "CONFIRMED", "UNKNOWN", "FAILED", "BLOCKED", "HALTED"]
      .includes(execution.status);
    if (executionFinished) {
      setPreview(null);
      setConfirmationToken("");
    }
  }, [execution.status]);

  function acceptState(value: unknown) {
    const state = AssistedExecutionStateSchema.parse(value);
    setMessage("");
    onExecutionStateChange?.(state);
    return state;
  }

  async function postState(path: string, body: unknown): Promise<AssistedExecutionState> {
    const value = await requestJson<unknown>(path, { method: "POST", body: JSON.stringify(body) });
    return acceptState(value);
  }

  async function arm() {
    setBusyAction("ARM");
    setMessage("");
    setPreview(null);
    setConfirmationToken("");
    try {
      const state = await postState("/api/v1/live/arm", { acknowledgement });
      setAcknowledgement("");
      if (state.status === "ARMED") setMessage("Runtime arm active for up to five minutes. This is not KCEX platform authorization.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Runtime arm was rejected.");
    } finally {
      setBusyAction(null);
    }
  }

  async function disarm() {
    setBusyAction("DISARM");
    setMessage("");
    setConfirmationToken("");
    setPreview(null);
    try {
      await postState("/api/v1/live/disarm", {});
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Runtime disarm failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function createPreview() {
    setBusyAction("PREVIEW");
    setMessage("");
    setConfirmationToken("");
    setPreview(null);
    try {
      const value = await requestJson<unknown>("/api/v1/live/preview", {
        method: "POST",
        body: JSON.stringify({ side, marginUsdt: Number(marginUsdt), leverage: Number(leverage) }),
      });
      const result = ExecutionPreviewResponseSchema.parse(value);
      acceptState(result.state);
      setPreview(result.preview);
      setConfirmationToken(result.confirmationToken);
      setMessage("Review the immutable preview, then confirm as a separate action.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Preview could not be created.");
    } finally {
      setBusyAction(null);
    }
  }

  async function confirmSingleSubmission() {
    if (!preview || !confirmationToken) return;
    const previewId = preview.previewId;
    const token = confirmationToken;
    setConfirmationToken("");
    setBusyAction("CONFIRM");
    setMessage("");
    try {
      await postState("/api/v1/live/confirm", { previewId, confirmationToken: token });
      setPreview(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The single submission was rejected.");
    } finally {
      setBusyAction(null);
    }
  }

  async function reconcileUnknown() {
    const attemptId = execution.lastSubmission?.status === "UNKNOWN" ? execution.lastSubmission.attemptId : null;
    if (!attemptId) return;
    setBusyAction("RECONCILE");
    setMessage("");
    try {
      await postState("/api/v1/live/reconcile", { attemptId });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Position evidence could not be reconciled.");
    } finally {
      setBusyAction(null);
    }
  }

  const canCreatePreview = fixtureOnly
    && (execution.status === "ARMED" || execution.status === "AWAITING_CONFIRMATION")
    && busyAction === null;
  const canConfirm = fixtureOnly && execution.status === "AWAITING_CONFIRMATION" && preview !== null
    && confirmationToken.length > 0 && !previewExpired && busyAction === null;

  return (
    <section className="panel assisted-execution-panel" aria-label="Assisted Execution">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Authorization-gated · fixture phase</p>
          <h2>Assisted Execution</h2>
        </div>
        <span className="source-tag">{execution.provider}</span>
      </div>
      <div className="execution-warning" role="note">
        <strong>REAL KCEX EXECUTION DISABLED</strong>
        <span>{fixtureOnly ? "FIXTURE SUBMISSION ONLY · NO KCEX ORDER" : "Provider disabled; no submission is available."}</span>
      </div>
      <div className="metric-grid four execution-metrics">
        <Metric label="Provider" value={execution.provider} />
        <Metric label="Arm Status" value={execution.armedUntil && Date.parse(execution.armedUntil) > now ? "ARMED" : "DISARMED"} />
        <Metric label="Arm Expiry" value={execution.armedUntil ? new Date(execution.armedUntil).toLocaleTimeString() : "—"} />
        <Metric label="Execution Status" value={execution.status} />
        <Metric label="Symbol" value={activePreview?.symbol ?? execution.lastSubmission?.symbol ?? "GPS_USDT"} />
        <Metric label="Side" value={activePreview?.side ?? execution.lastSubmission?.side ?? "—"} />
        <Metric label="Margin" value={activePreview ? `${activePreview.marginUsdt} USDT` : "—"} />
        <Metric label="Leverage" value={activePreview ? `${activePreview.leverage}x` : "—"} />
        <Metric label="Order Type" value={activePreview?.orderType ?? "MARKET"} />
        <Metric label="Margin Mode" value={activePreview?.marginMode ?? "ISOLATED"} />
        <Metric label="Preview Expiry" value={activePreview ? new Date(activePreview.expiresAt).toLocaleTimeString() : "—"} />
        <Metric label="Risk Status" value={risk.status} />
      </div>
      {submission ? (
        <div className="execution-confirmation" aria-label="Confirmation Status">
          <p className="eyebrow">Confirmation Status · {submission.status}</p>
          <div className="metric-grid four">
            <Metric label="Attempt ID" value={submission.attemptId} />
            <Metric label="Submitted At" value={submissionStartedAt ?? "—"} />
            <Metric label="Observed Side" value={submissionEvidence?.kind === "MATCHED_OPEN" ? submissionEvidence.side : "—"} />
            <Metric label="Observed Entry Price" value={submissionEvidence?.kind === "MATCHED_OPEN" ? String(submissionEvidence.entryPrice) : "—"} />
            <Metric label="Observed Size" value={submissionEvidence?.kind === "MATCHED_OPEN" ? String(submissionEvidence.size) : "—"} />
            <Metric label="Evidence Time" value={submissionEvidence?.observedAt ?? "—"} />
            <Metric label="Unknown Reason" value={unknownReason} />
          </div>
        </div>
      ) : null}
      {activePreview ? (
        <div className="execution-preview" aria-label="Immutable preview">
          <strong>Preview {activePreview.previewId}</strong>
          {activePreview.referencePrice === null
            ? <p>Reference price unavailable.</p>
            : <p>Reference price only: {activePreview.referencePrice} · not a guaranteed fill price.</p>}
          <p>Expires {new Date(activePreview.expiresAt).toLocaleString()}{previewExpired ? " · EXPIRED; create a new preview" : ""}</p>
        </div>
      ) : null}
      {execution.lastSubmission?.status === "CONFIRMED" && execution.lastSubmission.evidence.kind === "MATCHED_OPEN" ? (
        <p className="muted-note" role="status">
          Fixture evidence: {execution.lastSubmission.evidence.symbol} {execution.lastSubmission.evidence.side} ·
          entry {execution.lastSubmission.evidence.entryPrice} · size {execution.lastSubmission.evidence.size} ·
          observed {execution.lastSubmission.evidence.observedAt}
        </p>
      ) : null}
      {execution.lastSubmission?.status === "UNKNOWN" && execution.lastSubmission.evidence ? (
        <p className="muted-note" role="status">
          Last evidence: {execution.lastSubmission.evidence.kind} · observed {execution.lastSubmission.evidence.observedAt}
        </p>
      ) : null}
      {execution.status === "SUBMITTED" ? (
        <p className="execution-outcome" role="status">SUBMITTED — POSITION NOT YET CONFIRMED. Submission acceptance is not position confirmation.</p>
      ) : execution.status === "CONFIRMING" ? (
        <p className="execution-outcome" role="status">CONFIRMING FIXTURE POSITION EVIDENCE. No KCEX position is created.</p>
      ) : execution.status === "CONFIRMED" ? (
        <p className="execution-outcome" role="status">FIXTURE POSITION CONFIRMED — NO KCEX POSITION CREATED.</p>
      ) : execution.status === "UNKNOWN" ? (
        <div className="execution-unknown" role="alert">
          <strong>OUTCOME UNKNOWN — NEW ENTRIES BLOCKED</strong>
          <span>Do not resubmit. Reconciliation only reads fixture evidence and never submits again.</span>
          {execution.lastSubmission?.status === "UNKNOWN" ? (
            <span>Attempt {execution.lastSubmission.attemptId} · {execution.lastSubmission.reason}</span>
          ) : null}
          <button type="button" onClick={() => void reconcileUnknown()} disabled={busyAction !== null}>
            {busyAction === "RECONCILE" ? "Checking evidence…" : "Reconcile Outcome"}
          </button>
        </div>
      ) : execution.status === "FAILED" ? (
        <p className="execution-outcome" role="status">FAILED — FIXTURE PROVIDER CONFIRMED NOT_SUBMITTED. No automatic retry was attempted.</p>
      ) : null}

      <div className="execution-controls">
        <label htmlFor="execution-acknowledgement">Arm acknowledgement phrase</label>
        <input
          id="execution-acknowledgement"
          value={acknowledgement}
          onChange={(event) => setAcknowledgement(event.currentTarget.value)}
          autoComplete="off"
          disabled={!fixtureOnly || busyAction !== null}
          placeholder="ARM ASSISTED LIVE EXECUTION"
        />
        <button type="button" onClick={() => void arm()} disabled={!fixtureOnly || unresolved || busyAction !== null || acknowledgement !== "ARM ASSISTED LIVE EXECUTION"}>
          {busyAction === "ARM" ? "Arming…" : "Arm for five minutes"}
        </button>
        <button type="button" className="secondary" onClick={() => void disarm()} disabled={busyAction === "DISARM"}>
          {busyAction === "DISARM" ? "Disarming…" : "Disarm"}
        </button>
        <fieldset disabled={!canCreatePreview}>
          <legend>Single preview intent</legend>
          <div className="side-choice" role="group" aria-label="Direction">
            <button type="button" aria-pressed={side === "LONG"} onClick={() => setSide("LONG")}>LONG</button>
            <button type="button" aria-pressed={side === "SHORT"} onClick={() => setSide("SHORT")}>SHORT</button>
          </div>
          <label htmlFor="execution-margin">Margin (USDT, maximum 50)</label>
          <input id="execution-margin" type="number" min="0.01" max="50" step="0.01" value={marginUsdt} onChange={(event) => setMarginUsdt(event.currentTarget.value)} />
          <label htmlFor="execution-leverage">Leverage (maximum 10x)</label>
          <input id="execution-leverage" type="number" min="0.01" max="10" step="0.01" value={leverage} onChange={(event) => setLeverage(event.currentTarget.value)} />
        </fieldset>
        <button type="button" onClick={() => void createPreview()} disabled={!canCreatePreview}>
          {busyAction === "PREVIEW" ? "Creating preview…" : "Create Preview"}
        </button>
        <button type="button" className="confirm-submit" onClick={() => void confirmSingleSubmission()} disabled={!canConfirm}>
          {busyAction === "CONFIRM" ? "Submitting once…" : "Confirm Single Submission"}
        </button>
      </div>
      <p className="muted-note">Runtime arm is local intent only, not platform authorization. Position confirmation uses fixture evidence only. No automatic retry, scheduler, or TP/SL is implemented.</p>
      {execution.lastSubmission ? (
        <p className="muted-note" role="status">Last fixture attempt: {execution.lastSubmission.status} · {execution.lastSubmission.side} · {lastSubmissionAt ?? "—"} · {execution.lastSubmission.attemptId}</p>
      ) : null}
      {message ? <p className="execution-message" role="status">{message}</p> : null}
    </section>
  );
}

function StatusTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Metric({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {suffix ? <small>{suffix}</small> : null}
    </div>
  );
}

function formatHistoryNumber(value: number | null): string {
  return value === null ? "—" : value.toFixed(5);
}

function formatHistoryMoney(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)} USDT`;
}

function displayCount(value: number | null): string {
  return value === null ? "—" : String(value);
}

function displayMoney(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

export function AuthPanel({
  auth,
  onAuthChanged,
}: {
  auth: AuthState;
  onAuthChanged: (state: AuthState) => void;
}) {
  const [masterKey, setMasterKey] = useState("");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [saveCredentials, setSaveCredentials] = useState(auth.credentialsSaved);
  const [verificationCode, setVerificationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setSaveCredentials(auth.credentialsSaved);
  }, [auth.credentialsSaved]);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let submittedKey = masterKey;
    setMasterKey("");
    setMessage("");
    setBusy(true);
    try {
      const state = await requestJson<unknown>("/api/v1/vault/unlock", {
        method: "POST",
        body: JSON.stringify({ masterKey: submittedKey }),
      });
      onAuthChanged(AuthStateSchema.parse(state));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vault unlock failed.");
    } finally {
      submittedKey = "";
      setBusy(false);
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let submittedPassword = password;
    setPassword("");
    setMessage("");
    setBusy(true);
    try {
      const hasNewCredentials = account.trim().length > 0 || submittedPassword.length > 0;
      if (hasNewCredentials) {
        if (!account.trim() || !submittedPassword) {
          throw new Error("Enter both the account and password, or use saved credentials.");
        }
        await requestJson<{ ok: true; credentialsSaved: boolean }>("/api/v1/vault/credentials", {
          method: "POST",
          body: JSON.stringify({ account, password: submittedPassword, save: saveCredentials }),
        });
        setAccount("");
        onAuthChanged({ ...auth, credentialsSaved: saveCredentials });
      } else if (!auth.credentialsSaved) {
        throw new Error("Enter an account and password to continue.");
      }

      const state = await requestJson<unknown>("/api/v1/auth/login", { method: "POST", body: "{}" });
      onAuthChanged(AuthStateSchema.parse(state));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      submittedPassword = "";
      setBusy(false);
    }
  }

  async function submitOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let submittedCode = verificationCode;
    setVerificationCode("");
    setMessage("");
    setBusy(true);
    try {
      const state = await requestJson<unknown>("/api/v1/auth/otp", {
        method: "POST",
        body: JSON.stringify({ code: submittedCode }),
      });
      onAuthChanged(AuthStateSchema.parse(state));
    } catch {
      setMessage("The verification code expired or was not accepted.");
    } finally {
      submittedCode = "";
      setBusy(false);
    }
  }

  async function checkSession() {
    if (busy) return;
    setMessage("");
    setBusy(true);
    try {
      const state = await requestJson<unknown>("/api/v1/auth/session/check", {
        method: "POST",
        body: "{}",
      });
      onAuthChanged(AuthStateSchema.parse(state));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Session check failed.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSavedCredentials() {
    if (!auth.credentialsSaved || busy) return;
    if (!window.confirm("Delete the saved encrypted credentials from this device?")) return;

    setMessage("");
    setBusy(true);
    try {
      const result = await requestJson<{
        ok: true;
        credentialsSaved: false;
        auth: unknown;
      }>("/api/v1/vault/credentials", { method: "DELETE" });
      if (!result.ok || result.credentialsSaved !== false) {
        throw new Error("Invalid delete response.");
      }

      setAccount("");
      setPassword("");
      setVerificationCode("");
      setSaveCredentials(false);
      onAuthChanged(AuthStateSchema.parse(result.auth));
    } catch {
      setMessage("Saved credentials could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  if (auth.status === "APP_LOCKED") {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">Local Dashboard</p>
          <h1>Unlock your vault</h1>
          <p className="muted-note">The unlock key stays in memory for this request and is never returned by the API.</p>
          <form onSubmit={unlock}>
            <label htmlFor="master-key">Local Unlock Key</label>
            <input
              id="master-key"
              type="password"
              autoComplete="off"
              value={masterKey}
              onChange={(event) => setMasterKey(event.currentTarget.value)}
              placeholder="••••••••••••"
              minLength={MASTER_KEY_MIN_LENGTH}
              maxLength={4096}
              required
            />
            <small>Minimum {MASTER_KEY_MIN_LENGTH} characters</small>
            <button type="submit" disabled={busy}>{busy ? "Unlocking…" : "Unlock"}</button>
          </form>
          <p className="safety-note">Bound to 127.0.0.1 · LIVE_TRADING=false</p>
          {message ? <p className="form-error" role="alert">{message}</p> : null}
        </section>
      </main>
    );
  }

  if (auth.status === "OTP_REQUIRED") {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">{auth.authProvider === "FAKE" ? "Fake Auth · fixture only" : "KCEX authentication"}</p>
          <h1>KCEX Email Verification</h1>
          <form onSubmit={submitOtp}>
            <label htmlFor="verification-code">Verification Code</label>
            <input
              id="verification-code"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={verificationCode}
              onChange={(event) => setVerificationCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="______"
              required
            />
            <button type="submit" disabled={busy || verificationCode.length !== 6}>{busy ? "Submitting…" : "Submit"}</button>
          </form>
          {auth.authProvider === "FAKE" ? (
            <p className="muted-note">FakeAuth demo code: {FAKE_OTP_CODE}. It is not a real email OTP.</p>
          ) : null}
          {message ? <p className="form-error" role="alert">{message}</p> : null}
        </section>
      </main>
    );
  }

  if (auth.status === "SESSION_CHECK" || auth.status === "LOGGING_IN" || auth.status === "SUBMITTING_OTP") {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">{auth.authProvider} authentication</p>
          <h1>{auth.status === "SESSION_CHECK" ? "Checking saved session…" : "Signing in…"}</h1>
          <p className="muted-note">Secrets remain in the local backend and are never shown in the dashboard.</p>
          <p className="safety-note">LIVE_TRADING=false</p>
        </section>
      </main>
    );
  }

  if (auth.status === "MANUAL_CHALLENGE") {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">{auth.authProvider} authentication</p>
          <h1>Manual security check required</h1>
          <p className="muted-note">A security challenge was detected. Complete it manually in the approved browser, then retry.</p>
          <button type="button" onClick={() => void checkSession()} disabled={busy}>
            {busy ? "Checking…" : "Check Again"}
          </button>
          <p className="safety-note">No CAPTCHA or anti-bot challenge is bypassed automatically.</p>
          {message ? <p className="form-error" role="alert">{message}</p> : null}
        </section>
      </main>
    );
  }

  if (auth.status === "AUTH_UNKNOWN") {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">{auth.authProvider} authentication</p>
          <h1>Authentication state is unknown</h1>
          <p className="muted-note">The page did not provide enough trusted evidence. No credential action was continued.</p>
          <button type="button" onClick={() => void checkSession()} disabled={busy}>
            {busy ? "Checking…" : "Check Again"}
          </button>
          <p className="safety-note">The workflow fails closed. LIVE_TRADING=false</p>
          {message ? <p className="form-error" role="alert">{message}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyebrow">{auth.status === "AUTH_FAILED" ? `${auth.authProvider} authentication failed` : auth.status === "SESSION_LOST" ? "Session lost" : "Vault unlocked"}</p>
        <h1>KCEX Credentials</h1>
        <p className="muted-note">
          {auth.authProvider === "FAKE"
            ? "FakeAuthAdapter fixture only. No request is made to KCEX."
            : "Credentials are handled by the local KCEX adapter; the browser host is checked before every fill."}
        </p>
        {auth.credentialsSaved ? <p className="saved-state" role="status">Encrypted credentials are saved locally.</p> : null}
        <form onSubmit={login}>
          <label htmlFor="kcex-account">KCEX Account</label>
          <input
            id="kcex-account"
            type="text"
            autoComplete="off"
            value={account}
            onChange={(event) => setAccount(event.currentTarget.value)}
            placeholder={auth.credentialsSaved ? "Leave blank to use saved credentials" : "account@example.test"}
          />
          <label htmlFor="kcex-password">KCEX Password</label>
          <input
            id="kcex-password"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            placeholder="••••••••••••"
          />
          <label className="checkbox-row" htmlFor="save-credentials">
            <input
              id="save-credentials"
              type="checkbox"
              checked={saveCredentials}
              onChange={(event) => setSaveCredentials(event.currentTarget.checked)}
            />
            Save encrypted credentials locally
          </label>
          <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Login"}</button>
        </form>
        {auth.credentialsSaved ? (
          <button type="button" className="secondary" onClick={() => void deleteSavedCredentials()} disabled={busy}>
            {busy ? "Deleting…" : "Delete saved credentials"}
          </button>
        ) : null}
        {message ? <p className="form-error" role="alert">{message}</p> : null}
      </section>
    </main>
  );
}

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(() => createFakeDashboardSnapshot());
  const [webSocketConnected, setWebSocketConnected] = useState(false);
  const [serviceReady, setServiceReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    const refreshSnapshot = async () => {
      try {
        const value = await requestJson<unknown>("/api/v1/dashboard/snapshot");
        if (!disposed) setSnapshot(DashboardSnapshotSchema.parse(value));
      } catch {
        if (!disposed) setServiceReady(false);
      }
    };

    void requestJson<unknown>("/api/v1/auth/state")
      .then((value) => {
        if (!disposed) {
          setAuth(AuthStateSchema.parse(value));
          setServiceReady(true);
        }
      })
      .catch(() => {
        if (!disposed) setServiceReady(false);
      });
    void refreshSnapshot();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/events`);
    socket.onopen = () => setWebSocketConnected(true);
    socket.onclose = () => setWebSocketConnected(false);
    socket.onerror = () => setWebSocketConnected(false);
    socket.onmessage = (message) => {
      try {
        const event = parseDashboardEvent(JSON.parse(String(message.data))) as DashboardEvent;
        if (event.type === "auth.state") {
          setAuth(event.payload);
          if (event.payload.status === "AUTHENTICATED") void refreshSnapshot();
        }
        if (event.type === "futures.snapshot") {
          setSnapshot((current) => {
            const next = applyFuturesSnapshotToDashboard(current, event.payload);
            return DashboardSnapshotSchema.parse({
              ...next,
              status: {
                ...next.status,
                kcex: "KCEX_AUTHENTICATED",
                readOnlyEnabled: true,
                readHealth: event.payload.health,
              },
            });
          });
        }
        if (event.type === "market.snapshot") {
          setSnapshot((current) => {
            if (event.payload.source !== current.futures.source) return current;
            return DashboardSnapshotSchema.parse({
              ...current,
              market: event.payload,
              futures: {
                ...current.futures,
                market: event.payload,
                freshness: event.payload.freshness,
              },
            });
          });
        }
        if (event.type === "account.balance") {
          setSnapshot((current) => {
            if (event.payload.source !== current.futures.source) return current;
            const account = {
              ...current.account,
              availableUsdt: event.payload.available,
              health: event.payload.health ?? current.account.health,
              updatedAt: event.payload.updatedAt ?? current.account.updatedAt,
              source: event.payload.source,
            };
            return DashboardSnapshotSchema.parse({ ...current, account, futures: { ...current.futures, account } });
          });
        }
        if (event.type === "position.changed") {
          setSnapshot((current) => {
            if (event.payload.source !== current.futures.source) return current;
            return DashboardSnapshotSchema.parse({
              ...current,
              position: event.payload,
              futures: {
                ...current.futures,
                position: event.payload,
                freshness: event.payload.freshness,
              },
            });
          });
        }
        if (event.type === "futures.contract") {
          setSnapshot((current) => {
            if (event.payload.source !== current.futures.source) return current;
            return DashboardSnapshotSchema.parse({
              ...current,
              contract: event.payload,
              futures: { ...current.futures, contract: event.payload },
            });
          });
        }
        if (event.type === "orders.snapshot") {
          setSnapshot((current) => {
            if (event.payload.source !== current.futures.source) return current;
            return DashboardSnapshotSchema.parse({
              ...current,
              openOrders: event.payload,
              futures: { ...current.futures, openOrders: event.payload },
            });
          });
        }
        if (event.type === "futures.read-health") {
          setSnapshot((current) => applyReadHealthToDashboard(current, event.payload));
        }
        if (event.type === "paper.state") {
          setSnapshot((current) => applyPaperStateToDashboard(current, event.payload));
        }
        if (event.type === "risk.state") {
          setSnapshot((current) => applyRiskStateToDashboard(current, event.payload));
        }
        if (event.type === "execution.state") {
          setSnapshot((current) => applyExecutionStateToDashboard(current, event.payload));
        }
        if (event.type === "risk.blocked") {
          setSnapshot((current) => applyRiskBlockedToDashboard(current, event.payload));
        }
        if (event.type === "trade.opened" || event.type === "trade.closed") {
          void refreshSnapshot();
        }
        if (event.type === "scheduler.plan") {
          setSnapshot((current) => ({ ...current, scheduler: event.payload }));
        }
        if (event.type === "system.log") {
          setSnapshot((current) => ({ ...current, logs: [event.payload, ...current.logs].slice(0, 100) }));
        }
      } catch {
        // Invalid events are discarded; payloads are never echoed to the UI or logs.
      }
    };

    return () => {
      disposed = true;
      socket.close();
    };
  }, []);

  if (!serviceReady || !auth) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">127.0.0.1:6666</p>
          <h1>Local Dashboard</h1>
          <p className="muted-note">{serviceReady ? "Loading local state…" : "Waiting for the local backend. No KCEX connection is attempted."}</p>
          <p className="safety-note">LIVE_TRADING=false</p>
        </section>
      </main>
    );
  }

  if (auth.status !== "AUTHENTICATED") {
    return <AuthPanel auth={auth} onAuthChanged={setAuth} />;
  }

  return (
    <DashboardView
      snapshot={snapshot}
      auth={auth}
      webSocketConnected={webSocketConnected}
      onExecutionStateChange={(execution) => setSnapshot((current) => applyExecutionStateToDashboard(current, execution))}
    />
  );
}

export function mountApp(element: HTMLElement): void {
  createRoot(element).render(<App />);
}
