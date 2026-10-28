// The Maker mark: your ask resting above your bid, one step apart, on an ink tile.
// It is the centre of the desk's order book: asks above the price, bids below it,
// and the gap between the two capsules is the spread.
//
// 16-unit master. Capsules 8 x 3.5, a 1.5 spread gap and a 3 unit overlap, so the step
// runs 5 across and 5 down (45 degrees). At 20 px and below a small cut takes over with
// whole-pixel geometry (8 x 4, gap 2, overlap 2) so the mark stays crisp at 16 px.
const MAKER_MARK = {
  master: { L: 8, h: 3.5, g: 1.5, o: 3 },
  small: { L: 8, h: 4, g: 2, o: 2 },
  ask: "#FF6F61", // Ember, tuned for the ink tile
  bid: "#22C7BA", // Tide, tuned for the ink tile
  paper: "#C9CDD3",
  stopped: "#5E636E",
};
// Continuous-corner tile (the iOS icon curve), corner radius 3.6 of 16.
const MAKER_TILE = "M5.503 0L10.497 0C12.081 0 12.874 0 13.588 0.236L13.727 0.27C14.658 0.609 15.391 1.342 15.73 2.273C16 3.126 16 3.919 16 5.503L16 10.497C16 12.081 16 12.874 15.764 13.588L15.73 13.727C15.391 14.658 14.658 15.391 13.727 15.73C12.874 16 12.081 16 10.497 16L5.503 16C3.919 16 3.126 16 2.412 15.764L2.273 15.73C1.342 15.391 0.609 14.658 0.27 13.727C0 12.874 0 12.081 0 10.497L0 5.503C0 3.919 0 3.126 0.236 2.412L0.27 2.273C0.609 1.342 1.342 0.609 2.273 0.27C3.126 0 3.919 0 5.503 0Z";

function markCapsules(geo, state) {
  const { L, h, g } = geo;
  const o = state === "stopped" ? L : geo.o; // stopped: no spread, the capsules line up
  return {
    ask: { x: 8 - o / 2, y: 8 - g / 2 - h, w: L, h },
    bid: { x: 8 + o / 2 - L, y: 8 + g / 2, w: L, h },
  };
}

// state: "live" | "paper" | "stopped". size: px number or any CSS length ("1.08em").
function markSVG(state = "live", size = 24, opts = {}) {
  const px = typeof size === "number" ? size : 24;
  const geo = opts.small ?? (px <= 20 ? MAKER_MARK.small : MAKER_MARK.master);
  const c = markCapsules(geo, state);
  const tile = opts.tile === false ? "" :
    `<path d="${MAKER_TILE}" fill="var(--icon-bg, #16181D)"/><path d="${MAKER_TILE}" fill="none" stroke="var(--mark-edge, transparent)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  const cap = (k) => {
    const r = c[k];
    if (state === "paper") {
      const sw = Math.max(0.6, 16 / px);
      return `<rect x="${r.x + sw / 2}" y="${r.y + sw / 2}" width="${r.w - sw}" height="${r.h - sw}" rx="${(r.h - sw) / 2}" fill="none" stroke="${MAKER_MARK.paper}" stroke-width="${sw}"/>`;
    }
    const fill = state === "stopped" ? MAKER_MARK.stopped : opts[k] || MAKER_MARK[k];
    return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${r.h / 2}" fill="${fill}"/>`;
  };
  const w = typeof size === "number" ? `${size}` : size;
  const label = { live: "Maker, live", paper: "Maker, paper trading", stopped: "Maker, stopped" }[state];
  return `<svg width="${w}" height="${w}" viewBox="0 0 16 16" role="img" aria-label="${label}">${tile}${cap("ask")}${cap("bid")}</svg>`;
}

// Lockup: the tile at 1.08 em, a 0.38 em gap, then "Maker". Size it with font-size on the container.
function wordmarkHTML(state = "live") {
  return markSVG(state, "1.08em") + "<span>Maker</span>";
}

function applyTheme() {
  const q = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = q.get("theme") === "dark" ? "dark" : "light";
  return q;
}
