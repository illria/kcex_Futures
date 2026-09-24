import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { FAKE_OTP_CODE } from "../../../packages/shared/src/fake-auth.js";
import { createFakeDashboardSnapshot } from "../../../packages/shared/src/fake-snapshot.js";
import {
  AuthStateSchema,
  DashboardSnapshotSchema,
  MASTER_KEY_MIN_LENGTH,
  parseDashboardEvent,
  type AuthState,
  type DashboardEvent,
  type DashboardSnapshot,
} from "../../../packages/shared/src/protocol.js";

interface ApiError extends Error {
  status?: number;
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
      </section>

      <div className="stream-state" role="status">
        WebSocket: {webSocketConnected ? "CONNECTED" : "DISCONNECTED"} · Fixture data only · Provider: {auth.authProvider}
      </div>

      <section className="panel market-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Market snapshot · mock</p>
            <h2>{snapshot.market.symbol}</h2>
          </div>
          <span className="source-tag">FIXTURE</span>
        </div>
        <div className="metric-grid two">
          <Metric label="Last Price" value={snapshot.market.lastPrice.toFixed(5)} />
          <Metric label="Mark Price" value={snapshot.market.markPrice.toFixed(5)} />
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Account · mock</p>
        <div className="metric-grid three">
          <Metric label="Available USDT" value={snapshot.account.availableUsdt.toFixed(2)} suffix="USDT" />
          <Metric label="Margin Mode" value={snapshot.account.marginMode} />
          <Metric label="Leverage" value={`${snapshot.account.leverage}x`} />
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Current Position · mock</p>
        <div className="metric-grid four">
          <Metric label="Side" value={snapshot.position.side} />
          <Metric label="Entry" value="—" />
          <Metric label="Position Size" value="0" />
          <Metric label="Unrealized PnL" value="0.00 USDT" />
        </div>
        <p className="muted-note">No position is connected or managed by this dashboard.</p>
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
        <p className="eyebrow">Trade History</p>
        <p className="empty-state">No trade history. TASK-002 uses fixture data only.</p>
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

      <p className="safety-note">Authentication is separate from trading · LIVE_TRADING=false · No order submission or live trading.</p>
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
          <p className="safety-note">No CAPTCHA or anti-bot challenge is bypassed automatically.</p>
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
          <p className="safety-note">The workflow fails closed. LIVE_TRADING=false</p>
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
        if (event.type === "market.snapshot") {
          setSnapshot((current) => ({ ...current, market: event.payload }));
        }
        if (event.type === "account.balance") {
          setSnapshot((current) => ({
            ...current,
            account: { ...current.account, availableUsdt: event.payload.available },
          }));
        }
        if (event.type === "position.changed") {
          setSnapshot((current) => ({ ...current, position: event.payload }));
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
