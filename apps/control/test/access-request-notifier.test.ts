import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  deliverAccessRequestNotifications,
  formatAccessRequestEmail,
} from "../src/access-request-notifier.js";
import { Store } from "../src/store.js";

describe("access request notification email", () => {
  it("contains the review details without allowing header injection", () => {
    const email = formatAccessRequestEmail(
      {
        id: 7,
        walletAddress: `0x${"a".repeat(64)}`,
        twitterHandle: "@maker_user",
        status: "pending",
        requestedAt: "2026-10-28T12:00:00.000Z",
        updatedAt: "2026-10-28T12:00:00.000Z",
        notifiedAt: null,
        notificationAttempts: 0,
        notificationError: null,
      },
      {
        recipient: "zeroexzoz@gmail.com\nBcc: attacker@example.com",
        sender: "Maker Access <maker@permanentupperclass.com>",
      },
    );

    expect(email).toContain(
      "To: zeroexzoz@gmail.com Bcc: attacker@example.com",
    );
    expect(email).not.toContain("\nBcc:");
    expect(email).toContain("X / Twitter: @maker_user");
    expect(email).toContain(`Wallet: 0x${"a".repeat(64)}`);
  });

  it("caps notification emails per UTC day", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-notifier-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const store = new Store(join(directory, "maker.db"));
    for (const digit of ["1", "2", "3"]) {
      store.createAccessRequest({
        walletAddress: `0x${digit.repeat(64)}`,
        twitterHandle: `@maker_${digit}`,
      });
    }
    const emails: string[] = [];
    const now = new Date();

    const result = deliverAccessRequestNotifications({
      store,
      recipient: "operator@example.com",
      sender: "Maker Access <maker@example.com>",
      dailyCap: 2,
      now,
      send: (email) => {
        emails.push(email);
        return { ok: true };
      },
    });

    expect(result).toEqual({ delivered: 2, failed: 0 });
    expect(emails).toHaveLength(2);
    expect(store.listPendingAccessRequestNotifications()).toHaveLength(1);
    expect(
      deliverAccessRequestNotifications({
        store,
        recipient: "operator@example.com",
        sender: "Maker Access <maker@example.com>",
        dailyCap: 2,
        now: new Date(now.getTime() + 60_000),
        send: () => {
          throw new Error("daily cap should prevent delivery");
        },
      }),
    ).toEqual({ delivered: 0, failed: 0 });
    store.close();
  });

  it("requires the notification recipient to be configured", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-notifier-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const store = new Store(join(directory, "maker.db"));
    expect(() =>
      deliverAccessRequestNotifications({
        store,
        recipient: "",
        dailyCap: 1,
      }),
    ).toThrow("ACCESS_REQUEST_EMAIL must be configured");
    store.close();
  });

  it("counts failed notification attempts toward the daily cap", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-notifier-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const store = new Store(join(directory, "maker.db"));
    store.createAccessRequest({
      walletAddress: `0x${"4".repeat(64)}`,
      twitterHandle: "@maker_4",
    });
    const now = new Date();

    expect(
      deliverAccessRequestNotifications({
        store,
        recipient: "operator@example.com",
        sender: "Maker Access <maker@example.com>",
        dailyCap: 1,
        now,
        send: () => ({ ok: false, error: "mail unavailable" }),
      }),
    ).toEqual({ delivered: 0, failed: 1 });
    expect(
      deliverAccessRequestNotifications({
        store,
        recipient: "operator@example.com",
        sender: "Maker Access <maker@example.com>",
        dailyCap: 1,
        now: new Date(now.getTime() + 60_000),
        send: () => {
          throw new Error("daily cap should prevent another send attempt");
        },
      }),
    ).toEqual({ delivered: 0, failed: 0 });
    store.close();
  });
});
