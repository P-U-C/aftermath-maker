"use client";

import { useEffect, useRef, useState } from "react";

type AnimatedNumberProps = {
  value: string;
  className?: string;
  /** Stable identifier for visual-regression checks. */
  motionId?: string;
};

/**
 * Swaps a tabular value without delaying the new value. The old glyphs are
 * presentational only, so assistive technology announces the settled number once.
 */
export function AnimatedNumber({
  value,
  className,
  motionId,
}: AnimatedNumberProps) {
  const latest = useRef(value);
  const [previous, setPrevious] = useState(value);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    if (value === latest.current) return;
    const before = latest.current;
    latest.current = value;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPrevious(value);
      setChanging(false);
      return;
    }

    setPrevious(before);
    setChanging(true);
    const timer = window.setTimeout(() => setChanging(false), 200);
    return () => window.clearTimeout(timer);
  }, [value]);

  return (
    <span
      className={["animated-number", changing ? "is-changing" : null, className]
        .filter(Boolean)
        .join(" ")}
      data-motion-number={motionId}
      aria-live="polite"
      aria-atomic="true"
    >
      {changing && (
        <span className="animated-number-old" aria-hidden="true">
          {previous}
        </span>
      )}
      <span className="animated-number-current">{value}</span>
    </span>
  );
}
