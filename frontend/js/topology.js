// Topologie réseau animée (SVG) : sources → switch → routeur goulot (files QoS) → WAN → routeur → récepteurs.
// Les paquets circulent sous forme de particules colorées par classe ; les paquets rejetés
// deviennent rouges et tombent au niveau du routeur (buffer) ou du nuage WAN (perte du lien).

import { CLASS_INFO, CLASSES, ICONS, esc, fmt, fmtAuto } from "./ui.js";

const VB_W = 1100;
const X = { src: 12, srcW: 212, sw: 336, r1: 502, cloud: 740, r2: 872, rcv: 940, rcvW: 152 };
let VB_H = 480, MID = 236;   // recalculés selon le nombre de flux
const MAX_SRC = 10;
const MAX_PARTICLES = 260;

const utilColor = (u) => (u == null ? "#24334f" : u < 0.7 ? "#34d399" : u < 0.9 ? "#fb923c" : "#f87171");
const iconSvg = (name, x, y, size, color) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
const classIconName = (c) => (c === "voice" ? "phone" : c === "video" ? "video" : "data");
const short = (s, n = 20) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export class Topology {
  constructor(el, { onSelect = null, height = null } = {}) {
    this.el = el;
    this.onSelect = onSelect;
    this.selected = null;
    this.particles = [];
    this.prevFlows = {};
    this.prevDrops = null;
    this.raf = null;
    this.alive = true;
    el.classList.add("topo");
    if (height) el.style.maxHeight = height;
    this.step = this.step.bind(this);
  }

  destroy() {
    this.alive = false;
    cancelAnimationFrame(this.raf);
  }

  setConfig(cfg, scheduler = null) {
    this.cfg = cfg;
    const flows = cfg.flows || [];
    const order = [...flows].sort((a, b) => CLASSES.indexOf(a.type) - CLASSES.indexOf(b.type));
    let shown = order, hidden = [];
    if (order.length > MAX_SRC) { shown = order.slice(0, MAX_SRC - 1); hidden = order.slice(MAX_SRC - 1); }
    const n = shown.length + (hidden.length ? 1 : 0);
    const gap = 48;
    VB_H = Math.max(340, (n - 1) * gap + 150);
    MID = 30 + (VB_H - 60) / 2;
    const y0 = MID - ((n - 1) * gap) / 2;
    this.srcPos = {};
    const nodes = shown.map((f, i) => ({ flow: f, y: y0 + i * gap }));
    if (hidden.length) {
      const y = y0 + shown.length * gap;
      nodes.push({ group: hidden, y });
      hidden.forEach((f) => (this.srcPos[f.id] = y));
    }
    nodes.forEach((nd) => { if (nd.flow) this.srcPos[nd.flow.id] = nd.y; });
    this.nodes = nodes;
    const sched = scheduler || (cfg.qos?.enabled ? cfg.qos.scheduler : "fifo");
    const rcvY = { voice: MID - 105, video: MID, data: MID + 105 };
    this.rcvY = rcvY;

    let links = "", srcs = "";
    for (const nd of nodes) {
      const y = nd.y;
      const c = nd.flow ? nd.flow.type : "data";
      const color = nd.flow ? CLASS_INFO[c].color : "#8494ad";
      const off = nd.flow && nd.flow.enabled === false;
      links += `<path class="link" d="M${X.src + X.srcW},${y} C${X.src + X.srcW + 60},${y} ${X.sw - 90},${MID} ${X.sw - 45},${MID}"/>`;
      links += `<path class="link-flow" stroke="${color}" d="M${X.src + X.srcW},${y} C${X.src + X.srcW + 60},${y} ${X.sw - 90},${MID} ${X.sw - 45},${MID}" ${off ? 'opacity=".08"' : ""}/>`;
      if (nd.flow) {
        const f = nd.flow;
        const sub = f.type === "voice" ? `${f.calls} appels · ${f.codec}` : f.type === "video" ? `${fmtAuto(f.rate_mbps)} Mbit/s · ${f.fps} i/s` : `${fmtAuto(f.rate_mbps)} Mbit/s · ${(f.protocol || "tcp").toUpperCase()}`;
        srcs += `<g class="node ${off ? "off" : ""}" data-kind="flow" data-id="${esc(f.id)}">
          <rect class="shape" x="${X.src}" y="${y - 19}" width="${X.srcW}" height="38" rx="10"/>
          <rect x="${X.src + 6}" y="${y - 13}" width="26" height="26" rx="7" fill="${color}22"/>
          ${iconSvg(classIconName(c), X.src + 10, y - 9, 18, color)}
          <text class="node-label" x="${X.src + 40}" y="${y - 3}">${esc(short(f.name, 22))}</text>
          <text class="node-sub" x="${X.src + 40}" y="${y + 11}">${esc(sub)}</text>
          <circle cx="${X.src + X.srcW - 10}" cy="${y}" r="3" fill="${off ? "#56657f" : color}" data-led="${esc(f.id)}"/>
        </g>`;
      } else {
        srcs += `<g class="node" data-kind="group"><rect class="shape" x="${X.src}" y="${y - 17}" width="${X.srcW}" height="34" rx="9" stroke-dasharray="4 3"/>
          <text class="node-label" x="${X.src + 14}" y="${y + 4}">+ ${nd.group.length} autres flux</text></g>`;
      }
    }
    // tronçons partagés
    links += `<path class="link" d="M${X.sw + 45},${MID} L${X.r1 - 62},${MID}"/>`;
    links += `<path class="bottleneck-bg" d="M${X.r1 + 62},${MID} L${X.cloud - 58},${MID}"/>`;
    links += `<path class="bottleneck" id="bneck" stroke="${utilColor(null)}" d="M${X.r1 + 62},${MID} L${X.cloud - 58},${MID}"/>`;
    links += `<path class="link" d="M${X.cloud + 58},${MID} L${X.r2 - 45},${MID}"/>`;
    for (const c of CLASSES) {
      const y = rcvY[c];
      links += `<path class="link" d="M${X.r2 + 45},${MID} C${X.r2 + 80},${MID} ${X.rcv - 50},${y} ${X.rcv},${y}"/>`;
    }
    const zone = (x, t) => `<text class="zone-label" x="${x}" y="22" text-anchor="middle">${t}</text>`;
    const box = (kind, x, w, h, title, sub, ic) => `<g class="node" data-kind="${kind}">
        <rect class="shape" x="${x - w / 2}" y="${MID - h / 2}" width="${w}" height="${h}" rx="11"/>
        ${iconSvg(ic, x - w / 2 + 10, MID - 10, 20, "#22d3ee")}
        <text class="node-label" x="${x - w / 2 + 38}" y="${MID - 2}">${title}</text>
        <text class="node-sub" x="${x - w / 2 + 38}" y="${MID + 11}" id="sub-${kind}">${sub}</text></g>`;
    const net = cfg.network || {};
    const qbars = CLASSES.map((c, i) => {
      const y = MID + 50 + i * 20;
      return `<text class="node-sub" x="${X.r1 - 60}" y="${y + 8}" style="fill:${CLASS_INFO[c].color}">${CLASS_INFO[c].label}</text>
        <rect class="qbar-bg" x="${X.r1 - 18}" y="${y}" width="80" height="10" rx="3"/>
        <rect id="q-${c}" x="${X.r1 - 18}" y="${y}" width="0" height="10" rx="3" fill="${CLASS_INFO[c].color}"/>
        <text class="node-sub" id="qt-${c}" x="${X.r1 + 68}" y="${y + 8}">0</text>`;
    }).join("");
    const cloud = `<g class="node" data-kind="wan">
        <path class="shape" d="M${X.cloud - 46},${MID + 22} a22,22 0 0 1 2,-43 a28,28 0 0 1 50,-8 a22,22 0 0 1 38,14 a18,18 0 0 1 2,37 z"/>
        <text class="node-label" x="${X.cloud}" y="${MID + 2}" text-anchor="middle">WAN</text>
        <text class="node-sub" x="${X.cloud}" y="${MID + 14}" text-anchor="middle" id="sub-wan">${fmt(net.base_latency_ms, 0)} ms · ${fmt(net.loss_pct, 1)} %</text></g>`;
    const rcv = CLASSES.map((c) => {
      const y = rcvY[c], color = CLASS_INFO[c].color;
      const name = c === "voice" ? "Passerelle VoIP" : c === "video" ? "Clients vidéo" : "Serveurs data";
      return `<g class="node" data-kind="rcv" data-id="${c}">
        <rect class="shape" x="${X.rcv}" y="${y - 19}" width="${X.rcvW}" height="38" rx="9"/>
        ${iconSvg(c === "data" ? "server" : classIconName(c), X.rcv + 8, y - 8, 16, color)}
        <text class="node-label" x="${X.rcv + 30}" y="${y - 3}">${name}</text>
        <text class="node-sub" x="${X.rcv + 30}" y="${y + 10}" id="rcv-${c}">—</text></g>`;
    }).join("");

    this.el.innerHTML = `<svg viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid meet">
      <defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      ${zone(X.src + X.srcW / 2, "Sources")}${zone(X.sw, "Accès")}${zone(X.r1, "Routeur goulot")}${zone(X.cloud, "WAN")}${zone(X.r2, "Cœur")}${zone(X.rcv + X.rcvW / 2, "Récepteurs")}
      <g>${links}</g>
      <g class="particles" filter="url(#glow)"></g>
      <g class="paths" style="display:none"></g>
      <g>${srcs}</g>
      ${box("switch", X.sw, 90, 46, "Switch", "L2 · accès", "switch")}
      ${box("router", X.r1, 124, 56, "Routeur R1", (sched || "fifo").toUpperCase(), "router")}
      <g class="node" data-kind="router">${qbars}</g>
      <g transform="translate(${(X.r1 + X.cloud) / 2 + 4},${MID - 32})">
        <rect class="badge-bg" x="-58" y="-13" width="116" height="22" rx="11"/>
        <text class="node-sub" id="bneck-label" x="0" y="2" text-anchor="middle" style="fill:var(--text)">${fmt(net.bandwidth_mbps, 0)} Mbit/s</text>
      </g>
      ${cloud}
      ${box("core", X.r2, 90, 46, "Routeur R2", "cœur", "router")}
      ${rcv}
    </svg>
    <div class="topo-overlay">${CLASSES.map((c) => `<span><i class="swatch" style="background:${CLASS_INFO[c].color}"></i>${CLASS_INFO[c].label}</span>`).join("")}
      <span><i class="swatch" style="background:#f87171"></i>Paquet perdu</span></div>`;

    // Chemins complets (mesure des positions des particules)
    const pathsG = this.el.querySelector(".paths");
    this.paths = {};
    for (const f of flows) {
      const y = this.srcPos[f.id];
      const yr = rcvY[f.type];
      const head = `M${X.src + X.srcW},${y} C${X.src + X.srcW + 60},${y} ${X.sw - 90},${MID} ${X.sw - 45},${MID} L${X.r1},${MID}`;
      const toCloud = `${head} L${X.cloud},${MID}`;
      const full = `${toCloud} L${X.r2},${MID} L${X.r2 + 45},${MID} C${X.r2 + 80},${MID} ${X.rcv - 50},${yr} ${X.rcv},${yr}`;
      const mk = (d) => { const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); pathsG.appendChild(p); return p; };
      const pf = mk(full), ph = mk(head), pc = mk(toCloud);
      const len = pf.getTotalLength();
      this.paths[f.id] = { el: pf, len, r1: ph.getTotalLength() / len, cloud: pc.getTotalLength() / len, color: CLASS_INFO[f.type].color };
    }
    this.particleG = this.el.querySelector(".particles");
    this.el.querySelectorAll(".node").forEach((g) => {
      g.addEventListener("click", () => {
        const sel = { kind: g.dataset.kind, id: g.dataset.id || null };
        this.select(sel);
        if (this.onSelect) this.onSelect(sel);
      });
    });
    if (this.selected) this.select(this.selected);
    this.particles = [];
    this.prevFlows = {};
    this.prevDrops = null;
  }

  select(sel) {
    this.selected = sel;
    this.el.querySelectorAll(".node").forEach((g) => {
      const match = sel && g.dataset.kind === sel.kind && (sel.id == null || g.dataset.id === sel.id);
      g.classList.toggle("sel", !!match);
    });
  }

  // Mise à jour live : couleurs, files, compteurs et génération de particules
  update(state, lastWindow) {
    if (!state || !this.paths) return;
    const util = lastWindow ? lastWindow.utilization : null;
    const bn = this.el.querySelector("#bneck");
    if (bn) bn.setAttribute("stroke", utilColor(util));
    const lbl = this.el.querySelector("#bneck-label");
    const cap = lastWindow ? lastWindow.capacity : this.cfg.network.bandwidth_mbps;
    if (lbl) lbl.textContent = `${fmt(cap, cap < 10 ? 1 : 0)} Mbit/s · ${util == null ? "—" : fmt(util * 100, 0) + " %"}`;
    const sub = this.el.querySelector("#sub-router");
    if (sub) sub.textContent = `${state.scheduler.toUpperCase()} · ${Object.values(state.queue).reduce((a, b) => a + b, 0)} pkts`;
    const lim = state.queue_limits || {};
    for (const c of CLASSES) {
      const q = state.queue[c] || 0;
      const L = lim[c] || lim.total || 100;
      const r = this.el.querySelector(`#q-${c}`);
      if (r) r.setAttribute("width", String(Math.min(80, (q / L) * 80)));
      const t = this.el.querySelector(`#qt-${c}`);
      if (t) t.textContent = String(q);
    }
    if (lastWindow) {
      for (const c of CLASSES) {
        const g = lastWindow.classes[c];
        const el = this.el.querySelector(`#rcv-${c}`);
        if (el) el.textContent = g.recv ? `${fmt(g.throughput, 1)} Mb/s · ${fmt(g.latency, 0)} ms` : "—";
      }
    }
    // particules
    const dropsNow = state.drops || { buffer: 0, link: 0, policer: 0 };
    let linkShare = 0;
    if (this.prevDrops) {
      const db = dropsNow.buffer - this.prevDrops.buffer + dropsNow.policer - this.prevDrops.policer;
      const dl = dropsNow.link - this.prevDrops.link;
      linkShare = db + dl > 0 ? dl / (db + dl) : 0;
    }
    this.prevDrops = { ...dropsNow };
    const deltas = [];
    let totalSent = 0;
    for (const f of state.flows) {
      const prev = this.prevFlows[f.id];
      this.prevFlows[f.id] = { sent: f.sent || 0, drops: f.drops || 0 };
      if (!prev || !this.paths[f.id] || f.enabled === false) continue;
      const ds = Math.max(0, (f.sent || 0) - prev.sent), dd = Math.max(0, (f.drops || 0) - prev.drops);
      totalSent += ds;
      deltas.push({ f, ds, dd });
    }
    if (!totalSent) return;
    const budget = Math.max(0, MAX_PARTICLES - this.particles.length);
    const scale = Math.max(1, totalSent / Math.min(34, budget || 1));
    const lat = lastWindow?.classes?.all?.latency ?? 20;
    const dur = 1500 + Math.min(1600, lat * 6);
    const now = performance.now();
    for (const { f, ds, dd } of deltas) {
      const p = this.paths[f.id];
      let n = Math.round(ds / scale);
      if (ds > 0 && n === 0 && Math.random() < ds / scale) n = 1;
      let nd = dd > 0 ? Math.max(1, Math.round(dd / scale)) : 0;
      nd = Math.min(nd, Math.max(n, 1));
      for (let i = 0; i < n + (nd > n ? nd - n : 0); i++) {
        const drop = i < nd;
        const atLink = drop && Math.random() < linkShare;
        this.spawn(p, now + Math.random() * 200, dur * (0.9 + Math.random() * 0.2), drop ? (atLink ? p.cloud : p.r1) : null);
      }
    }
    if (!this.raf) this.raf = requestAnimationFrame(this.step);
  }

  spawn(p, start, dur, dropAt) {
    if (this.particles.length >= MAX_PARTICLES) return;
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("r", dropAt != null ? "3.6" : "3");
    c.setAttribute("fill", p.color);
    c.setAttribute("opacity", "0");
    this.particleG.appendChild(c);
    this.particles.push({ c, p, start, dur, dropAt, red: false });
  }

  step(now) {
    this.raf = null;
    if (!this.alive) return;
    const keep = [];
    for (const pt of this.particles) {
      let t = (now - pt.start) / pt.dur;
      if (t < 0) { keep.push(pt); continue; }
      if (pt.dropAt != null && t >= pt.dropAt) {
        const k = (t - pt.dropAt) / 0.18;
        if (k >= 1) { pt.c.remove(); continue; }
        if (!pt.red) { pt.c.setAttribute("fill", "#f87171"); pt.red = true; const pos0 = pt.p.el.getPointAtLength(pt.dropAt * pt.p.len); pt.x0 = pos0.x; pt.y0 = pos0.y; }
        pt.c.setAttribute("cx", pt.x0 + k * 10);
        pt.c.setAttribute("cy", pt.y0 + k * k * 60);
        pt.c.setAttribute("opacity", String(1 - k));
        keep.push(pt);
        continue;
      }
      if (t >= 1) { pt.c.remove(); continue; }
      const pos = pt.p.el.getPointAtLength(t * pt.p.len);
      pt.c.setAttribute("cx", pos.x);
      pt.c.setAttribute("cy", pos.y);
      pt.c.setAttribute("opacity", t > 0.94 ? String((1 - t) / 0.06) : "0.95");
      keep.push(pt);
    }
    this.particles = keep;
    if (keep.length) this.raf = requestAnimationFrame(this.step);
  }

  clearParticles() {
    for (const pt of this.particles) pt.c.remove();
    this.particles = [];
    this.prevFlows = {};
    this.prevDrops = null;
  }
}
