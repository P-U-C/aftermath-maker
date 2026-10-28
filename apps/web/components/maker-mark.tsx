import type { CSSProperties } from "react";

export type MakerMarkState = "stopped" | "paper" | "live";

type MakerMarkProps = {
  state: MakerMarkState;
  size?: number | string;
  label?: string;
  className?: string;
};

const MAKER_TILE =
  "M5.503 0L10.497 0C12.081 0 12.874 0 13.588 0.236L13.727 0.27C14.658 0.609 15.391 1.342 15.73 2.273C16 3.126 16 3.919 16 5.503L16 10.497C16 12.081 16 12.874 15.764 13.588L15.73 13.727C15.391 14.658 14.658 15.391 13.727 15.73C12.874 16 12.081 16 10.497 16L5.503 16C3.919 16 3.126 16 2.412 15.764L2.273 15.73C1.342 15.391 0.609 14.658 0.27 13.727C0 12.874 0 12.081 0 10.497L0 5.503C0 3.919 0 3.126 0.236 2.412L0.27 2.273C0.609 1.342 1.342 0.609 2.273 0.27C3.126 0 3.919 0 5.503 0Z";

const labels: Record<MakerMarkState, string> = {
  live: "Maker, live",
  paper: "Maker, paper trading",
  stopped: "Maker, stopped",
};

function capsuleGeometry(small: boolean) {
  const length = 8;
  const height = small ? 4 : 3.5;
  const gap = small ? 2 : 1.5;
  const overlap = small ? 2 : 3;
  return {
    ask: {
      x: 8 - overlap / 2,
      y: 8 - gap / 2 - height,
      width: length,
      height,
    },
    bid: {
      x: 8 + overlap / 2 - length,
      y: 8 + gap / 2,
      width: length,
      height,
    },
  };
}

function Capsule({
  kind,
  state,
  geometry,
}: {
  kind: "ask" | "bid";
  state: MakerMarkState;
  geometry: { x: number; y: number; width: number; height: number };
}) {
  const paper = state === "paper";
  const fill =
    state === "stopped" ? "#5E636E" : kind === "ask" ? "#FF6F61" : "#22C7BA";
  const strokeWidth = paper ? 0.8 : 0;
  return (
    <rect
      className={`maker-mark-capsule maker-mark-${kind}`}
      x={paper ? geometry.x + strokeWidth / 2 : geometry.x}
      y={paper ? geometry.y + strokeWidth / 2 : geometry.y}
      width={paper ? geometry.width - strokeWidth : geometry.width}
      height={paper ? geometry.height - strokeWidth : geometry.height}
      rx={(paper ? geometry.height - strokeWidth : geometry.height) / 2}
      fill={paper ? "none" : fill}
      stroke={paper ? "#C9CDD3" : "none"}
      strokeWidth={strokeWidth}
    />
  );
}

export function MakerMark({
  state,
  size = 30,
  label,
  className,
}: MakerMarkProps) {
  const numericSize = typeof size === "number" ? size : undefined;
  const small = numericSize !== undefined && numericSize <= 20;
  const capsules = capsuleGeometry(small);
  const style = {
    "--maker-mark-size": typeof size === "number" ? `${size}px` : size,
  } as CSSProperties;

  return (
    <span
      className={["maker-mark", className].filter(Boolean).join(" ")}
      style={style}
      role={label ? "img" : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      data-state={state}
      data-small={small || undefined}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
      >
        <path d={MAKER_TILE} fill="var(--icon-bg)" />
        <path
          d={MAKER_TILE}
          fill="none"
          stroke="var(--mark-edge)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        <Capsule kind="ask" state={state} geometry={capsules.ask} />
        <Capsule kind="bid" state={state} geometry={capsules.bid} />
      </svg>
      <span className="sr-only">{label ?? labels[state]}</span>
    </span>
  );
}

export function MakerWordmark({
  state,
  className,
}: {
  state: MakerMarkState;
  className?: string;
}) {
  return (
    <span className={["maker-wordmark", className].filter(Boolean).join(" ")}>
      <MakerMark state={state} size="1.08em" />
      <span>Maker</span>
    </span>
  );
}
