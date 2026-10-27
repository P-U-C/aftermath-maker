import type { ReactNode } from "react";

import { ViewFrame } from "./view-frame";

export function AccountsView({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <ViewFrame active={active} name="accounts">
      {children}
    </ViewFrame>
  );
}
