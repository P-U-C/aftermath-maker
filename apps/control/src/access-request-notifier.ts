import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, type AccessRequest } from "./store.js";

type EmailOptions = {
  recipient: string;
  sender: string;
};

const singleLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

export function formatAccessRequestEmail(
  request: AccessRequest,
  options: EmailOptions,
): string {
  const recipient = singleLine(options.recipient);
  const sender = singleLine(options.sender);
  if (!recipient || !sender) {
    throw new Error("Access request email sender and recipient are required");
  }

  return [
    `From: ${sender}`,
    `To: ${recipient}`,
    "Subject: [Maker] New access request",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "A user requested access to Maker.",
    "",
    `Wallet: ${request.walletAddress}`,
    `X / Twitter: ${request.twitterHandle}`,
    `Requested: ${request.requestedAt}`,
    "",
    "Review the wallet in the Maker operator controls before adding it to the on-chain whitelist.",
    "",
  ].join("\n");
}

export function deliverAccessRequestNotifications(): {
  delivered: number;
  failed: number;
} {
  const databasePath = process.env.DATABASE_PATH ?? "data/maker.db";
  const recipient = process.env.ACCESS_REQUEST_EMAIL ?? "zeroexzoz@gmail.com";
  const sender =
    process.env.ACCESS_REQUEST_EMAIL_FROM ??
    "Maker Access <maker@permanentupperclass.com>";
  const sendmailPath = process.env.SENDMAIL_PATH ?? "/usr/sbin/sendmail";
  const store = new Store(databasePath);
  let delivered = 0;
  let failed = 0;

  try {
    for (const request of store.listPendingAccessRequestNotifications()) {
      const result = spawnSync(sendmailPath, ["-t", "-oi"], {
        input: formatAccessRequestEmail(request, { recipient, sender }),
        encoding: "utf8",
        timeout: 10_000,
      });
      if (result.status === 0 && !result.error) {
        store.markAccessRequestNotification(request.id, { ok: true });
        delivered += 1;
        continue;
      }

      const reason =
        result.error?.message ||
        result.stderr.trim() ||
        `sendmail exited with status ${result.status ?? "unknown"}`;
      store.markAccessRequestNotification(request.id, {
        ok: false,
        error: reason,
      });
      failed += 1;
    }
  } finally {
    store.close();
  }

  return { delivered, failed };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = deliverAccessRequestNotifications();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.failed > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
