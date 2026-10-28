"use client";

import {
  useCurrentAccount,
  useCurrentWallet,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { ConnectModal } from "@mysten/dapp-kit-react/ui";
import type { DAppKitConnectModal } from "@mysten/dapp-kit-core/web";
import { Check, ChevronDown, Copy, LogOut, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { shortAddress } from "../lib/address";

/**
 * Wallet control for every screen that runs before a Maker session exists.
 * A connected wallet always stays visible and disconnectable, whether the
 * access signature is pending, rejected, or refused by the registry.
 */
export function WalletControl() {
  const dAppKit = useDAppKit();
  const account = useCurrentAccount();
  const wallet = useCurrentWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDetailsElement>(null);
  const modalRef = useRef<DAppKitConnectModal>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (!account) return null;

  const accounts = wallet?.accounts ?? [account];
  const walletName = wallet?.name ?? "Connected wallet";

  return (
    <>
      <details
        className="maker-wallet-menu wallet-control"
        data-wallet-control=""
        ref={containerRef}
        open={open}
      >
        <summary
          aria-label={`Wallet ${shortAddress(account.address)}`}
          onClick={(event) => {
            event.preventDefault();
            setOpen((current) => !current);
          }}
        >
          {wallet?.icon ? (
            <img src={wallet.icon} alt="" width={16} height={16} />
          ) : null}
          <span>{shortAddress(account.address)}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </summary>

        <div className="maker-wallet-popover" data-wallet-popover="">
          <div className="maker-wallet-heading">
            <span>{walletName}</span>
            <strong>{shortAddress(account.address)}</strong>
            <small>{account.address}</small>
          </div>

          <div className="wallet-control-accounts">
            <span className="wallet-control-label">
              {accounts.length > 1 ? "Accounts in this wallet" : "Account"}
            </span>
            {accounts.map((candidate) => {
              const active =
                candidate.address.toLowerCase() ===
                account.address.toLowerCase();
              return (
                <button
                  key={candidate.address}
                  type="button"
                  className={active ? "is-active" : undefined}
                  aria-pressed={active}
                  onClick={() => {
                    if (!active) dAppKit.switchAccount({ account: candidate });
                    setOpen(false);
                  }}
                >
                  <span>{shortAddress(candidate.address)}</span>
                  {active ? <Check size={15} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>

          <div className="maker-wallet-actions">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(account.address)
                  .then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1_500);
                  })
                  .catch(() => undefined);
              }}
            >
              <Copy size={15} aria-hidden="true" />
              {copied ? "Copied" : "Copy address"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                modalRef.current?.show();
              }}
            >
              <Plus size={15} aria-hidden="true" />
              Connect another wallet
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void dAppKit.disconnectWallet().catch(() => undefined);
              }}
            >
              <LogOut size={15} aria-hidden="true" />
              Disconnect
            </button>
          </div>
        </div>
      </details>
      {/* Kept outside <details> so the picker still renders once the menu closes. */}
      <ConnectModal ref={modalRef} />
    </>
  );
}
