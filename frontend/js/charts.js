// Mini-bibliothèque de graphiques SVG (aucune dépendance) : courbes, aires empilées,
// barres groupées/empilées, anneau, jauge, sparkline. Responsive + infobulles.

import { esc, fmt } from "./ui.js";

const NS = "http://www.w3.org/2000/svg";

function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}
export function niceScale(min, max, count = 4) {
  if (!(max > min)) max = min + 1;
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { min: lo, max: hi, ticks, step };
}
const autoFmt = (v) => {
  const a = Math.abs(v);
  return a >= 1000 ? fmt(v / 1000, a >= 10000 ? 0 : 1) + "k" : fmt(v, a >= 100 || Number.isInteger(v) ? 0 : a >= 10 ? 1 : 2);
};

class BaseChart {
  constructor(el, opts) {
    this.el = el;
    this.o = opts;
    el.classList.add("chart");
    el.innerHTML = "";
    this.holder = document.createElement("div");
    this.tip = document.createElement("div");
    this.tip.className = "chart-tip";
    el.append(this.holder, this.tip);
    this.width = el.clientWidth;
    this.ro = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - this.width) > 2) { this.width = el.clientWidth; this.render(); }
    });
    this.ro.observe(el);
    this.onMove = this.onMove.bind(this);
    this.onLeave = this.onLeave.bind(this);
  }
  destroy() { this.ro.disconnect(); }
  showTip(x, y, html) {
    this.tip.innerHTML = html;
    const w = this.el.clientWidth;
    const tw = this.tip.offsetWidth || 160;
    const left = Math.min(Math.max(x, tw / 2 + 4), w - tw / 2 - 4);
    this.tip.style.left = `${left}px`;
    this.tip.style.top = `${Math.max(y - 10, 40)}px`;
    this.tip.style.opacity = "1";
  }
  onLeave() {
    this.tip.style.opacity = "0";
    const hov = this.holder.querySelector(".hover");
    if (hov) hov.innerHTML = "";
  }
  bind() {
    const ov = this.holder.querySelector(".overlay");
    if (!ov) return;
    ov.addEventListener("mousemove", this.onMove);
    ov.addEventListener("mouseleave", this.onLeave);
  }
}

// ---------------------------------------------------------------------------- courbes
export class LineChart extends BaseChart {
  constructor(el, opts = {}) {
    super(el, {
      height: 220, pad: { t: 24, r: 16, b: 26, l: 46 }, yMin: 0, yMax: null, unit: "", stacked: false,
      thresholds: [], xFormat: (v) => `${fmt(v, 0)} s`, yFormat: autoFmt, xLabel: "", emptyText: "En attente de données…",
      tipDigits: 1, minRange: 1, ...opts,
    });
    this.data = { x: [], series: [] };
    this.render();
  }
  set(data) { this.data = data; this.render(); }

  render() {
    const o = this.o, W = Math.max(200, this.el.clientWidth || 600), H = o.height, p = o.pad;
    const { x = [], series = [] } = this.data;
    const visible = series.filter((s) => !s.hidden);
    const iw = W - p.l - p.r, ih = H - p.t - p.b;
    // valeurs (empilées éventuellement)
    const stacks = [];
    let base = new Array(x.length).fill(0);
    for (const s of visible) {
      const vals = s.values.map((v, i) => (v == null ? null : o.stacked && !s.noStack ? v + base[i] : v));
      const lower = o.stacked && !s.noStack ? base.slice() : null;
      if (o.stacked && !s.noStack) base = vals.map((v, i) => (v == null ? base[i] : v));
      stacks.push({ s, vals, lower });
    }
    let yMaxData = 0, has = false;
    for (const st of stacks) for (const v of st.vals) if (v != null) { has = true; if (v > yMaxData) yMaxData = v; }
    for (const t of o.thresholds) if (t.always || t.y <= yMaxData * 1.6) yMaxData = Math.max(yMaxData, t.y * 1.08);
    const sc = niceScale(o.yMin, Math.max(o.yMax ?? yMaxData * 1.08, o.yMin + o.minRange), 4);
    const yMin = sc.min, yMax = o.yMax ?? sc.max;
    const xMin = o.xMin ?? (x.length ? x[0] : 0), xMax = o.xMax ?? (x.length > 1 ? x[x.length - 1] : xMin + 1);
    const sx = (v) => p.l + ((v - xMin) / (xMax - xMin || 1)) * iw;
    const sy = (v) => p.t + (1 - (Math.min(v, yMax) - yMin) / (yMax - yMin || 1)) * ih;
    this.geom = { sx, sy, xMin, xMax, p, iw, ih, stacks };

    let g = "";
    for (const t of sc.ticks) {
      if (t > yMax + 1e-9) continue;
      const y = sy(t);
      g += `<line class="grid-line" x1="${p.l}" x2="${W - p.r}" y1="${y}" y2="${y}"/>`;
      g += `<text class="axis-text" x="${p.l - 8}" y="${y + 3.5}" text-anchor="end">${esc(o.yFormat(t))}</text>`;
    }
    if (o.unit) g += `<text class="axis-title" x="${p.l - 8}" y="${p.t - 12}" text-anchor="end">${esc(o.unit)}</text>`;
    if (x.length > 1) {
      const xs = niceScale(xMin, xMax, Math.max(2, Math.floor(iw / 90)));
      for (const t of xs.ticks) {
        if (t < xMin - 1e-9 || t > xMax + 1e-9) continue;
        g += `<text class="axis-text" x="${sx(t)}" y="${H - 7}" text-anchor="middle">${esc(o.xFormat(t))}</text>`;
      }
    }
    let paths = "";
    for (const { s, vals, lower } of stacks) {
      let d = "", segStart = -1, area = "";
      const flushArea = (from, to) => {
        if (!(s.area || o.stacked) || from < 0 || to <= from) return;
        let a = `M${sx(x[from])},${sy(vals[from])}`;
        for (let i = from + 1; i <= to; i++) a += `L${sx(x[i])},${sy(vals[i])}`;
        for (let i = to; i >= from; i--) a += `L${sx(x[i])},${sy(lower ? lower[i] : yMin)}`;
        area += `<path d="${a}Z" fill="${s.color}" opacity="${o.stacked ? 0.28 : 0.12}"/>`;
      };
      for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        if (v == null) { flushArea(segStart, i - 1); segStart = -1; continue; }
        d += `${segStart < 0 ? "M" : "L"}${sx(x[i]).toFixed(1)},${sy(v).toFixed(1)}`;
        if (segStart < 0) segStart = i;
      }
      flushArea(segStart, vals.length - 1);
      if (s.dots) for (let i = 0; i < vals.length; i++) if (vals[i] != null) area += `<circle cx="${sx(x[i])}" cy="${sy(vals[i])}" r="3.5" fill="${s.color}" stroke="#050912" stroke-width="1.5"/>`;
      paths += area + `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.8}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    let thr = "";
    for (const t of o.thresholds) {
      if (t.y > yMax || t.y < yMin) continue;
      const y = sy(t.y);
      thr += `<line class="thr-line" x1="${p.l}" x2="${W - p.r}" y1="${y}" y2="${y}" stroke="${t.color}"/>
        <text class="thr-text" x="${W - p.r - 4}" y="${y - 4}" text-anchor="end" fill="${t.color}">${esc(t.label)}</text>`;
    }
    const empty = !has ? `<text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">${esc(o.emptyText)}</text>` : "";
    this.holder.innerHTML = `<svg xmlns="${NS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}${paths}${thr}${empty}
      <g class="hover"></g><rect class="overlay" x="${p.l}" y="${p.t}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;
    this.bind();
  }

  onMove(ev) {
    const { x = [] } = this.data;
    if (!x.length || !this.geom) return;
    const { sx, sy, xMin, xMax, p, iw, ih, stacks } = this.geom;
    const rect = this.el.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const xv = xMin + ((mx - p.l) / iw) * (xMax - xMin);
    let lo = 0, hi = x.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x[m] < xv) lo = m; else hi = m; }
    const i = Math.abs(x[lo] - xv) < Math.abs(x[hi] - xv) ? lo : hi;
    const X = sx(x[i]);
    let hov = `<line class="hover-line" x1="${X}" x2="${X}" y1="${p.t}" y2="${p.t + ih}"/>`;
    let rows = "";
    for (const { s, vals } of stacks) {
      const raw = s.values[i];
      if (vals[i] != null) hov += `<circle cx="${X}" cy="${sy(vals[i])}" r="3.5" fill="${s.color}" stroke="#050912" stroke-width="1.5"/>`;
      rows += `<div class="t-row"><span><i class="swatch" style="background:${s.color}"></i>${esc(s.name)}</span><b>${raw == null ? "—" : fmt(raw, this.o.tipDigits)}${this.o.tipUnit ? " " + this.o.tipUnit : ""}</b></div>`;
    }
    this.holder.querySelector(".hover").innerHTML = hov;
    this.showTip(X, p.t + 10, `<div class="t-head">${esc(this.o.xFormat(x[i], true))}</div>${rows}`);
  }
}

// ---------------------------------------------------------------------------- barres
export class BarChart extends BaseChart {
  constructor(el, opts = {}) {
    super(el, { height: 220, pad: { t: 26, r: 10, b: 30, l: 44 }, unit: "", stacked: false, yFormat: autoFmt, labels: true,
      digits: 1, tipUnit: "", ...opts });
    this.data = { categories: [], series: [] };
    this.render();
  }
  set(data) { this.data = data; this.render(); }
  render() {
    const o = this.o, W = Math.max(200, this.el.clientWidth || 500), H = o.height, p = o.pad;
    const { categories = [], series = [] } = this.data;
    const iw = W - p.l - p.r, ih = H - p.t - p.b;
    let maxV = 0;
    categories.forEach((_, ci) => {
      if (o.stacked) maxV = Math.max(maxV, series.reduce((a, s) => a + (s.values[ci] || 0), 0));
      else series.forEach((s) => (maxV = Math.max(maxV, s.values[ci] || 0)));
    });
    const sc = niceScale(0, Math.max(maxV * 1.12, o.minMax || 1e-9), 4);
    const sy = (v) => p.t + (1 - v / sc.max) * ih;
    let g = "";
    for (const t of sc.ticks) {
      g += `<line class="grid-line" x1="${p.l}" x2="${W - p.r}" y1="${sy(t)}" y2="${sy(t)}"/>
            <text class="axis-text" x="${p.l - 8}" y="${sy(t) + 3.5}" text-anchor="end">${esc(o.yFormat(t))}</text>`;
    }
    if (o.unit) g += `<text class="axis-title" x="${p.l - 8}" y="${p.t - 14}" text-anchor="end">${esc(o.unit)}</text>`;
    const gw = iw / Math.max(1, categories.length);
    const n = o.stacked ? 1 : series.length;
    const bw = Math.min(46, (gw * 0.72) / Math.max(1, n));
    let bars = "";
    this.hit = [];
    categories.forEach((cat, ci) => {
      const gx = p.l + gw * ci + (gw - bw * n - (n - 1) * 3) / 2;
      let acc = 0;
      series.forEach((s, si) => {
        const v = s.values[ci];
        if (v == null) return;
        const x = o.stacked ? gx : gx + si * (bw + 3);
        const y0 = o.stacked ? sy(acc) : sy(0);
        const y1 = o.stacked ? sy(acc + v) : sy(v);
        const color = typeof s.color === "function" ? s.color(ci) : s.color;
        bars += `<rect x="${x}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.max(1, Math.abs(y0 - y1))}" rx="${o.stacked ? 2 : 4}" fill="${color}" opacity="${s.opacity ?? 0.92}"/>`;
        if (o.labels && !o.stacked && v !== 0) bars += `<text class="axis-text" x="${x + bw / 2}" y="${y1 - 5}" text-anchor="middle" style="fill:var(--text-2)">${esc(fmt(v, o.digits))}</text>`;
        acc += v;
      });
      g += `<text class="axis-text" x="${p.l + gw * ci + gw / 2}" y="${H - 9}" text-anchor="middle" style="fill:var(--text-2);font-family:var(--font);font-size:11.5px">${esc(cat)}</text>`;
      this.hit.push({ x0: p.l + gw * ci, x1: p.l + gw * (ci + 1), ci });
    });
    this.holder.innerHTML = `<svg xmlns="${NS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}${bars}<g class="hover"></g>
      <rect class="overlay" x="${p.l}" y="${p.t}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;
    this.bind();
  }
  onMove(ev) {
    const rect = this.el.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const h = this.hit.find((b) => mx >= b.x0 && mx < b.x1);
    if (!h) return;
    const { categories, series } = this.data;
    const rows = series.map((s) => {
      const color = typeof s.color === "function" ? s.color(h.ci) : s.color;
      const v = s.values[h.ci];
      return `<div class="t-row"><span><i class="swatch" style="background:${color}"></i>${esc(s.name)}</span><b>${v == null ? "—" : fmt(v, this.o.digits)}${this.o.tipUnit ? " " + this.o.tipUnit : ""}</b></div>`;
    }).join("");
    this.holder.querySelector(".hover").innerHTML = `<rect x="${h.x0}" y="${this.o.pad.t}" width="${h.x1 - h.x0}" height="${this.o.height - this.o.pad.t - this.o.pad.b}" fill="rgba(148,163,184,.05)"/>`;
    this.showTip((h.x0 + h.x1) / 2, this.o.pad.t + 10, `<div class="t-head">${esc(categories[h.ci])}</div>${rows}`);
  }
}

// ---------------------------------------------------------------------------- anneau
export function donut(segments, { size = 168, stroke = 22, center = "", sub = "" } = {}) {
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, cx = size / 2;
  let off = 0, arcs = "";
  if (total <= 0) {
    arcs = `<circle cx="${cx}" cy="${cx}" r="${r}" stroke="#1a2640" stroke-width="${stroke}" fill="none"/>`;
  } else {
    for (const s of segments) {
      const frac = Math.max(0, s.value) / total;
      if (frac <= 0) continue;
      const len = Math.max(0, c * frac - 2);
      arcs += `<circle cx="${cx}" cy="${cx}" r="${r}" stroke="${s.color}" stroke-width="${stroke}" fill="none" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cx} ${cx})"><title>${esc(s.label)} : ${fmt(frac * 100, 1)} %</title></circle>`;
      off += c * frac;
    }
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block">${arcs}
    <text x="${cx}" y="${cx - 2}" text-anchor="middle" style="fill:var(--text);font-family:var(--mono);font-size:22px;font-weight:600">${esc(center)}</text>
    <text x="${cx}" y="${cx + 16}" text-anchor="middle" style="fill:var(--muted);font-size:11px">${esc(sub)}</text></svg>`;
}

// ---------------------------------------------------------------------------- jauge semi-circulaire
export function gauge(value, { min = 0, max = 5, width = 210, stops = [], label = "", sub = "", digits = 2 } = {}) {
  const h = width * 0.6, cx = width / 2, cy = h - 12, r = width / 2 - 16;
  const ang = (v) => Math.PI * (1 - (Math.max(min, Math.min(max, v)) - min) / (max - min));
  const pt = (a, rr = r) => [cx + rr * Math.cos(a), cy - rr * Math.sin(a)];
  const arc = (v0, v1, color, w = 12) => {
    const [x0, y0] = pt(ang(v0)), [x1, y1] = pt(ang(v1));
    const large = ang(v0) - ang(v1) > Math.PI ? 1 : 0;
    return `<path d="M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1}" stroke="${color}" stroke-width="${w}" fill="none" stroke-linecap="butt"/>`;
  };
  let s = arc(min, max, "#1a2640", 12);
  let prev = min;
  for (const st of stops) { s += arc(prev, st.to, st.color + "55", 12); prev = st.to; }
  const active = value == null ? null : stops.find((st) => value <= st.to) || stops[stops.length - 1];
  if (value != null) s += arc(min, value, active ? active.color : "#22d3ee", 12);
  const [nx, ny] = value == null ? pt(Math.PI) : pt(ang(value), r - 22);
  s += value == null ? "" : `<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="#e5ecf6" stroke-width="2.5" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="5" fill="#e5ecf6"/>`;
  return `<svg width="${width}" height="${h + 34}" viewBox="0 0 ${width} ${h + 34}" style="display:block;margin:auto">${s}
    <text x="${cx}" y="${cy + 30}" text-anchor="middle" style="fill:var(--text);font-family:var(--mono);font-size:24px;font-weight:600">${value == null ? "—" : fmt(value, digits)}</text>
    <text x="16" y="${cy + 14}" style="fill:var(--dim);font-size:10px;font-family:var(--mono)">${min}</text>
    <text x="${width - 16}" y="${cy + 14}" text-anchor="end" style="fill:var(--dim);font-size:10px;font-family:var(--mono)">${max}</text>
    ${label ? `<text x="${cx}" y="16" text-anchor="middle" style="fill:var(--muted);font-size:11px">${esc(label)}</text>` : ""}
    ${sub ? `<text x="${cx}" y="${cy - r / 2.4}" text-anchor="middle" style="fill:${active ? active.color : "var(--muted)"};font-size:12px;font-weight:600">${esc(sub)}</text>` : ""}</svg>`;
}

// ---------------------------------------------------------------------------- sparkline
export function sparkline(values, color = "#22d3ee", { height = 34, min = 0, max = null } = {}) {
  const vals = values.filter((v) => v != null);
  if (vals.length < 2) return `<svg viewBox="0 0 100 ${height}" preserveAspectRatio="none"></svg>`;
  const hi = max ?? (Math.max(...vals) * 1.15 || 1);
  const n = values.length;
  let d = "", first = null, last = null;
  values.forEach((v, i) => {
    if (v == null) return;
    const x = (i / (n - 1)) * 100, y = height - 2 - ((v - min) / (hi - min || 1)) * (height - 4);
    d += `${first === null ? "M" : "L"}${x.toFixed(2)},${Math.max(1, y).toFixed(2)}`;
    if (first === null) first = x;
    last = x;
  });
  const gid = "sg" + Math.random().toString(36).slice(2, 8);
  return `<svg viewBox="0 0 100 ${height}" preserveAspectRatio="none"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${d}L${last},${height}L${first},${height}Z" fill="url(#${gid})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}
