export function readDashboardPort(value?: string): number {
  const configured = value?.trim();
  if (!configured) return 6666;
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DASHBOARD_PORT must be a valid TCP port.");
  }
  return port;
}
