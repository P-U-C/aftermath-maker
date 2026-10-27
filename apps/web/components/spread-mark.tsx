type SpreadMarkProps = {
  state: "stopped" | "paper" | "live";
  size?: number;
  label?: string;
};

export function SpreadMark({ state, size = 30, label }: SpreadMarkProps) {
  const stopped = state === "stopped";
  const paper = state === "paper";

  return (
    <span
      className="spread-mark"
      style={{ width: size, height: size, borderRadius: size * 0.3 }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-state={state}
    >
      <svg
        width={size * 0.6}
        height={size * 0.6}
        viewBox="0 0 18 18"
        aria-hidden="true"
      >
        <rect
          className="spread-mark-ask"
          x="7.6"
          y="4.2"
          width="8.6"
          height="3.6"
          rx="1.8"
          fill={paper ? "none" : stopped ? "var(--ink-3)" : "var(--ember)"}
          stroke={paper ? "currentColor" : "none"}
          strokeWidth={paper ? "1.3" : "0"}
        />
        <rect
          className="spread-mark-bid"
          x="1.8"
          y="10.2"
          width="8.6"
          height="3.6"
          rx="1.8"
          fill={paper ? "none" : stopped ? "var(--ink-3)" : "var(--tide)"}
          stroke={paper ? "currentColor" : "none"}
          strokeWidth={paper ? "1.3" : "0"}
        />
      </svg>
    </span>
  );
}
