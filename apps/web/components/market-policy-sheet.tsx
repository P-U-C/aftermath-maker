"use client";

import { useRef, useState } from "react";
import {
  makerMarketOverridesSchema,
  type MakerMarketOverrides,
} from "@puc/core";
import { configsEqual } from "../lib/config-equality";
import { Button, Sheet } from "./ui/primitives";

type FieldKey = keyof MakerMarketOverrides;
const fields: Array<{
  key: FieldKey;
  label: string;
  note: string;
  unit: string;
  min: number;
  max: number;
  exclusiveMin?: boolean;
}> = [
  {
    key: "quoteSizeUsd",
    label: "Quote size",
    note: "per side",
    unit: "$",
    min: 0,
    exclusiveMin: true,
    max: 1000,
  },
  {
    key: "spreadBps",
    label: "Spread",
    note: "on each side",
    unit: "bps",
    min: 8,
    max: 500,
  },
  {
    key: "maxInventoryUsd",
    label: "Largest position",
    note: "long or short",
    unit: "$",
    min: 0,
    exclusiveMin: true,
    max: 10000,
  },
  {
    key: "inventoryTargetUsd",
    label: "Target position",
    note: "signed inventory",
    unit: "$",
    min: -10000,
    max: 10000,
  },
  {
    key: "inventorySkewBps",
    label: "Inventory skew",
    note: "toward target",
    unit: "bps",
    min: 0,
    max: 250,
  },
  {
    key: "maxLeverage",
    label: "Leverage",
    note: "maximum",
    unit: "×",
    min: 1,
    max: 3,
  },
];

const display = (value: number, unit: string) =>
  unit === "$"
    ? `$${value.toFixed(2)}`
    : `${value}${unit === "×" ? "×" : " bps"}`;

export function MarketPolicySheet({
  symbol,
  strategyName,
  bundleNames,
  defaults,
  current,
  blocked,
  onClose,
  onOpenStrategy,
  onSave,
}: {
  symbol: string;
  strategyName: string;
  bundleNames: string[];
  defaults: Record<FieldKey, number>;
  current: MakerMarketOverrides;
  blocked: boolean;
  onClose: () => void;
  onOpenStrategy: () => void;
  onSave: (overrides: MakerMarketOverrides) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<FieldKey, string>>(
    () =>
      Object.fromEntries(
        fields.map(({ key }) => [
          key,
          current[key] === undefined ? "" : String(current[key]),
        ]),
      ) as Record<FieldKey, string>,
  );
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const parsed = {} as MakerMarketOverrides;
  const errors: Partial<Record<FieldKey, string>> = {};
  for (const field of fields) {
    const text = draft[field.key].trim();
    if (!text) continue;
    const value = Number(text);
    if (
      !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text) ||
      !Number.isFinite(value) ||
      (field.exclusiveMin ? value <= field.min : value < field.min) ||
      value > field.max ||
      (field.key === "maxLeverage" && !Number.isInteger(value))
    ) {
      errors[field.key] = field.exclusiveMin
        ? `${field.label} must be greater than 0 and at most ${field.max} USD.`
        : `${field.label} must be between ${field.min} and ${field.max} ${field.unit === "$" ? "USD" : field.unit === "×" ? "×" : "bps"}.`;
      continue;
    }
    parsed[field.key] = value;
  }
  const valid =
    Object.keys(errors).length === 0 &&
    makerMarketOverridesSchema.safeParse(parsed).success;
  const changed = !configsEqual(parsed, current);
  const close = () => {
    if (!inFlight.current) onClose();
  };

  async function save() {
    if (inFlight.current || !valid || !changed || blocked) return;
    inFlight.current = true;
    setBusy(true);
    setServerError(null);
    try {
      await onSave(parsed);
    } catch (error) {
      setServerError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      title={`${symbol} policy`}
      className="market-policy"
      description={`Part of ${strategyName}, used by ${bundleNames.length ? bundleNames.join(", ") : "no bundles yet"}.`}
      onClose={close}
      footer={
        blocked ? undefined : (
          <>
            <Button
              variant="quiet"
              className="market-policy-inherit-all"
              onClick={() =>
                setDraft(
                  Object.fromEntries(
                    fields.map(({ key }) => [key, ""]),
                  ) as Record<FieldKey, string>,
                )
              }
              disabled={busy || Object.values(draft).every((value) => !value)}
            >
              Use strategy for all
            </Button>
            <Button variant="quiet" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={busy || !valid || !changed}
            >
              {" "}
              {busy ? "Saving…" : `Save to ${strategyName}`}{" "}
            </Button>
          </>
        )
      }
    >
      <p className="market-policy-intro">
        Empty fields use the strategy&apos;s value. Anything you set here
        applies to {symbol} in every bundle that uses {strategyName}.
      </p>
      {blocked ? (
        <div className="market-policy-blocked" role="status">
          {strategyName} has changes you haven&apos;t applied yet. Apply or
          discard them in Strategy, then come back to edit {symbol}.
          <Button variant="quiet" onClick={onOpenStrategy}>
            Open Strategy
          </Button>
        </div>
      ) : (
        <div className="market-policy-fields">
          {fields.map((field) => {
            const custom = Boolean(draft[field.key].trim());
            const error = errors[field.key];
            const inherited = defaults[field.key];
            return (
              <div className="market-policy-field" key={field.key}>
                <label htmlFor={`policy-${field.key}`}>
                  <strong>{field.label}</strong>
                  <small>{field.note}</small>
                </label>
                <div className="market-policy-field-control">
                  <span
                    className={`market-policy-input ${custom ? "is-custom" : ""} ${error ? "is-invalid" : ""}`}
                  >
                    {field.unit === "$" && <b aria-hidden="true">$</b>}
                    <input
                      id={`policy-${field.key}`}
                      type="text"
                      inputMode="decimal"
                      value={draft[field.key]}
                      placeholder={String(inherited)}
                      aria-label={`${field.label} ${field.note}`}
                      aria-invalid={Boolean(error)}
                      aria-describedby={
                        error ? `policy-${field.key}-error` : undefined
                      }
                      onChange={(event) => {
                        setDraft((existing) => ({
                          ...existing,
                          [field.key]: event.target.value,
                        }));
                        setServerError(null);
                      }}
                    />
                    {field.unit !== "$" && (
                      <b aria-hidden="true">{field.unit}</b>
                    )}
                  </span>
                  <button
                    type="button"
                    aria-label={`Use strategy ${field.label.toLowerCase()}`}
                    title="Use strategy value"
                    onClick={() =>
                      setDraft((existing) => ({ ...existing, [field.key]: "" }))
                    }
                    disabled={!custom}
                  >
                    ↺
                  </button>
                </div>
                <small
                  id={`policy-${field.key}-error`}
                  className={
                    error
                      ? "market-policy-field-error"
                      : custom
                        ? "market-policy-field-custom"
                        : "market-policy-field-inherit"
                  }
                >
                  {error ??
                    (custom
                      ? `Custom. Strategy uses ${display(inherited, field.unit)}`
                      : "Strategy value")}
                </small>
              </div>
            );
          })}
        </div>
      )}
      {serverError && (
        <p role="alert" className="market-policy-server-error">
          {serverError}
        </p>
      )}
    </Sheet>
  );
}
