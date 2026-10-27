import type { ReactNode } from "react";

import { ViewFrame } from "./view-frame";

export function StrategyView({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <ViewFrame active={active} name="strategy">
      {children}
    </ViewFrame>
  );
}
