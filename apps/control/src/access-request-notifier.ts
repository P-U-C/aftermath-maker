import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, type AccessRequest } from "./store.js";

type EmailOptions = {
  recipient: string;
  sender: string;
};

type MailSender = (
  email: string,
) => { ok: true } | { ok: false; error: string };

type DeliveryOptions = {
  store?: Store;
  recipient?: string;
  sender?: string;
  sendmailPath?: string;
  dailyCap?: number;
  now?: Date;
  send?: MailSender;
};

const DEFAULT_DAILY_CAP = 20;

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

function startOfUtcDay(date: Date): string {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  ).toISOString();
}

function configuredDailyCap(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_DAILY_CAP;
  if (!/^\d+$/.test(value)) {
    throw new Error(
      "ACCESS_REQUEST_EMAIL_DAILY_CAP must be a positive integer",
    );
  }
  const cap = Number(value);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 100) {
    throw new Error("ACCESS_REQUEST_EMAIL_DAILY_CAP must be between 1 and 100");
  }
  return cap;
}

function sendWithSendmail(sendmailPath: string): MailSender {
  return (email) => {
    const result = spawnSync(sendmailPath, ["-t", "-oi"], {
      input: email,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status === 0 && !result.error) return { ok: true };
    return {
      ok: false,
      error:
        result.error?.message ||
        result.stderr.trim() ||
        `sendmail exited with status ${result.status ?? "unknown"}`,
    };
  };
}

export function deliverAccessRequestNotifications(
  options: DeliveryOptions = {},
): {
  delivered: number;
  failed: number;
} {
  const databasePath = process.env.DATABASE_PATH ?? "data/maker.db";
  const recipient = options.recipient ?? process.env.ACCESS_REQUEST_EMAIL;
  const sender =
    options.sender ??
    process.env.ACCESS_REQUEST_EMAIL_FROM ??
    "Maker Access <maker@permanentupperclass.com>";
  if (!recipient) throw new Error("ACCESS_REQUEST_EMAIL must be configured");
  const store = options.store ?? new Store(databasePath);
  const ownsStore = !options.store;
  const dailyCap =
    options.dailyCap ??
    configuredDailyCap(process.env.ACCESS_REQUEST_EMAIL_DAILY_CAP);
  if (!Number.isSafeInteger(dailyCap) || dailyCap < 1 || dailyCap > 100) {
    throw new Error("Access request email daily cap must be between 1 and 100");
  }
  const send =
    options.send ??
    sendWithSendmail(
      options.sendmailPath ?? process.env.SENDMAIL_PATH ?? "/usr/sbin/sendmail",
    );
  const attemptedToday = store.countAccessRequestNotificationAttemptsSince(
    startOfUtcDay(options.now ?? new Date()),
  );
  const remaining = Math.max(0, dailyCap - attemptedToday);
  let delivered = 0;
  let failed = 0;

  if (remaining === 0) {
    if (ownsStore) store.close();
    return { delivered, failed };
  }

  try {
    for (const request of store.listPendingAccessRequestNotifications(
      remaining,
    )) {
      const result = send(
        formatAccessRequestEmail(request, { recipient, sender }),
      );
      if (result.ok) {
        store.markAccessRequestNotification(request.id, { ok: true });
        delivered += 1;
        continue;
      }

      store.markAccessRequestNotification(request.id, {
        ok: false,
        error: result.error,
      });
      failed += 1;
    }
  } finally {
    if (ownsStore) store.close();
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
