import type { ReactNode } from "react";

import { ViewFrame } from "./view-frame";

export function MarketsView({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <ViewFrame active={active} name="markets">
      {children}
    </ViewFrame>
  );
}
