"use client";

import { useEffect, useRef, useState } from "react";
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
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const lastExternalValue = useRef(value);
  const { error } = parseNumericDraft(text, { label, unit, min, max, integer });

  useEffect(() => {
    // Controls such as Max are authoritative external changes.  A stale,
    // invalid draft must never keep the field visually invalid after one.
    if (lastExternalValue.current !== value) {
      lastExternalValue.current = value;
      setText(String(value));
      onValidity(id, null);
    } else if (!focused && !error) {
      setText(String(value));
    }
  }, [error, focused, id, onValidity, value]);

  return (
    <>
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
          onValidity(id, result.error);
          if (result.value !== null) onValue(result.value);
        }}
      />
      {error && (
        <small id={`${id}-error`} className="numeric-field-error" role="alert">
          {error}
        </small>
      )}
    </>
  );
}
