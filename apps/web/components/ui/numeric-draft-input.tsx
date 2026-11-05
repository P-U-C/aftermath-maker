"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { parseNumericDraft } from "../../lib/numeric-draft";

export function NumericDraftInput({
  id,
  label,
  unit,
  accessibleLabel,
  value,
  min,
  max,
  integer = false,
  onValue,
  onValidity,
  prefix,
  suffix,
  action,
}: {
  id: string;
  label: string;
  unit: string;
  accessibleLabel?: string;
  value: number;
  min: number;
  max: number;
  integer?: boolean;
  onValue: (value: number) => void;
  onValidity: (id: string, error: string | null) => void;
  /** With a prefix, suffix or action the field draws its own box, and an
   * error sits under the box, never inside it. */
  prefix?: string;
  suffix?: string;
  action?: ReactNode;
}) {
  // A setting saved before a field existed has no value. Show an empty box,
  // never the text "undefined".
  const display = (next: number) => (Number.isFinite(next) ? String(next) : "");
  const [text, setText] = useState(display(value));
  const [focused, setFocused] = useState(false);
  const lastExternalValue = useRef(value);
  const report = useRef(onValidity);
  report.current = onValidity;
  const { error } = parseNumericDraft(text, { label, unit, min, max, integer });

  useEffect(() => {
    // Controls such as Max are authoritative external changes.  A stale,
    // invalid draft must never keep the field, or the form's save blocker,
    // invalid after one.
    if (lastExternalValue.current !== value) {
      lastExternalValue.current = value;
      setText(display(value));
      report.current(id, null);
    } else if (!focused && !error) {
      setText(display(value));
    }
  }, [error, focused, id, value]);

  // When the field leaves the page its draft goes with it, and the saved value
  // is still the last valid one, so its error must not keep blocking saves.
  useEffect(() => () => report.current(id, null), [id]);

  const input = (
    <input
      id={id}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      value={text}
      aria-label={accessibleLabel ?? `${label} (${unit})`}
      aria-invalid={Boolean(error)}
      aria-describedby={error ? `${id}-error` : undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const result = parseNumericDraft(next, {
          label,
          unit,
          min,
          max,
          integer,
        });
        report.current(id, result.error);
        if (result.value !== null) onValue(result.value);
      }}
    />
  );
  const message = error ? (
    <small id={`${id}-error`} className="numeric-field-error" role="alert">
      {error}
    </small>
  ) : null;
  if (prefix === undefined && suffix === undefined && !action)
    return (
      <>
        {input}
        {message}
      </>
    );
  return (
    <>
      <div
        className={[
          "input-unit",
          suffix !== undefined && "suffix",
          action && "has-action",
          error && "is-invalid",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {prefix !== undefined && <b>{prefix}</b>}
        {input}
        {suffix !== undefined && <b>{suffix}</b>}
        {action}
      </div>
      {message}
    </>
  );
}
