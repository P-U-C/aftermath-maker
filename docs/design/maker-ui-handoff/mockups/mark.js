// The spread mark: an ask capsule above a bid capsule, offset by the spread.
// stopped: capsules stacked flush (no spread). paper: outlined. live: filled in Tide and Ember.
function markSVG(state, px) {
  const s = px || 18;
  const tide = "var(--tide)", ember = "var(--ember)";
  if (state === "stopped") {
    return `<svg width="${s}" height="${s}" viewBox="0 0 18 18"><rect x="4.5" y="4.5" width="9" height="3.6" rx="1.8" fill="#9aa0aa"/><rect x="4.5" y="9.9" width="9" height="3.6" rx="1.8" fill="#9aa0aa"/></svg>`;
  }
  if (state === "paper") {
    return `<svg width="${s}" height="${s}" viewBox="0 0 18 18"><rect x="7.6" y="4.2" width="8.6" height="3.6" rx="1.8" fill="none" stroke="#fff" stroke-width="1.3"/><rect x="1.8" y="10.2" width="8.6" height="3.6" rx="1.8" fill="none" stroke="#fff" stroke-width="1.3"/></svg>`;
  }
  return `<svg width="${s}" height="${s}" viewBox="0 0 18 18"><rect x="7.6" y="4.2" width="8.6" height="3.6" rx="1.8" fill="${ember}"/><rect x="1.8" y="10.2" width="8.6" height="3.6" rx="1.8" fill="${tide}"/></svg>`;
}
function applyTheme() {
  const q = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = q.get("theme") === "dark" ? "dark" : "light";
  return q;
}
