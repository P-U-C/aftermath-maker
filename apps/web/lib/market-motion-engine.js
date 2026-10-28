// Maker motion v3: the mirrored book.
//
// Price runs left to right. Asks rise above the axis on the right and bids hang below it on
// the left, so the picture has the shape of the Maker mark: your ask capsule rests just above
// the axis, your bid capsule just below, and the gap between them is your spread.
// Sellers come down to hit bids and buyers come up to lift asks. A filled order folds into a
// dot that drops into inventory, Maker re-quotes with skew, and past the trigger the taker
// account sends a market order into the book to flatten.
//
// sim (default true) runs an illustration. With sim: false the desk drives the same scene
// from real data through update(), fill() and hedge(); nothing is invented.
//
// Ported from docs/design/maker-ui-handoff-v3/mockups/motion.js (v3). Keep the two in step:
// the mockup is the reference for timing and choreography.
const NS = "http://www.w3.org/2000/svg";
const E = (tag, attrs, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
};
const S = (el, css) => el.setAttribute("style", css);
function rng(seed) {
  let a = (seed || 7) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeIn = (t) => t * t * t;
const fmt = (p) => p.toFixed(6);
const usd = (v) => (v < 0 ? "−" : "") + "$" + Math.abs(v).toFixed(2);
// Damped spring step. zeta 1 is critically damped: it settles without overshoot.
function spring(s, target, omega, zeta, dt) {
  s.v += (omega * omega * (target - s.x) - 2 * zeta * omega * s.v) * dt;
  s.x += s.v * dt;
}
const quad = (a, c, b, p) =>
  (1 - p) * (1 - p) * a + 2 * (1 - p) * p * c + p * p * b;

export function mountMarketMotion(host, o = {}) {
  const hostW = host.getBoundingClientRect().width || 0;
  const autoPhone = !o.viewWidth && hostW > 0 && hostW < 620;
  const compact = !!o.compact || autoPhone;
  const W = o.viewWidth || (autoPhone ? 440 : 1000);
  const phone = W < 700;
  // Text is set in viewBox units, so scale it to land near 13 px on screen.
  const shown = hostW ? hostW / W : phone ? 0.76 : 0.94;
  const fs = o.fontScale || clamp(0.96 / shown, 1, 1.6);
  const H = o.height || (compact ? 236 : 340);
  const axisY = Math.round(H / 2);
  const capH = compact ? (phone ? 17 : 16) : 20;
  const capL = Math.round(capH * 2.29);
  const laneGap = Math.round(capH * 0.44) / 2;
  const barBase = laneGap + capH + (compact ? 6 : 8);
  const barMax = axisY - barBase - (compact ? 10 : 18);
  const spread = o.spreadBps || 32;
  const pxPerBps = o.pxPerBps || (phone ? 2.7 : compact ? 4.4 : 5);
  const tick = o.tickBps || (phone ? 5 : 2);
  const pitch = tick * pxPerBps;
  const barW = Math.max(4, Math.min(7, pitch * 0.48));
  const size = o.sizeUsd || 100;
  const trigger = o.hedgeTriggerUsd || 2 * size;
  const skewPerFill = o.skewBpsPerFill || Math.min(8, spread / 5);
  const bookOff = 3;
  const rand = rng(o.seed || 11);
  const live = o.sim === false;
  const reduce =
    !!o.static ||
    (window.matchMedia &&
      matchMedia("(prefers-reduced-motion: reduce)").matches);
  const mid0 = o.mid || 0.021441;
  const cx = W / 2;
  // Tints read lighter on a dark surface, so the book needs more opacity there.
  let tintBoost = { ask: 1, bid: 1 };
  const readTheme = () => {
    const v = getComputedStyle(host).getPropertyValue("--surface").trim();
    const m = v.match(/^#([0-9a-f]{6})$/i);
    const lum = m
      ? parseInt(m[1].slice(0, 2), 16) * 0.3 +
        parseInt(m[1].slice(2, 4), 16) * 0.59 +
        parseInt(m[1].slice(4, 6), 16) * 0.11
      : 255;
    tintBoost = lum < 90 ? { ask: 2.5, bid: 1.7 } : { ask: 1, bid: 1.22 };
  };
  readTheme();
  const txt = (px, extra = "") =>
    `font-size:${(px * fs).toFixed(2)}px;${extra}`;

  // ---------- scene ----------
  const svg = E(
    "svg",
    {
      viewBox: `0 0 ${W} ${H}`,
      role: "img",
      "aria-label":
        "Order book. Your ask rests above the market price and your bid below it. Takers fill them, and inventory is hedged past your trigger.",
    },
    host,
  );
  S(
    svg,
    "display:block;width:100%;height:auto;overflow:visible;font-family:var(--motion-font, system-ui, sans-serif);font-variant-numeric:tabular-nums",
  );
  const gBook = E("g", {}, svg);
  const gAxis = E("g", {}, svg);
  const gOurs = E("g", {}, svg);
  const gInfo = E("g", {}, svg);
  const gFx = E("g", {}, svg);

  const axis = E("line", { y1: axisY, y2: axisY, "stroke-width": 1 }, gAxis);
  S(axis, "stroke: var(--ink-3); stroke-opacity: .32");
  const spreadSeg = E(
    "line",
    { y1: axisY, y2: axisY, "stroke-width": 1.5, "stroke-linecap": "round" },
    gAxis,
  );
  S(spreadSeg, "stroke: var(--ink-3); stroke-opacity: .55");
  const midTick = E(
    "line",
    { "stroke-width": 1.25, "stroke-linecap": "round" },
    gAxis,
  );
  S(midTick, "stroke: var(--ink-2)");
  const midDot = E("circle", { r: compact ? 2.5 : 3, cy: axisY }, gAxis);
  S(midDot, "fill: var(--ink)");

  // Book levels sit on an absolute price grid, so the book slides as the price moves.
  // Depth is coherent across neighbouring levels, with the odd large resting order.
  const M = Math.ceil(W / 2 / pitch) + 26;
  const knots = [];
  for (let j = 0; j <= Math.ceil((2 * M + 1) / 6) + 2; j++) knots.push(rand());
  const noise = (i) => {
    const u = (i + M) / 6,
      j = Math.floor(u),
      f = u - j,
      c = (1 - Math.cos(f * Math.PI)) / 2;
    return knots[j] * (1 - c) + knots[j + 1] * c;
  };
  const levels = [];
  for (let i = -M; i <= M; i++) {
    const wall = rand() < 0.06;
    levels.push({
      i,
      price: mid0 * (1 + (i * tick) / 1e4),
      w: wall ? 1 : clamp(0.5 + 0.42 * noise(i) + 0.16 * (rand() - 0.5)),
      ph: i * 0.42 + rand() * 0.6,
      om: 0.6 + rand() * 0.5,
      side: 0,
      k: 0,
      h: { x: 0, v: 0 },
      eat: 0,
      flash: 0,
      el: E(
        "rect",
        { width: barW.toFixed(2), rx: (barW / 2).toFixed(2) },
        gBook,
      ),
    });
  }

  // Your quotes: capsules anchored at their price on the inner end.
  function capsule(side) {
    const g = E("g", {}, gOurs);
    const body = E("rect", { height: capH, rx: capH / 2 }, g);
    S(body, `fill: var(--${side === "ask" ? "ember" : "tide"})`);
    const glow = E("rect", { height: capH, rx: capH / 2, opacity: 0 }, g);
    S(glow, "fill: #fff");
    return {
      side,
      body,
      glow,
      x: { x: cx, v: 0 },
      len: { x: capL, v: 0 },
      mode: "rest",
      ct: 0,
      from: capL,
      center: cx,
      flash: 0,
      y: side === "ask" ? axisY - laneGap - capH : axisY + laneGap,
    };
  }
  const cap = { ask: capsule("ask"), bid: capsule("bid") };

  // Readout, top left: your ask, the market, your bid, the spread.
  const ro = {};
  const rx0 = compact ? 14 : 40,
    rnum = rx0 + (compact ? 150 : 236) * fs;
  const rowH = (compact ? 19 : 25) * fs;
  const rTop = (compact ? 8 : 30) + 14 * fs;
  const rows = compact
    ? [
        ["ask", "Your ask"],
        ["bid", "Your bid"],
      ]
    : [
        ["ask", "Your ask"],
        ["mid", "Market"],
        ["bid", "Your bid"],
      ];
  const gRead = E("g", {}, gInfo);
  const sw = 12 * fs,
    sh = 6 * fs;
  rows.forEach(([k, label], r) => {
    const y = rTop + r * rowH;
    if (k === "mid") {
      const l = E(
        "line",
        {
          x1: rx0,
          x2: rx0 + sw,
          y1: y - 4.5 * fs,
          y2: y - 4.5 * fs,
          "stroke-width": 1.5,
          "stroke-linecap": "round",
        },
        gRead,
      );
      S(l, "stroke: var(--ink-2)");
    } else {
      const b = E(
        "rect",
        { x: rx0, y: y - 7.5 * fs, width: sw, height: sh, rx: sh / 2 },
        gRead,
      );
      S(b, `fill: var(--${k === "ask" ? "ember" : "tide"})`);
    }
    const t = E("text", { x: rx0 + sw + 8 * fs, y }, gRead);
    S(t, txt(13, "fill: var(--ink-2)"));
    t.textContent = label;
    const n = E("text", { x: rnum, y, "text-anchor": "end" }, gRead);
    S(n, txt(compact ? 13.5 : 15, "font-weight: 600; fill: var(--ink)"));
    ro[k] = n;
  });
  let spreadText = null;
  if (!compact) {
    const y = rTop + rows.length * rowH + 4;
    const t = E("text", { x: rx0 + sw + 8 * fs, y }, gRead);
    S(t, txt(13, "fill: var(--ink-2)"));
    t.textContent = "Spread";
    spreadText = E("text", { x: rnum, y, "text-anchor": "end" }, gRead);
    S(spreadText, txt(15, "font-weight: 600; fill: var(--ink)"));
  }

  // Inventory, bottom right: a meter that fills toward your hedge trigger.
  const mW = compact ? Math.min(W * 0.48, 200 * fs) : 280;
  const mx1 = W - (compact ? 14 : 40),
    mx0 = mx1 - mW,
    mc = (mx0 + mx1) / 2;
  const mY = compact ? H - 12 - 6 * fs : H - 66;
  const gInv = E("g", {}, gInfo);
  const invLabel = E("text", { x: mx0, y: mY - 8 - 6 * fs }, gInv);
  S(invLabel, txt(13, "fill: var(--ink-2)"));
  invLabel.textContent = "Inventory";
  const invText = E(
    "text",
    { x: mx1, y: mY - 8 - 6 * fs, "text-anchor": "end" },
    gInv,
  );
  S(invText, txt(compact ? 13.5 : 15, "font-weight: 600; fill: var(--ink)"));
  const track = E(
    "rect",
    { x: mx0, y: mY - 3, width: mW, height: 6, rx: 3 },
    gInv,
  );
  S(track, "fill: var(--fill-2)");
  const zero = E(
    "line",
    {
      x1: mc,
      x2: mc,
      y1: mY - 7,
      y2: mY + 7,
      "stroke-width": 1.5,
      "stroke-linecap": "round",
    },
    gInv,
  );
  S(zero, "stroke: var(--ink-3)");
  const invFill = E("rect", { y: mY - 3, height: 6, rx: 3 }, gInv);
  const taker = { x: compact ? mx1 : mx0 + 5, y: compact ? mY : mY + 25.5 };
  let takerRing = null;
  if (!compact) {
    const d = E("circle", { cx: taker.x, cy: taker.y, r: 5 }, gInv);
    S(d, "fill: var(--ink)");
    takerRing = E(
      "circle",
      {
        cx: taker.x,
        cy: taker.y,
        r: 5,
        fill: "none",
        "stroke-width": 1.5,
        opacity: 0,
      },
      gInv,
    );
    S(takerRing, "stroke: var(--ink)");
    const t = E("text", { x: mx0 + 18, y: mY + 30 }, gInv);
    S(t, txt(13, "fill: var(--ink-2)"));
    const a = document.createElementNS(NS, "tspan");
    S(a, "fill: var(--ink); font-weight: 600");
    a.textContent = "Taker account";
    t.appendChild(a);
    t.appendChild(document.createTextNode(` hedges at ${usd(trigger)}`));
  }

  // ---------- state ----------
  let t = 0,
    mid = mid0,
    impact = 0,
    quoteMid = mid0;
  const cam = { x: mid0, v: 0 };
  let inv = o.initialInventory || 0;
  const invShown = { x: inv, v: 0 };
  let fills = 0,
    hedges = 0,
    earned = 0,
    busy = 0,
    hedging = false,
    rewardQualified = null;
  // Learn disables the autonomous director and invokes named scenes explicitly.
  const director = o.director !== false;
  const A = [5 + rand() * 2, 2.4 + rand(), 1 + rand() * 0.5],
    Wv = [0.27, 0.71, 1.63],
    P = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
  const fx = [];
  const caption = o.caption || null,
    counters = o.counters || null;
  const say = (h) => {
    if (caption) caption.innerHTML = h;
  };
  const emit = (k) => {
    if (o.onEvent) o.onEvent(k);
  };
  const count = () => {
    if (!counters) return;
    counters.innerHTML = `<span><b>${fills}</b> ${fills === 1 ? "fill" : "fills"}</span><span><b>${hedges}</b> ${hedges === 1 ? "hedge" : "hedges"}</span><span><b>${usd(earned)}</b> spread earned</span>${rewardQualified === null ? "" : `<span><b>${rewardQualified}%</b> time qualified</span>`}`;
  };
  let entrance = reduce ? 99 : 0; // seconds since the scene first became visible

  const skewBps = () => -(inv / size) * skewPerFill;
  function quotes() {
    const qm = quoteMid * (1 + skewBps() / 1e4);
    return { bid: qm * (1 - spread / 2e4), ask: qm * (1 + spread / 2e4) };
  }
  let liveQuotes = null,
    liveBest = null,
    liveDepth = false;
  // Live mode: the inventory before the latest update, and a value the meter holds while a
  // fill or hedge is still on its way, so the meter moves when the dot lands.
  let invBefore = inv,
    holdInv = null,
    seeded = !!o.mid;
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };
  const Q = () => liveQuotes || quotes();

  const chapterTimers = new Set();
  const chapterLater = (fn, ms) => {
    const id = setTimeout(
      () => {
        chapterTimers.delete(id);
        fn();
      },
      reduce ? 0 : ms,
    );
    chapterTimers.add(id);
  };
  const clearChapter = () => {
    for (const id of chapterTimers) clearTimeout(id);
    chapterTimers.clear();
  };
  const settleChapter = () => {
    for (let k = 0; k < 240; k++) step(1 / 60);
    lastRead = -1;
    draw();
  };
  const setCapsResting = () => {
    const q = Q();
    for (const side of ["ask", "bid"]) {
      const c = cap[side];
      c.mode = "rest";
      c.ct = 0;
      c.len.x = capL;
      c.len.v = 0;
      c.x.x = xOf(q[side]);
      c.x.v = 0;
      c.flash = 0;
    }
  };
  const pose = (name) => {
    clearChapter();
    entrance = 99;
    busy = 0;
    hedging = false;
    rewardQualified = null;
    fills = 0;
    hedges = 0;
    earned = 0;
    inv = 0;
    holdInv = null;
    quoteMid = mid;
    if (name === "fills") {
      fills = 1;
      inv = size;
    } else if (name === "skew") {
      fills = 3;
      inv = 3 * size;
    } else if (name === "hedge") {
      fills = 2;
      hedges = 1;
    } else if (name === "rewards") {
      rewardQualified = 96;
      cap.ask.flash = 1;
      cap.bid.flash = 1;
    }
    setCapsResting();
    invShown.x = inv;
    count();
    emit("pose-" + name);
    settleChapter();
  };
  const play = (name) => {
    if (reduce) {
      pose(name);
      return;
    }
    clearChapter();
    pose("spread");
    emit("play-" + name);
    if (name === "spread") {
      entrance = 0;
      return;
    }
    if (name === "fills") {
      chapterLater(() => spawnTaker("sell", "ours"), 600);
      return;
    }
    if (name === "skew") {
      [200, 1600, 3000].forEach((delay) =>
        chapterLater(() => spawnTaker("sell", "ours"), delay),
      );
      return;
    }
    if (name === "hedge") {
      chapterLater(() => {
        inv = trigger;
        invBefore = inv;
        invShown.x = inv;
        emit("hedge-trigger");
        hedge();
      }, 1000);
      return;
    }
    if (name === "rewards") {
      rewardQualified = 96;
      cap.ask.flash = 1;
      cap.bid.flash = 1;
      count();
      emit("rewards");
    }
  };
  // In live mode the book comes only from real data: depth levels when update() is given a
  // book, otherwise just the venue's best bid and ask as one bar each. Nothing is invented.
  const bestAsk = () =>
    liveBest ? liveBest.ask : mid * (1 + (spread / 2 + bookOff) / 1e4);
  const bestBid = () =>
    liveBest ? liveBest.bid : mid * (1 - (spread / 2 + bookOff) / 1e4);
  const xOf = (p) => cx + ((p - cam.x) / cam.x) * 1e4 * pxPerBps;
  const bookFront = (side) => {
    let best = null;
    for (const L of levels)
      if (
        L.side === (side === "bid" ? -1 : 1) &&
        L.h.x > 0.02 &&
        (!best || L.k < best.k)
      )
        best = L;
    return best;
  };

  function midAt(tt) {
    let b = 0;
    for (let k = 0; k < 3; k++) b += A[k] * Math.sin(Wv[k] * tt + P[k]);
    return mid0 * (1 + (b + impact) / 1e4);
  }

  // ---------- simulation ----------
  function step(dt) {
    t += dt;
    if (!live) mid = midAt(t);
    impact *= Math.exp(-dt / 9);
    spring(cam, mid, 1.1, 1, dt);
    if (
      !live &&
      !busy &&
      !hedging &&
      (Math.abs(mid - quoteMid) / mid) * 1e4 > 2.5
    )
      quoteMid = mid;
    const bA = bestAsk(),
      bB = bestBid();
    let frontA = null,
      frontB = null;
    for (const L of levels) {
      L.ns = L.price >= bA ? 1 : L.price <= bB ? -1 : 0;
      L.k =
        L.ns === 1
          ? Math.round((((L.price - bA) / mid) * 1e4) / tick)
          : L.ns === -1
            ? Math.round((((bB - L.price) / mid) * 1e4) / tick)
            : 0;
      if (L.ns === 1 && (!frontA || L.price < frontA.price)) frontA = L;
      if (L.ns === -1 && (!frontB || L.price > frontB.price)) frontB = L;
    }
    for (const L of levels) {
      const side = L.ns;
      let target = 0;
      if (live && !liveDepth) {
        if (liveBest && side === L.side && (L === frontA || L === frontB))
          target = 0.42;
      } else if (live) {
        if (side !== 0 && side === L.side && L.w > 0)
          target = Math.max(0.05, L.w);
      } // real sizes, nothing added
      else if (side !== 0 && side === L.side) {
        const env = 0.18 + 0.82 * smooth(-3, 18, L.k);
        const breathe =
          1 +
          0.06 * Math.sin(0.9 * t - L.ph) +
          0.035 * Math.sin(L.om * t + L.ph * 2.3);
        target = env * (0.3 + 0.7 * L.w) * breathe * (1 - L.eat);
      }
      if (side !== L.side && L.h.x < 0.01) {
        L.side = side;
        L.h.v = 0;
      }
      spring(L.h, target, 5.5, 1, dt);
      if (L.h.x < 0) L.h.x = 0;
      L.eat *= Math.exp(-dt / 2.6);
      L.flash *= Math.exp(-dt / 0.3);
    }
    const q = Q();
    for (const s of ["ask", "bid"]) {
      const c = cap[s];
      // Opening: the two capsules appear as the Maker mark, hold, then part to their prices.
      const opening = entrance < 2;
      const markX = s === "ask" ? cx - capL * 0.1875 : cx + capL * 0.1875;
      spring(
        c.x,
        entrance < 0.6 ? markX : xOf(q[s]),
        opening ? 4.4 : 6.5,
        opening ? 0.86 : 1,
        dt,
      );
      if (c.mode === "grow" || c.mode === "rest")
        spring(c.len, capL, 10, 0.62, dt);
      if (
        c.mode === "grow" &&
        Math.abs(c.len.x - capL) < 0.5 &&
        Math.abs(c.len.v) < 5
      )
        c.mode = "rest";
      if (c.mode === "collapse") {
        c.ct += dt;
        if (c.ct >= 0.24) {
          c.mode = "hidden";
          c.onFolded();
        }
      }
      c.flash *= Math.exp(-dt / 0.22);
    }
    spring(invShown, holdInv ?? inv, 7, 1, dt);
    if (busy > 0) busy = Math.max(0, busy - dt);
  }

  // ---------- drawing ----------
  let lastRead = -1;
  function draw() {
    const e = entrance;
    const reach = (W / 2) * easeOut(clamp((e - 0.55) / 0.9));
    axis.setAttribute("x1", (cx - reach).toFixed(1));
    axis.setAttribute("x2", (cx + reach).toFixed(1));
    const mx = xOf(mid);
    const tickH = laneGap + capH + 3;
    midTick.setAttribute("x1", mx.toFixed(2));
    midTick.setAttribute("x2", mx.toFixed(2));
    midTick.setAttribute("y1", axisY - tickH);
    midTick.setAttribute("y2", axisY + tickH);
    midDot.setAttribute("cx", mx.toFixed(2));
    const midIn = easeOut(clamp((e - 0.7) / 0.5));
    midTick.setAttribute("opacity", (0.5 * midIn).toFixed(3));
    midDot.setAttribute("opacity", midIn.toFixed(3));
    for (const L of levels) {
      const x = xOf(L.price);
      if (x < -20 || x > W + 20 || L.side === 0 || L.h.x < 0.004) {
        L.el.setAttribute("height", 0);
        continue;
      }
      const gate = easeOut(clamp((e - 0.75 - Math.min(L.k, 40) * 0.016) / 0.5));
      const h = Math.max(barW, L.h.x * barMax) * gate;
      const edge = smooth(0, 150, x) * smooth(W, W - 150, x);
      const a =
        ((0.13 + 0.25 * Math.exp(-L.k / 12)) *
          (L.side === 1 ? tintBoost.ask : tintBoost.bid) +
          0.45 * L.flash) *
        edge *
        gate;
      L.el.setAttribute("x", (x - barW / 2).toFixed(2));
      L.el.setAttribute(
        "y",
        (L.side === 1 ? axisY - barBase - h : axisY + barBase).toFixed(2),
      );
      L.el.setAttribute("height", h.toFixed(2));
      L.el.setAttribute("fill-opacity", a.toFixed(3));
      S(L.el, `fill: var(--${L.side === 1 ? "ember" : "tide"})`);
    }
    const ends = {};
    for (const s of ["ask", "bid"]) {
      const c = cap[s];
      let len, x;
      if (c.mode === "collapse") {
        const p = easeIn(clamp(c.ct / 0.24));
        len = c.from + (capH - c.from) * p;
        x = c.center - len / 2;
      } else if (c.mode === "hidden") {
        len = 0;
        x = c.x.x;
      } else {
        len =
          Math.max(0, c.len.x) *
          easeOut(clamp((e - (s === "ask" ? 0.08 : 0)) / 0.32));
        x = s === "ask" ? c.x.x : c.x.x - len;
      }
      for (const el of [c.body, c.glow]) {
        el.setAttribute("x", x.toFixed(2));
        el.setAttribute("y", c.y);
        el.setAttribute("width", len.toFixed(2));
      }
      c.glow.setAttribute("opacity", (0.55 * c.flash).toFixed(3));
      ends[s] = c.x.x;
    }
    spreadSeg.setAttribute("x1", Math.min(ends.bid, ends.ask).toFixed(2));
    spreadSeg.setAttribute("x2", Math.max(ends.bid, ends.ask).toFixed(2));
    spreadSeg.setAttribute(
      "opacity",
      easeOut(clamp((e - 1.1) / 0.6)).toFixed(3),
    );
    const frac = clamp(invShown.x / trigger, -1, 1);
    const wF = Math.abs(frac) * (mW / 2);
    invFill.setAttribute("x", (frac >= 0 ? mc : mc - wF).toFixed(2));
    invFill.setAttribute("width", wF.toFixed(2));
    S(invFill, `fill: var(--${frac >= 0 ? "tide" : "ember"})`);
    gInfo.setAttribute("opacity", easeOut(clamp((e - 1.3) / 0.6)).toFixed(3));
    if (t - lastRead > 0.2 || lastRead < 0) {
      lastRead = t;
      const q = Q();
      ro.ask.textContent = fmt(q.ask);
      ro.bid.textContent = fmt(q.bid);
      if (ro.mid) ro.mid.textContent = fmt(mid);
      if (spreadText)
        spreadText.textContent =
          Math.round(((q.ask - q.bid) / mid) * 1e4) + " bps";
      invText.textContent =
        Math.abs(inv) < 0.005
          ? "Flat"
          : (inv > 0 ? "+" : "−") +
            "$" +
            Math.abs(inv).toFixed(2) +
            (inv > 0 ? " long" : " short");
    }
  }

  // ---------- events ----------
  function dotWithTrail(color, r) {
    const dot = E("circle", { r }, gFx);
    S(dot, `fill: var(--${color})`);
    const trail = [0, 1, 2].map(() => {
      const c = E("circle", { r }, gFx);
      S(c, `fill: var(--${color})`);
      return c;
    });
    return { dot, trail, hist: [] };
  }
  function moveDot(f, x, y, alpha, r) {
    f.hist.unshift([x, y]);
    f.hist.length = Math.min(f.hist.length, 10);
    f.dot.setAttribute("cx", x.toFixed(2));
    f.dot.setAttribute("cy", y.toFixed(2));
    f.dot.setAttribute("opacity", alpha.toFixed(3));
    f.trail.forEach((c, j) => {
      const h = f.hist[Math.min(f.hist.length - 1, (j + 1) * 3)];
      c.setAttribute("cx", h[0].toFixed(2));
      c.setAttribute("cy", h[1].toFixed(2));
      c.setAttribute("opacity", (alpha * (0.26 - j * 0.075)).toFixed(3));
      c.setAttribute("r", (r * (0.82 - j * 0.18)).toFixed(2));
    });
  }
  const dropDot = (f) => {
    f.dot.remove();
    f.trail.forEach((c) => c.remove());
  };
  function capFront(side) {
    const c = cap[side];
    return side === "ask"
      ? c.x.x + Math.min(14, c.len.x * 0.3)
      : c.x.x - Math.min(14, c.len.x * 0.3);
  }
  function spawnTaker(dir, how) {
    // "sell" comes down onto the bids, "buy" comes up onto the asks.
    // how: "ours" forces a fill (a real fill in the app), "sweep" takes the level ahead of
    // yours first and then yours, otherwise the order trades with whoever is at the front.
    const target = dir === "sell" ? "bid" : "ask";
    const q = Q();
    const ready = cap[target].mode === "rest";
    const front = bookFront(target);
    const oursBest = target === "bid" ? q.bid >= bestBid() : q.ask <= bestAsk();
    const sweep = how === "sweep" && ready && !oursBest && !!front;
    const ours = how === "ours" || (ready && (oursBest || sweep));
    const r = compact ? 4 : 5;
    const f = dotWithTrail("ink", r);
    Object.assign(f, {
      kind: "taker",
      t: 0,
      dur: 0.62,
      target,
      ours,
      sweep,
      force: how === "ours",
      leg: sweep ? 1 : 2,
      r,
      from: {
        dx: (target === "bid" ? -1 : 1) * (8 + rand() * 26),
        dy: (target === "bid" ? -1 : 1) * (compact ? 64 : 92),
      },
    });
    fx.push(f);
  }
  function ring(x, y, w, h, color) {
    const r = E("rect", { fill: "none", "stroke-width": 1.5 }, gFx);
    S(r, `stroke: var(--${color})`);
    fx.push({ kind: "ring", el: r, t: 0, dur: 0.55, x, y, w, h });
  }
  const holding = (v) =>
    Math.abs(v) < 0.005
      ? " and you're flat again."
      : ` and now hold ${v > 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)} of inventory.`;

  function ourFill(side, swept) {
    const c = cap[side];
    const at = Q()[side];
    const delta = side === "bid" ? size : -size;
    fills++;
    earned += (size * (spread / 2)) / 1e4;
    c.flash = 1;
    c.from = c.len.x;
    c.center = side === "ask" ? c.x.x + c.from / 2 : c.x.x - c.from / 2;
    ring(
      c.center - c.from / 2,
      c.y,
      c.from,
      capH,
      side === "ask" ? "ember" : "tide",
    );
    c.mode = "collapse";
    c.ct = 0;
    busy = 2.2;
    emit("fill");
    say(
      swept
        ? `<b>A larger ${side === "bid" ? "seller" : "buyer"} took the ${side} ahead of yours, then ${side === "bid" ? "hit your bid" : "lifted your ask"}</b> at ${fmt(at)}. You ${side === "bid" ? "bought" : "sold"} another ${usd(size)}${holding(inv + delta)}`
        : side === "bid"
          ? `<b>A seller hit your bid</b> at ${fmt(at)}. You bought ${usd(size)}${holding(inv + delta)}`
          : `<b>A buyer lifted your ask</b> at ${fmt(at)}. You sold ${usd(size)}${holding(inv + delta)}`,
    );
    count();
    // The filled order folds into a dot and drops into inventory.
    c.onFolded = () => {
      const f = {
        kind: "chip",
        el: E("circle", {}, gFx),
        t: 0,
        dur: 0.8,
        sx: c.center,
        sy: c.y + capH / 2,
        delta,
      };
      S(f.el, `fill: var(--${side === "ask" ? "ember" : "tide"})`);
      f.onDone = () => {
        if (live) holdInv = null;
        else inv += delta;
        // Re-quote: a new order grows at the skewed price while the other side glides.
        later(
          () => {
            quoteMid = mid;
            c.mode = "grow";
            c.len.x = 0;
            c.len.v = 0;
            if (Math.abs(inv) > 0.01) {
              emit("skew");
              say(
                `<b>Maker re-quoted and leaned both sides ${inv > 0 ? "down" : "up"}.</b> Now the next fill is more likely to ${inv > 0 ? "sell" : "buy"} and bring you back toward flat.`,
              );
            } else
              say(
                "<b>Maker re-quoted.</b> You're flat, so the bid and ask sit evenly around the price again.",
              );
            if (Math.abs(inv) >= trigger - 1e-9 && !live) {
              hedging = true;
              later(() => {
                hedging = false;
                hedge();
              }, 1200);
            }
          },
          reduce ? 0 : 220,
        );
      };
      fx.push(f);
    };
  }
  function bookHit(side) {
    const best = bookFront(side);
    if (best) {
      best.eat = Math.min(0.75, best.eat + 0.5);
      best.flash = 1;
    }
    impact += (side === "bid" ? -1 : 1) * (0.8 + rand() * 0.9);
    emit("queue");
    say(
      Math.abs(inv) > 0.01
        ? `<b>A ${side === "bid" ? "seller" : "buyer"} traded with someone else.</b> While you hold inventory your ${side} leans away from the price, so another ${side} was ahead of yours. That's the skew doing its job.`
        : `<b>A ${side === "bid" ? "seller" : "buyer"} traded with someone else.</b> Their ${side} was closer to the price than yours, so yours kept its place in line.`,
    );
  }
  function hedge() {
    const basis = live && Math.abs(inv) < 1e-9 ? invBefore : inv;
    if (hedging || Math.abs(basis) < 1e-9) return;
    hedging = true;
    busy = 2.5;
    const amt = Math.abs(basis),
      wasLong = basis > 0;
    if (live) holdInv = basis;
    emit("hedge");
    say(
      `<b>Inventory reached ${usd(amt)}</b>, your hedge trigger. Your taker account ${wasLong ? "sells" : "buys"} ${usd(amt)} at market against the book.`,
    );
    if (takerRing) fx.push({ kind: "pulse", el: takerRing, t: 0, dur: 0.9 });
    // The hedge is a market order: it leaves the taker account and takes from the book.
    const f = dotWithTrail("ink", compact ? 4 : 5);
    Object.assign(f, {
      kind: "shot",
      t: 0,
      dur: 0.9,
      side: wasLong ? "bid" : "ask",
      r: compact ? 4 : 5,
      onDone() {
        const front = bookFront(f.side);
        if (front) {
          front.eat = Math.min(0.85, front.eat + 0.7);
          front.flash = 1;
        }
        impact += (wasLong ? -1 : 1) * 1.4;
        if (live) holdInv = null;
        else inv = 0;
        hedges++;
        hedging = false;
        sinceHedge = 0;
        quoteMid = mid;
        count();
        say(
          `<b>Hedged.</b> Your taker account ${wasLong ? "sold" : "bought"} ${usd(amt)} at market, so your overall position is flat. Maker keeps quoting both sides.`,
        );
      },
    });
    fx.push(f);
  }

  // ---------- loop ----------
  let script = null,
    sinceHedge = 0,
    frames = 0,
    running = true,
    visible = true,
    last = 0,
    nextTaker = 1.4,
    lastDir = rand() < 0.5 ? "sell" : "buy",
    raf = 0;
  function frame(now) {
    if (!running) return;
    const dt = Math.min(1 / 30, last ? (now - last) / 1000 : 1 / 60);
    last = now;
    entrance += dt;
    if (++frames % 60 === 0) readTheme();
    step(dt);
    if (!live && director && entrance > 2) {
      nextTaker -= dt;
      sinceHedge += dt;
      if (nextTaker <= 0 && !busy && !hedging) {
        nextTaker = 1.6 + rand() * 1.5;
        // A small director keeps the story legible: fills, skew, the odd trade elsewhere,
        // and a hedge every so often.
        const first = rand() < 0.5 ? "sell" : "buy";
        if (script === null)
          script = [
            [first],
            [first],
            [first, "sweep"],
            [first === "sell" ? "buy" : "sell"],
            [first],
          ];
        if (script.length) spawnTaker(...script.shift());
        else if (Math.abs(inv) < 0.01) spawnTaker(first);
        else {
          const same = inv > 0 ? "sell" : "buy",
            opp = inv > 0 ? "buy" : "sell",
            r = rand();
          if (sinceHedge > 18 || r < 0.26) spawnTaker(same, "sweep");
          else if (r < 0.64) spawnTaker(same);
          else spawnTaker(opp);
        }
      }
    }
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i];
      f.t += dt;
      const p = clamp(f.t / f.dur);
      if (f.kind === "taker") {
        let tx, ty;
        const toBook = () => {
          const b = bookFront(f.target);
          return [
            b ? xOf(b.price) : xOf(f.target === "bid" ? bestBid() : bestAsk()),
            axisY + (f.target === "bid" ? barBase : -barBase),
          ];
        };
        if (f.leg === 1 || !f.ours) [tx, ty] = toBook();
        else {
          tx = capFront(f.target);
          ty = cap[f.target].y + capH / 2;
        }
        if (f.leg === 2 && f.sx !== undefined) {
          // second leg of a sweep: from the level it just took, on to yours
          const pe = easeInOut(p);
          moveDot(f, f.sx + (tx - f.sx) * pe, f.sy + (ty - f.sy) * pe, 1, f.r);
        } else {
          const pe = easeIn(p) * 0.85 + p * 0.15;
          moveDot(
            f,
            tx + f.from.dx * (1 - easeOut(p)),
            ty + f.from.dy * (1 - pe),
            smooth(0, 0.18, p),
            f.r,
          );
        }
        if (p >= 1 && f.leg === 1) {
          const b = bookFront(f.target);
          if (b) {
            b.eat = 1;
            b.flash = 1;
          }
          f.leg = 2;
          f.t = 0;
          f.dur = 0.34;
          [f.sx, f.sy] = f.hist[0];
        } else if (p >= 1) {
          dropDot(f);
          fx.splice(i, 1);
          const c = cap[f.target];
          if (
            f.force
              ? c.mode === "rest" || c.mode === "grow"
              : f.ours && c.mode === "rest" && c.len.x > capL * 0.6
          )
            ourFill(f.target, f.sweep);
          else if (f.force) {
            c.flash = 1;
            holdInv = null;
          } else bookHit(f.target);
        }
      } else if (f.kind === "shot") {
        const b = bookFront(f.side);
        const ex = b
          ? xOf(b.price)
          : xOf(f.side === "bid" ? bestBid() : bestAsk());
        const ey = axisY + (f.side === "bid" ? barBase : -barBase);
        const cxp = (taker.x + ex) / 2,
          cyp =
            f.side === "bid"
              ? Math.max(taker.y, ey) + 30
              : Math.min(taker.y, ey) - 10;
        const pe = easeInOut(p);
        moveDot(
          f,
          quad(taker.x, cxp, ex, pe),
          quad(taker.y, cyp, ey, pe),
          smooth(0, 0.12, p),
          f.r,
        );
        if (p >= 1) {
          dropDot(f);
          fx.splice(i, 1);
          f.onDone();
        }
      } else if (f.kind === "ring") {
        const g = 8 * easeOut(p);
        f.el.setAttribute("x", (f.x - g).toFixed(2));
        f.el.setAttribute("y", (f.y - g).toFixed(2));
        f.el.setAttribute("width", (f.w + 2 * g).toFixed(2));
        f.el.setAttribute("height", (f.h + 2 * g).toFixed(2));
        f.el.setAttribute("rx", (f.h / 2 + g).toFixed(2));
        f.el.setAttribute("opacity", (0.6 * (1 - p)).toFixed(3));
        if (p >= 1) {
          f.el.remove();
          fx.splice(i, 1);
        }
      } else if (f.kind === "chip") {
        const ex = mc + clamp((inv + f.delta) / trigger, -1, 1) * (mW / 2),
          ey = mY;
        const cxp = ex,
          cyp = f.sy + (ey - f.sy) * 0.2;
        const pe = easeInOut(p);
        f.el.setAttribute("cx", quad(f.sx, cxp, ex, pe).toFixed(2));
        f.el.setAttribute("cy", quad(f.sy, cyp, ey, pe).toFixed(2));
        f.el.setAttribute("r", (capH / 2 + (3 - capH / 2) * pe).toFixed(2));
        if (p >= 1) {
          f.el.remove();
          fx.splice(i, 1);
          f.onDone();
        }
      } else if (f.kind === "pulse") {
        f.el.setAttribute("r", (5 + 12 * easeOut(p)).toFixed(2));
        f.el.setAttribute("opacity", (0.8 * (1 - p)).toFixed(3));
        if (p >= 1) {
          f.el.setAttribute("opacity", 0);
          fx.splice(i, 1);
        }
      }
    }
    draw();
    if (visible) raf = requestAnimationFrame(frame);
  }

  // Settle the book before the first frame so it starts full.
  if (!live) for (let k = 0; k < 360; k++) step(1 / 60);
  for (const s of ["ask", "bid"]) {
    const c = cap[s],
      q = Q();
    if (reduce) c.x.x = xOf(q[s]);
    else {
      const ov = capL * 0.375;
      c.x.x = s === "ask" ? cx - ov / 2 : cx + ov / 2;
    } // start as the mark, then open
    c.x.v = 0;
    c.len.x = capL;
    c.len.v = 0;
  }
  invShown.x = inv;
  say(
    o.intro ||
      "<b>Maker is quoting both sides.</b> Your ask waits above the price for a buyer and your bid waits below it for a seller. The gap between them is the spread you earn when both fill.",
  );
  count();
  draw();

  function resume() {
    if (!running || reduce || !visible) return;
    last = 0;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }
  let observer = null;
  const onVisibility = () => {
    visible = !document.hidden;
    resume();
  };
  if (!reduce) {
    if ("IntersectionObserver" in window) {
      visible = false;
      observer = new IntersectionObserver(
        (ents) => {
          visible = ents[0].isIntersecting && !document.hidden;
          resume();
        },
        { threshold: 0.15 },
      );
      observer.observe(svg);
    } else resume();
    document.addEventListener("visibilitychange", onVisibility);
  }

  // A real book: levels are summed into the grid's price bins, and each bar's height is
  // its resting size, scaled so a single large order cannot flatten everything else.
  let gridMid = mid0,
    lastBook = null;
  function applyBook(book) {
    liveDepth = true;
    for (const L of levels) L.w = 0;
    const sum = new Map();
    for (const [p, sz] of [...(book.asks || []), ...(book.bids || [])]) {
      if (!(p > 0) || !(sz > 0)) continue;
      const i = Math.round(((p / gridMid - 1) * 1e4) / tick);
      if (Math.abs(i) > M) continue;
      sum.set(i, (sum.get(i) || 0) + sz);
    }
    if (!liveBest) {
      const bb = Math.max(...(book.bids || []).map((r) => r[0])),
        ba = Math.min(...(book.asks || []).map((r) => r[0]));
      if (isFinite(bb) && isFinite(ba)) liveBest = { bid: bb, ask: ba };
    }
    const sizes = [...sum.values()].sort((a, b) => a - b);
    const cap = sizes.length
      ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.9))]
      : 1;
    for (const [i, sz] of sum) levels[i + M].w = Math.min(1, sz / cap);
  }

  return {
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      if (observer) observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      for (const id of timers) clearTimeout(id);
      timers.clear();
      clearChapter();
      svg.remove();
    },
    // The theme changed: re-read the surface so the book's tint suits it, and redraw a still.
    retheme() {
      readTheme();
      if (reduce || !visible) draw();
    },
    state() {
      const q = Q();
      return {
        mid,
        bid: q.bid,
        ask: q.ask,
        inventoryUsd: inv,
        fills,
        hedges,
        earned,
      };
    },
    // In the app: feed real data. Positions glide between samples; nothing is simulated.
    // { mid, bid, ask, bestBid, bestAsk, inventoryUsd, book }, where book is
    // { bids: [[price, size], ...], asks: [[price, size], ...] } or null for best prices only.
    update(d) {
      if (typeof d.mid === "number" && d.mid > 0) {
        // A first price, or a jump this large, is a new market: cut to it instead of gliding.
        const jump = !seeded || Math.abs(d.mid / mid - 1) > 0.02;
        mid = d.mid;
        if (jump) {
          seeded = true;
          cam.x = mid;
          cam.v = 0;
          quoteMid = mid;
        }
        if (reduce) cam.x = mid;
      }
      if (typeof d.bid === "number" && typeof d.ask === "number")
        liveQuotes = { bid: d.bid, ask: d.ask };
      if (typeof d.inventoryUsd === "number" && d.inventoryUsd !== inv) {
        invBefore = inv;
        inv = d.inventoryUsd;
      }
      if (typeof d.bestBid === "number" && typeof d.bestAsk === "number")
        liveBest = { bid: d.bestBid, ask: d.bestAsk };
      // Keep the price grid centred on the market if it drifts a long way.
      if (
        live &&
        Math.abs(mid / gridMid - 1) * 1e4 >
          Math.min(200, (M - Math.ceil(W / 2 / pitch) - 4) * tick)
      ) {
        gridMid = mid;
        for (const L of levels) {
          L.price = gridMid * (1 + (L.i * tick) / 1e4);
          L.h.x = 0;
          L.h.v = 0;
          L.side = 0;
          L.w = 0;
        }
        if (lastBook) applyBook(lastBook);
      }
      // A meter held for an animation that never landed is released by the next sample.
      if (
        holdInv !== null &&
        !fx.some(
          (f) => f.kind === "taker" || f.kind === "chip" || f.kind === "shot",
        )
      )
        holdInv = null;
      if (d.book) {
        lastBook = d.book;
        applyBook(d.book);
      } else if (d.book === null) {
        lastBook = null;
        liveDepth = false;
        for (const L of levels) L.w = 0;
      }
      if (reduce) {
        // A still picture has no frames to glide through, so settle and redraw now.
        for (let k = 0; k < 240; k++) step(1 / 60);
        const q = Q();
        for (const s of ["ask", "bid"]) cap[s].x.x = xOf(q[s]);
        invShown.x = inv;
        lastRead = -1;
        draw();
      }
    },
    // Learn runs named scenes; a subsequent play cancels the prior script.
    play(name) {
      play(name);
    },
    // Learn's reduced-motion key frame.
    pose(name) {
      pose(name);
    },
    // A real fill on your bid or ask, drawn the same way as in the illustration.
    fill(side) {
      if (reduce) return; // a still picture shows the result through update()
      if (live && holdInv === null) holdInv = invBefore;
      spawnTaker(side === "bid" ? "sell" : "buy", "ours");
    },
    hedge() {
      if (!reduce) hedge();
    },
  };
}
