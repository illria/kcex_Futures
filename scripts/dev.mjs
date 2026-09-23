import { spawn } from "node:child_process";

const commonEnv = { ...process.env };
const children = [
  spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "watch", "apps/server/src/index.ts"],
    {
      env: { ...commonEnv, DASHBOARD_DEV: "true", DASHBOARD_PORT: "6667" },
      stdio: "inherit",
    },
  ),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--config", "apps/web/vite.config.ts"],
    { env: commonEnv, stdio: "inherit" },
  ),
];

let stopping = false;
function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 250).unref();
}

for (const child of children) {
  child.on("error", () => stopAll(1));
  child.on("exit", (code, signal) => {
    if (!stopping) stopAll(code ?? (signal ? 1 : 0));
  });
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
