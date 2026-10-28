() => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) { const n = c.match(/color\(srgb ([^)]+)\)/); if(!n) return null; const p=n[1].split(/[ /]+/).filter(Boolean).map(Number); return [p[0]*255,p[1]*255,p[2]*255,p[3]??1]; } const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
    const over = (top, bot) => { const a = top[3]; return [top[0]*a + bot[0]*(1-a), top[1]*a + bot[1]*(1-a), top[2]*a + bot[2]*(1-a), 1]; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]); };
    const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
    const bgOf = (el) => { const stack = []; let e = el; while (e && e.nodeType === 1) { const cs = getComputedStyle(e); const c = parse(cs.backgroundColor); if (c && c[3] > 0) { stack.push(c); if (c[3] >= 1) break; } e = e.parentElement; } let base = parse(getComputedStyle(document.body).backgroundColor) || [255,255,255,1]; if (base[3] < 1) base = over(base, [255,255,255,1]); for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base); return base; };
    const sel = (el) => { let s = el.tagName.toLowerCase(); if (el.id) s += "#" + el.id; if (el.className && typeof el.className === "string") s += "." + el.className.trim().split(/\s+/).slice(0, 3).join("."); const p = el.parentElement; return (p && p.className && typeof p.className === "string" ? p.className.trim().split(/\s+/)[0] + " > " : "") + s; };
    const out = []; const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode; const txt = t.textContent.trim(); if (!txt) continue;
      const el = t.parentElement; if (!el) continue;
      const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
      if (el.closest("[hidden]")) continue;
      let fg = parse(cs.color); if (!fg) continue; const bg = bgOf(el); fg = over(fg, bg);
      let op = 1; let e = el; while (e && e.nodeType === 1) { op *= Number(getComputedStyle(e).opacity); e = e.parentElement; }
      if (op < 1) fg = [fg[0]*op + bg[0]*(1-op), fg[1]*op + bg[1]*(1-op), fg[2]*op + bg[2]*(1-op), 1];
      const size = parseFloat(cs.fontSize); const weight = Number(cs.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5; const cr = ratio(fg, bg);
      const key = sel(el) + "|" + txt.slice(0, 30);
      if (seen.has(key)) continue; seen.add(key);
      out.push({ sel: sel(el), text: txt.slice(0, 40), ratio: Math.round(cr * 100) / 100, need, size, fg: fg.slice(0,3).map(Math.round), bg: bg.slice(0,3).map(Math.round), disabled: !!el.closest("button:disabled,[aria-disabled=true]") });
    }
    const small = out.filter(o => o.size < 12).length;
    return { total: out.length, small, fails: out.filter(o => o.ratio < o.need && !o.disabled), disabledLow: out.filter(o => o.ratio < 3 && o.disabled).length, sizes: out.reduce((m,o)=>{const k=Math.round(o.size*2)/2; m[k]=(m[k]||0)+1; return m;},{}) };
  }