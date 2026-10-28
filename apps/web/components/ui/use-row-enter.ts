"use client";

import { useEffect, useRef, useState } from "react";

type RowWithId = { id: string | number };

/** Marks only rows that arrive after the initial data paint. */
export function useRowEnter<T extends RowWithId>(rows: readonly T[]) {
  const seen = useRef<Set<string> | null>(null);
  const [entering, setEntering] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const ids = rows.map((row) => String(row.id));
    if (!seen.current) {
      seen.current = new Set(ids);
      return;
    }

    const incoming = ids.filter((id) => !seen.current?.has(id));
    seen.current = new Set(ids);
    if (!incoming.length) return;

    setEntering((current) => new Set([...current, ...incoming]));
    const timer = window.setTimeout(() => {
      setEntering((current) => {
        const next = new Set(current);
        incoming.forEach((id) => next.delete(id));
        return next;
      });
    }, 1_400);
    return () => window.clearTimeout(timer);
  }, [rows]);

  return (id: string | number, tone: "bid" | "ask" | "neutral" = "neutral") =>
    entering.has(String(id)) ? `row-enter row-enter-${tone}` : undefined;
}
