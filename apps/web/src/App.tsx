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
}: {
  snapshot: DashboardSnapshot;
  auth: AuthState;
  webSocketConnected: boolean;
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

      <div className="stream-state" role="status">
        WebSocket: {webSocketConnected ? "CONNECTED" : "DISCONNECTED"} · {sourceLabel} · Provider: {auth.authProvider}
      </div>

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
        <p className="eyebrow">Current Position · {futures.position.health} · {futures.position.freshness}</p>
        <div className="metric-grid four">
          <Metric label="Side" value={futures.position.side} />
          <Metric label="Entry" value={formatNumber(futures.position.entryPrice)} />
          <Metric label="Position Size" value={formatNumber(futures.position.size, 3)} />
          <Metric label="Unrealized PnL" value={formatSigned(futures.position.unrealizedPnl)} />
        </div>
        <p className="muted-note">Read-only state; this dashboard never submits or manages orders.</p>
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
                    <td>{formatHistoryMoney(trade.fees)}</td>
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

      <p className="safety-note">Authentication is separate from trading · LIVE_TRADING=false · Read-only extractor · No order submission or live trading.</p>
    </main>
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

  return <DashboardView snapshot={snapshot} auth={auth} webSocketConnected={webSocketConnected} />;
}

export function mountApp(element: HTMLElement): void {
  createRoot(element).render(<App />);
}
