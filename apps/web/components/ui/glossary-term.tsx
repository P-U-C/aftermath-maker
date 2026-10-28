"use client";

import { useId, type ReactNode } from "react";
import { glossary, type GlossaryKey } from "../../lib/glossary";

type GlossaryTermProps = {
  definition?: string;
  term?: GlossaryKey;
  children: ReactNode;
};

/**
 * Inline definition that appears on hover or keyboard focus. Native `title`
 * tooltips wait over a second before the browser shows them, which reads as
 * broken help, so the definition is rendered and revealed by CSS instead.
 */
export function GlossaryTerm({
  definition,
  term,
  children,
}: GlossaryTermProps) {
  const tipId = useId();
  const entry = term ? glossary[term] : null;
  const resolvedDefinition = entry?.definition ?? definition;
  if (!resolvedDefinition) return <>{children}</>;
  return (
    <span className="glossary-term" tabIndex={0} aria-describedby={tipId}>
      {children}
      <span className="glossary-tip" id={tipId} role="tooltip">
        {resolvedDefinition}
        {entry && "animation" in entry && (
          <a href={entry.animation} className="glossary-learn-link">
            See it animated
          </a>
        )}
      </span>
    </span>
  );
}
