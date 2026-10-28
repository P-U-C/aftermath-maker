import { describe, expect, it } from "vitest";

import { formatAccessRequestEmail } from "../src/access-request-notifier.js";

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
});
