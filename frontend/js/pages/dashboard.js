// 01 — Dashboard : vue globale temps réel (KPI, graphiques, topologie, alertes).

import { LineChart, donut, sparkline } from "../charts.js";
import { aggregate, healthScore } from "../metrics.js";
import { liveStart, on, presetConfig, setConfig, store } from "../store.js";
import { Topology } from "../topology.js";
import {
  CLASSES, CLASS_INFO, SCHED_LABEL, STATUS, esc, fmt, fmtAuto, fmtTime, healthStatus, icon, mosLabel, mosStatus,
  pill, statusOf, utilStatus, worst,
} from "../ui.js";

const VIEW_SECONDS = 60;

export default {
  title: "Dashboard",
  eyebrow: "Network Control Center",
  mount(view) {
    const th = store.meta.thresholds;
    let metric = "latency";
    view.innerHTML = `
      <div class="page-head">
        <div>
          <div class="eyebrow">Network Control Center</div>
          <h1>Vue d'ensemble du réseau</h1>
          <p id="d-desc"></p>
        </div>
        <div class="head-meta" id="d-meta"></div>
      </div>
      <div id="d-hero"></div>
      <div class="grid g-6" id="d-kpis"></div>
      <div class="grid g-main">
        <div class="card">
          <div class="card-head">
            <div class="card-title">${icon("analysis")}<span id="m-title">Latence par classe de trafic</span></div>
            <div class="seg" id="m-seg">
              <button data-m="latency" class="on">Latence</button><button data-m="jitter">Jitter</button><button data-m="loss">Pertes</button><button data-m="mos">MOS</button>
            </div>
          </div>
          <div id="c-main"></div>
          <div class="legend" style="margin-top:8px">${CLASSES.map((c) => `<span><i style="background:${CLASS_INFO[c].color}"></i>${CLASS_INFO[c].label}</span>`).join("")}<span class="muted" id="m-thr"></span></div>
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">${icon("layers")}Répartition du trafic</div><span class="card-sub">débit reçu, 1 s glissante</span></div>
          <div class="row" style="justify-content:center;gap:22px" id="d-donut"></div>
        </div>
      </div>
      <div class="grid g-main">
        <div class="card">
          <div class="card-head"><div class="card-title">${icon("gauge")}Débit par classe vs capacité du lien</div><span class="card-sub">Mbit/s — aires empilées</span></div>
          <div id="c-thr"></div>
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">${icon("bell")}Alertes temps réel</div><span class="card-sub" id="al-count"></span></div>
          <div class="alerts" id="d-alerts"></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">${icon("topology")}Topologie — trafic en direct</div><a class="btn sm" href="#/topology">Ouvrir la topologie</a></div>
        <div id="d-topo"></div>
      </div>
      <div class="grid g-2">
        <div class="card">
          <div class="card-head"><div class="card-title">${icon("layers")}Occupation de la file du routeur</div><span class="card-sub">paquets en attente, par classe</span></div>
          <div id="c-queue"></div>
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">${icon("analysis")}État par classe de trafic</div><span class="card-sub">1 s glissante</span></div>
          <div class="table-wrap"><table class="tbl" id="d-table"></table></div>
        </div>
      </div>`;

    const cMain = new LineChart(view.querySelector("#c-main"), { height: 250, tipDigits: 1 });
    const cThr = new LineChart(view.querySelector("#c-thr"), { height: 230, stacked: true, unit: "Mbit/s", tipUnit: "Mbit/s", tipDigits: 2 });
    const cQueue = new LineChart(view.querySelector("#c-queue"), { height: 190, stacked: true, unit: "pkts", tipDigits: 0 });
    const topo = new Topology(view.querySelector("#d-topo"));

    const cfgNow = () => (store.live.status !== "idle" && store.live.config) || store.config;
    const setTopo = () => topo.setConfig(cfgNow(), store.live.state?.scheduler);
    setTopo();

    view.querySelector("#m-seg").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-m]");
      if (!b) return;
      metric = b.dataset.m;
      view.querySelectorAll("#m-seg button").forEach((x) => x.classList.toggle("on", x === b));
      renderCharts();
    });

    function renderHead() {
      const cfg = cfgNow();
      const L = store.live;
      view.querySelector("#d-desc").textContent = cfg.description || "Scénario personnalisé — configurez-le dans le Scenario Builder.";
      const st = L.status === "running" ? pill("good", "Réseau actif", true) : L.status === "paused" ? pill("warn", "En pause") : L.status === "connecting" ? pill("warn", "Connexion…") : pill("idle", L.windows.length ? "Session terminée" : "Simulation arrêtée");
      const sched = L.state?.scheduler || (cfg.qos.enabled ? cfg.qos.scheduler : "fifo");
      view.querySelector("#d-meta").innerHTML = `${st}
        <span class="pill st-${sched === "fifo" ? "idle" : "info"}">${icon("layers")} ${esc(SCHED_LABEL[sched])}</span>
        <span class="pill"><span class="mono">${fmtTime(L.t || 0)}</span></span>
        <span class="pill">${esc(cfg.name)}</span>`;
      const hero = view.querySelector("#d-hero");
      if (L.status === "idle" && !L.windows.length) {
        hero.innerHTML = `<div class="card hero glow">
          <div>
            <div class="eyebrow">Simulation temps réel</div>
            <h2>Générez des flux voix, vidéo et data et observez la QoS en direct</h2>
            <p>Choisissez un scénario puis démarrez : la file du routeur, la latence, le jitter, les pertes et le MOS se mettent à jour toutes les 200 ms. Activez la QoS pendant la simulation pour voir la voix se rétablir.</p>
            <div class="row"><button class="btn primary" id="hero-start">${icon("play")}Démarrer « ${esc(cfg.name)} »</button><a class="btn" href="#/builder">${icon("builder")}Personnaliser</a></div>
          </div>
          <div class="preset-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
            ${store.presets.slice(0, 6).map((p) => `<button class="preset ${cfg.preset === p.id ? "on" : ""}" data-preset="${p.id}" style="min-height:0">
              <span class="row between"><span class="p-num">${String(p.number).padStart(2, "0")}</span><span class="tag">${esc(p.level)}</span></span>
              <span class="p-name">${esc(p.name)}</span></button>`).join("")}
          </div></div>`;
        hero.querySelector("#hero-start").onclick = () => liveStart(store.config);
        hero.querySelectorAll("[data-preset]").forEach((b) => (b.onclick = () => {
          setConfig(presetConfig(b.dataset.preset));
          renderHead();
          setTopo();
        }));
      } else hero.innerHTML = "";
    }

    function kpi(label, value, unit, status, sub, spark, color) {
      return `<div class="card kpi st-${status}">
        <div class="k-label">${label}<span class="dot"></span></div>
        <div class="k-value"><span class="v">${value}</span><span class="u">${unit}</span></div>
        <div class="k-sub">${sub}</div>
        <div class="k-spark">${spark ? sparkline(spark, color) : ""}</div></div>`;
    }

    function renderKpis() {
      const W = store.live.windows;
      const recent = W.slice(-4);
      const a = aggregate(recent);
      const has = recent.length > 0;
      const tail = W.slice(-80);
      const clsStatus = (m) => worst(CLASSES.filter((c) => a[c].recv).map((c) => statusOf(th, c, m, a[c][m])));
      const subOf = (m, u) => CLASSES.filter((c) => a[c].recv).map((c) => `${CLASS_INFO[c].label} ${fmtAuto(a[c][m])}${u}`).join(" · ") || "Live measurement";
      const hs = has ? healthScore(a, th) : null;
      const mos = a.voice.mos;
      view.querySelector("#d-kpis").innerHTML = [
        kpi("Latence", has ? fmtAuto(a.all.latency) : "—", "ms", has ? clsStatus("latency") : "idle", has ? subOf("latency", "") : "moyenne one-way", tail.map((w) => w.classes.all.latency), "#22d3ee"),
        kpi("Jitter", has ? fmtAuto(a.all.jitter) : "—", "ms", has ? clsStatus("jitter") : "idle", has ? subOf("jitter", "") : "gigue RFC 3550", tail.map((w) => w.classes.all.jitter), "#a78bfa"),
        kpi("Bande passante", has ? fmt(a.utilization * 100, 0) : "—", "%", utilStatus(has ? a.utilization : null), has ? `${fmtAuto(a.all.throughput)} / ${fmtAuto(a.capacity)} Mbit/s utilisés` : "utilisation du lien goulot", tail.map((w) => w.utilization * 100), "#34d399"),
        kpi("Perte de paquets", has ? fmt(a.all.loss, a.all.loss < 10 ? 2 : 1) : "—", "%", has ? clsStatus("loss") : "idle", has ? subOf("loss", " %") : "buffer + lien", tail.map((w) => w.classes.all.loss), "#f87171"),
        kpi("MOS voix", mos != null ? fmt(mos, 2) : "—", "/ 5", mosStatus(mos), mos != null ? `Qualité ${mosLabel(mos).toLowerCase()} · E-model estimé` : "Mean Opinion Score estimé", tail.map((w) => w.classes.voice.mos), "#22d3ee"),
        kpi("Santé réseau", hs != null ? fmt(hs, 0) : "—", "/ 100", healthStatus(hs), hs != null ? { good: "Réseau stable", warn: "Dégradation modérée", critical: "Congestion critique" }[healthStatus(hs)] : "score QoS pondéré", null, "#34d399"),
      ].join("");

      // anneau de répartition
      const segs = CLASSES.map((c) => ({ label: CLASS_INFO[c].label, value: a[c].throughput, color: CLASS_INFO[c].color }));
      const total = segs.reduce((x, s) => x + s.value, 0);
      view.querySelector("#d-donut").innerHTML = donut(segs, { center: has ? fmtAuto(total) : "—", sub: "Mbit/s reçus" }) +
        `<div class="stack" style="gap:10px;min-width:150px">${CLASSES.map((c) => `
          <div><div class="row between small"><span class="row" style="gap:7px"><i class="swatch" style="background:${CLASS_INFO[c].color}"></i>${CLASS_INFO[c].label}</span>
          <b class="mono">${has ? fmtAuto(a[c].throughput) : "—"}</b></div>
          <div class="small dim">${has && total ? fmt((a[c].throughput / total) * 100, 0) + " % du trafic" : "—"} · ${CLASS_INFO[c].dscp}</div></div>`).join("")}</div>`;

      // tableau d'état
      view.querySelector("#d-table").innerHTML = `<thead><tr><th>Classe</th><th>DSCP</th><th class="r">Débit</th><th class="r">Latence</th><th class="r">Jitter</th><th class="r">Pertes</th><th>État</th></tr></thead><tbody>
        ${CLASSES.map((c) => {
          const g = a[c];
          const st = g.recv ? worst(["latency", "jitter", "loss"].map((m) => statusOf(th, c, m, g[m]))) : "idle";
          return `<tr><td><span class="row" style="gap:7px"><i class="swatch" style="background:${CLASS_INFO[c].color}"></i>${CLASS_INFO[c].label}</span></td>
            <td class="mono small">${CLASS_INFO[c].dscp}</td>
            <td class="r num">${g.recv ? fmtAuto(g.throughput) : "—"}</td><td class="r num">${g.recv ? fmtAuto(g.latency) : "—"}</td>
            <td class="r num">${g.recv ? fmtAuto(g.jitter) : "—"}</td><td class="r num">${g.recv || g.drops ? fmt(g.loss, 2) : "—"}</td>
            <td><span class="status-text st-${st}">${STATUS[st].label}</span></td></tr>`;
        }).join("")}</tbody>`;
    }

    function renderCharts() {
      const L = store.live;
      const t = L.t || 0;
      const W = L.windows.filter((w) => w.t >= t - VIEW_SECONDS);
      const x = W.map((w) => w.t);
      const xMin = Math.max(0, t - VIEW_SECONDS), xMax = Math.max(xMin + 10, t);
      const titles = { latency: "Latence par classe de trafic", jitter: "Jitter (gigue) par classe", loss: "Taux de perte par classe", mos: "MOS voix estimé (E-model)" };
      view.querySelector("#m-title").textContent = titles[metric];
      const unit = { latency: "ms", jitter: "ms", loss: "%", mos: "MOS" }[metric];
      let series, thresholds = [];
      if (metric === "mos") {
        series = [{ name: "MOS voix", color: CLASS_INFO.voice.color, values: W.map((w) => w.classes.voice.mos), area: true }];
        thresholds = [{ y: 4, label: "Bonne qualité ≥ 4,0", color: "#34d399", always: true }, { y: 3.6, label: "3,6", color: "#fb923c", always: true }];
      } else {
        series = CLASSES.map((c) => ({ name: CLASS_INFO[c].label, color: CLASS_INFO[c].color, values: W.map((w) => (w.classes[c].recv || w.classes[c].drops ? w.classes[c][metric] : null)) }));
        const [g] = th.voice[metric];
        thresholds = [{ y: g, label: `Seuil voix ${g} ${unit === "%" ? "%" : "ms"}`, color: "#fb923c" }];
      }
      view.querySelector("#m-thr").textContent = metric === "latency" ? "— seuil ITU-T G.114 : 150 ms" : "";
      Object.assign(cMain.o, { unit, tipUnit: unit, xMin, xMax, thresholds, yMax: metric === "mos" ? 5 : null, yMin: metric === "mos" ? 1 : 0 });
      cMain.set({ x, series });
      const cap = W.map((w) => w.capacity);
      Object.assign(cThr.o, { xMin, xMax });
      cThr.set({ x, series: [
        ...CLASSES.map((c) => ({ name: CLASS_INFO[c].label, color: CLASS_INFO[c].color, values: W.map((w) => w.classes[c].throughput) })),
        { name: "Capacité", color: "#e5ecf6", values: cap, dash: "5 5", width: 1.4, noStack: true },
      ] });
      Object.assign(cQueue.o, { xMin, xMax });
      cQueue.set({ x, series: CLASSES.map((c) => ({ name: CLASS_INFO[c].label, color: CLASS_INFO[c].color, values: W.map((w) => w.queue[c]) })) });
    }

    function renderAlerts() {
      const A = store.live.alerts;
      view.querySelector("#al-count").textContent = A.length ? `${A.length} événement${A.length > 1 ? "s" : ""}` : "";
      view.querySelector("#d-alerts").innerHTML = A.length ? A.slice(0, 40).map((a) => `
        <div class="alert st-${a.severity}"><span class="dot"></span><div><div class="a-title">${esc(a.title)}</div><div class="a-detail">${esc(a.detail)}</div></div><span class="a-time">${fmtTime(a.t)}</span></div>`).join("")
        : `<div class="empty-state small">${icon("bell")}<div>Aucune alerte. Les dépassements de seuils (latence, jitter, pertes, congestion) apparaîtront ici.</div></div>`;
    }

    const renderAll = () => { renderHead(); renderKpis(); renderCharts(); renderAlerts(); };
    renderAll();

    const offs = [
      on("tick", (m) => {
        renderKpis(); renderCharts();
        if (m.alerts.length) renderAlerts();
        topo.update(m.state, store.live.windows[store.live.windows.length - 1]);
        if (Math.random() < 0.2) renderHead();
      }),
      on("live-status", renderHead),
      on("live-reset", () => { setTopo(); topo.clearParticles(); renderAll(); }),
      on("live-patched", () => { setTopo(); renderHead(); }),
      on("config", () => { if (store.live.status === "idle") { setTopo(); renderHead(); } }),
    ];
    return () => { offs.forEach((f) => f()); cMain.destroy(); cThr.destroy(); cQueue.destroy(); topo.destroy(); };
  },
};
