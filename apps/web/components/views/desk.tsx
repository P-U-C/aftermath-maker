import type { ReactNode } from "react";

import { ViewFrame } from "./view-frame";

export function DeskView({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <ViewFrame active={active} name="desk">
      {children}
    </ViewFrame>
  );
}
