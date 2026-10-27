import type { ReactNode } from "react";

import { ViewFrame } from "./view-frame";

export function PerformanceView({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <ViewFrame active={active} name="performance">
      {children}
    </ViewFrame>
  );
}
