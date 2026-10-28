"use client";

import { useId, type ReactNode } from "react";

type GlossaryTermProps = {
  definition: string;
  children: ReactNode;
};

/**
 * Inline definition that appears on hover or keyboard focus. Native `title`
 * tooltips wait over a second before the browser shows them, which reads as
 * broken help, so the definition is rendered and revealed by CSS instead.
 */
export function GlossaryTerm({ definition, children }: GlossaryTermProps) {
  const tipId = useId();
  return (
    <span className="glossary-term" tabIndex={0} aria-describedby={tipId}>
      {children}
      <span className="glossary-tip" id={tipId} role="tooltip">
        {definition}
      </span>
    </span>
  );
}
