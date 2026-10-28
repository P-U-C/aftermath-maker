// Explain mode: places numbered coach marks next to the element each one explains.
// In the app this is a first-run tour and an always-available "Explain" switch in the nav.
function placeCoach() {
  const marks = document.querySelectorAll(".coach");
  marks.forEach((c) => (c.style.display = "block"));
  marks.forEach((c) => {
    const t = document.querySelector(c.dataset.for);
    if (!t) return;
    t.classList.add("hl");
    const r = t.getBoundingClientRect();
    const sx = window.scrollX, sy = window.scrollY;
    const w = c.offsetWidth, h = c.offsetHeight;
    let x = r.left + sx, y = r.bottom + sy + 14;
    switch (c.dataset.pos) {
      case "right": x = r.right + sx + 18; y = r.top + sy - 6; break;
      case "left": x = r.left + sx - w - 18; y = r.top + sy - 4; break;
      case "below-left": x = r.left + sx + 30; y = r.bottom + sy + 14; break;
      case "below-right": x = r.right + sx - w + 20; y = r.bottom + sy + 14; break;
      case "above-right": x = r.right + sx - w; y = r.top + sy - h - 14; break;
    }
    c.style.left = Math.max(12, x) + "px";
    c.style.top = Math.max(12, y) + "px";
  });
}
