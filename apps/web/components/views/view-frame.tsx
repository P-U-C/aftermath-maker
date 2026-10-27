import type { ReactNode } from "react";

import type { MakerView } from "../maker-shell";

export type MakerViewProps = {
  active: boolean;
  children: ReactNode;
  name: MakerView;
};

export function ViewFrame({ active, children, name }: MakerViewProps) {
  return (
    <div
      className={`maker-view maker-view-${name}`}
      data-view={name}
      hidden={!active}
    >
      {children}
    </div>
  );
}
