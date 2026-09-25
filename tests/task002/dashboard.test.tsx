/** @vitest-environment happy-dom */
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeDashboardSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import { AuthStateSchema, DashboardSnapshotSchema } from "../../packages/shared/src/protocol.js";
import { applyFuturesSnapshotToDashboard, AuthPanel, DashboardView } from "../../apps/web/src/App";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mock dashboard rendering", () => {
  it("renders GPS_USDT fixture values and display-only dashboard sections", () => {
    const auth = AuthStateSchema.parse({
      status: "AUTHENTICATED",
      credentialsSaved: false,
      liveTrading: false,
      authProvider: "FAKE",
      updatedAt: new Date(0).toISOString(),
    });
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot: createFakeDashboardSnapshot(true, new Date(0).toISOString()),
      auth,
      webSocketConnected: true,
    }));

    for (const expected of [
      "GPS_USDT",
      "Last Price",
      "Mark Price",
      "Available USDT",
      "Margin Mode",
      "Leverage",
      "Current Position",
      "Unrealized PnL",
      "Today Target",
      "Completed",
      "Runtime Logs",
      "LIVE_TRADING",
      "FIXTURE",
    ]) {
      expect(html).toContain(expected);
    }
    expect(html).not.toContain("Long");
    expect(html).not.toContain("Short");
  });

  it("explains empty, unavailable, and partial open-order evidence", () => {
    const auth = AuthStateSchema.parse({
      status: "AUTHENTICATED",
      credentialsSaved: false,
      liveTrading: false,
      authProvider: "FAKE",
      updatedAt: new Date(0).toISOString(),
    });
    const base = createFakeDashboardSnapshot(true, new Date(0).toISOString());
    const render = (ordersHealth: "READY" | "PARTIAL" | "UNKNOWN", orders = base.futures.openOrders.orders) => renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot: {
        ...base,
        futures: { ...base.futures, openOrders: { ...base.futures.openOrders, orders, ordersHealth } },
        openOrders: { ...base.openOrders, orders, ordersHealth },
      },
      auth,
      webSocketConnected: true,
    }));

    expect(render("READY")).toContain("No open orders were observed.");
    expect(render("UNKNOWN")).toContain("Open orders unavailable.");
    expect(render("PARTIAL")).toContain("Open orders partially available.");
  });

  it("atomically transitions the dashboard from MOCK to a KCEX read-only snapshot", () => {
    const timestamp = new Date(0).toISOString();
    const mock = createFakeDashboardSnapshot(true, timestamp);
    const kcex = {
      ...mock.futures,
      source: "KCEX" as const,
      market: { ...mock.futures.market, source: "KCEX" as const },
      account: { ...mock.futures.account, source: "KCEX" as const },
      contract: { ...mock.futures.contract, source: "KCEX" as const },
      position: { ...mock.futures.position, source: "KCEX" as const },
      openOrders: {
        ...mock.futures.openOrders,
        source: "KCEX" as const,
        orders: mock.futures.openOrders.orders.map((order) => ({ ...order, source: "KCEX" as const })),
      },
    };
    const transitioned = applyFuturesSnapshotToDashboard(mock, kcex);
    expect(() => DashboardSnapshotSchema.parse(transitioned)).not.toThrow();
    expect(transitioned.futures.source).toBe("KCEX");
    expect(transitioned.market.source).toBe("KCEX");
    expect(transitioned.account.source).toBe("KCEX");
    expect(transitioned.contract.source).toBe("KCEX");
    expect(transitioned.position.source).toBe("KCEX");
    expect(transitioned.openOrders.source).toBe("KCEX");

    const auth = AuthStateSchema.parse({
      status: "AUTHENTICATED",
      credentialsSaved: false,
      liveTrading: false,
      authProvider: "KCEX",
      updatedAt: timestamp,
    });
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot: transitioned,
      auth,
      webSocketConnected: true,
    }));
    expect(html).toContain("LIVE READ-ONLY");
    expect(html).toContain("Freshness");
    expect(html).not.toContain(">FIXTURE<");
  });
});

describe("saved credential deletion UI", () => {
  const savedAuth = AuthStateSchema.parse({
    status: "CREDENTIALS_REQUIRED",
    credentialsSaved: true,
    liveTrading: false,
    authProvider: "FAKE",
    updatedAt: new Date(0).toISOString(),
  });

  it("shows the delete action only when encrypted credentials are saved", () => {
    const savedMarkup = renderToStaticMarkup(React.createElement(AuthPanel, {
      auth: savedAuth,
      onAuthChanged: () => undefined,
    }));
    const unsavedMarkup = renderToStaticMarkup(React.createElement(AuthPanel, {
      auth: { ...savedAuth, credentialsSaved: false },
      onAuthChanged: () => undefined,
    }));

    expect(savedMarkup).toContain("Delete saved credentials");
    expect(unsavedMarkup).not.toContain("Delete saved credentials");
    expect(savedMarkup).not.toContain("account@example.test");
  });

  it("clears credential inputs and resets auth state after confirmed deletion", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const nextAuth = AuthStateSchema.parse({
      ...savedAuth,
      status: "CREDENTIALS_REQUIRED",
      credentialsSaved: false,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, credentialsSaved: false, auth: nextAuth }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(window, "confirm", { configurable: true, value: confirmMock });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onAuthChanged = vi.fn();
    function TestHarness() {
      const [auth, setAuth] = React.useState(savedAuth);
      return React.createElement(AuthPanel, {
        auth,
        onAuthChanged: (state) => {
          onAuthChanged(state);
          setAuth(state);
        },
      });
    }
    try {
      await act(async () => {
        root.render(React.createElement(TestHarness));
      });

      const setInputValue = (selector: string, value: string) => {
        const input = container.querySelector<HTMLInputElement>(selector);
        if (!input) throw new Error("Expected credential input.");
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      await act(async () => {
        setInputValue("#kcex-account", "temporary@example.test");
        setInputValue("#kcex-password", "temporary-password");
      });

      const deleteButton = container.querySelector<HTMLButtonElement>("button.secondary");
      expect(deleteButton?.textContent).toBe("Delete saved credentials");
      await act(async () => {
        deleteButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(fetchMock).toHaveBeenCalledWith("/api/v1/vault/credentials", expect.objectContaining({ method: "DELETE" }));
      expect(onAuthChanged).toHaveBeenCalledWith(expect.objectContaining({
        status: "CREDENTIALS_REQUIRED",
        credentialsSaved: false,
      }));
      expect(container.querySelector<HTMLInputElement>("#kcex-account")?.value).toBe("");
      expect(container.querySelector<HTMLInputElement>("#kcex-password")?.value).toBe("");
      expect(container.querySelector<HTMLInputElement>("#save-credentials")?.checked).toBe(false);
      expect(container.querySelector("button.secondary")).toBeNull();
      expect(confirmMock).toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      Reflect.deleteProperty(window, "confirm");
    }
  });
});
