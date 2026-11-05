/**
 * Runs a browser audit against an application instance owned by this command.
 *
 * The browser scripts mock control responses in the page, but they still need a
 * real built web process. Owning that process prevents a local or CI run from
 * accidentally reusing an unknown server.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const audits = {
  contrast: "apps/web/e2e/contrast-audit.mjs",
  preauth: "apps/web/e2e/wallet-preauth.mjs",
  shots: "apps/web/e2e/shots.mjs",
};

const [audit, ...args] = process.argv.slice(2);
const target = audits[audit];
if (!target) {
  throw new Error(
    `Choose one browser audit: ${Object.keys(audits).join(", ")}.`,
  );
}

const requestedPort = Number(process.env.MAKER_E2E_PORT ?? "8898");
if (!Number.isSafeInteger(requestedPort) || requestedPort < 1) {
  throw new Error("MAKER_E2E_PORT must be a valid TCP port.");
}

function portIsFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

function waitForServer(port, child) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const attempt = () => {
      if (child.exitCode !== null) {
        reject(new Error(`Next exited before the ${audit} audit could start.`));
        return;
      }
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for Next on port ${port}.`));
          return;
        }
        setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

if (!(await portIsFree(requestedPort))) {
  throw new Error(
    `Port ${requestedPort} is already in use; refusing to run ${audit} against an unknown server.`,
  );
}

const next = path.join(projectRoot, "node_modules/next/dist/bin/next");
const server = spawn(
  process.execPath,
  [next, "start", "-p", String(requestedPort)],
  {
    cwd: path.join(projectRoot, "apps/web"),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PUBLIC_ORIGIN: `http://127.0.0.1:${requestedPort}`,
      CONTROL_URL: "http://127.0.0.1:1",
    },
    stdio: "inherit",
  },
);

try {
  await waitForServer(requestedPort, server);
  const child = spawn(
    process.execPath,
    [
      path.join(projectRoot, target),
      "--base-url",
      `http://127.0.0.1:${requestedPort}`,
      ...args,
    ],
    { cwd: projectRoot, env: process.env, stdio: "inherit" },
  );
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  if (exitCode !== 0) process.exitCode = exitCode ?? 1;
} finally {
  await stop(server);
}
