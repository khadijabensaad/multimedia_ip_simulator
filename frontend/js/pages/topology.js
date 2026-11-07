// 02 — Topologie réseau : visualisation interactive des sources, routeurs, files et récepteurs.

import { aggregate } from "../metrics.js";
import { flowRate, newFlow } from "../model.js";
import { clone, on, setConfig, store } from "../store.js";
import { Topology } from "../topology.js";
import {
  CLASSES, CLASS_INFO, SCHED_LABEL, SCHED_SHORT, STATUS, classIcon, esc, fmt, fmtAuto, icon, setRangeFill, statusOf, toast, worst,
} from "../ui.js";

export default {
  title: "Topologie réseau",
  eyebrow: "Network Topology",
  mount(view) {
    const th = store.meta.thresholds;
    let selected = { kind: "router", id: null };
    view.innerHTML = `
      <div class="page-head">
        <div><div class="eyebrow">Network Topology</div><h1>Topologie réseau interactive</h1>
          <p>Cliquez sur un équipement pour afficher ses statistiques et modifier ses paramètres — les changements s'appliquent à chaud pendant la simulation. Les liens congestionnés passent à l'orange puis au rouge, les paquets perdus tombent en rouge.</p></div>
        <div class="head-meta">
          <button class="btn" data-add="voice">${icon("plus")}Client VoIP</button>
          <button class="btn" data-add="video">${icon("plus")}Serveur vidéo</button>
          <button class="btn" data-add="data">${icon("plus")}Hôte data</button>
        </div>
      </div>
      <div class="card"><div id="t-topo"></div></div>
      <div class="grid g-main-r" style="align-items:start">
        <div class="card" id="t-panel"></div>
        <div class="card">
          <div class="card-head"><div class="card-title">${icon("layers")}Flux du scénario</div><span class="card-sub">statistiques cumulées de la session en cours</span></div>
          <div class="table-wrap"><table class="tbl" id="t-flows"></table></div>
        </div>
      </div>`;

    const cfgNow = () => (store.live.status !== "idle" && store.live.config) || store.config;
    const topo = new Topology(view.querySelector("#t-topo"), { onSelect: (s) => { selected = s; renderPanel(); } });
    const draw = () => { topo.setConfig(cfgNow(), store.live.state?.scheduler); topo.select(selected); };
    draw();
    if (store.live.status === "idle") {
      const ov = document.createElement("div");
      ov.className = "topo-empty";
      ov.innerHTML = `<span>Démarrez la simulation (bouton en haut à droite) pour animer le trafic</span>`;
      view.querySelector("#t-topo").appendChild(ov);
    }

    const mutate = (fn) => {
      const cfg = clone(store.config);
      fn(cfg);
      setConfig(cfg);
    };

    view.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => {
      mutate((cfg) => {
        const f = newFlow(b.dataset.add, cfg);
        cfg.flows.push(f);
        selected = { kind: "flow", id: f.id };
      });
      toast(`${CLASS_INFO[b.dataset.add].label} : nouveau flux ajouté${store.live.status !== "idle" ? " (appliqué en direct)" : ""}.`, "good", 2200);
    }));

    const live = () => store.live.state;
    const lastAgg = () => aggregate(store.live.windows.slice(-4));

    const slider = (key, label, min, max, step, value, unit) => `
      <div class="field"><div class="field-head"><label>${label}</label><span class="val" data-val="${key}">${fmt(value, step < 1 ? 1 : 0)} ${unit}</span></div>
      <input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${value}"></div>`;

    function renderPanel() {
      const cfg = store.config;
      const st = live();
      const panel = view.querySelector("#t-panel");
      const a = lastAgg();
      let html = "";
      if (selected.kind === "router" || selected.kind === "switch" || selected.kind === "core" || selected.kind === "group") {
        const sched = cfg.qos.enabled ? cfg.qos.scheduler : "fifo";
        const q = st?.queue || { voice: 0, video: 0, data: 0 };
        const lim = st?.queue_limits || {};
        const drops = st?.drops || { buffer: 0, link: 0, policer: 0 };
        html = `<div class="card-head"><div class="card-title">${icon("router")}Routeur R1 — goulot d'étranglement</div><span class="tag">${SCHED_SHORT[sched]}</span></div>
          <p class="small muted" style="margin-top:-4px">${esc(SCHED_LABEL[sched])}. Tous les flux traversent ce routeur avant le lien WAN.</p>
          <div class="stats" style="margin:12px 0">
            <div class="stat"><span class="s-label">Capacité</span><span class="s-val">${fmtAuto(cfg.network.bandwidth_mbps)}<small>Mbit/s</small></span></div>
            <div class="stat"><span class="s-label">Utilisation</span><span class="s-val">${a.utilization == null ? "—" : fmt(a.utilization * 100, 0)}<small>%</small></span></div>
            <div class="stat"><span class="s-label">Buffer</span><span class="s-val">${cfg.network.buffer_pkts}<small>pkts</small></span></div>
          </div>
          <div class="stack" style="gap:8px;margin-bottom:12px">${CLASSES.map((c) => {
            const L = lim[c] || lim.total || cfg.network.buffer_pkts;
            return `<div><div class="row between small"><span>${CLASS_INFO[c].label} <span class="dim">· ${CLASS_INFO[c].queue}</span></span><span class="mono">${q[c] || 0} / ${L}</span></div>
              <div class="meter"><span style="width:${Math.min(100, ((q[c] || 0) / L) * 100)}%;background:${CLASS_INFO[c].color}"></span></div></div>`;
          }).join("")}</div>
          <div class="row small muted" style="gap:14px;margin-bottom:12px"><span>Rejets buffer <b class="mono" style="color:var(--crit)">${drops.buffer}</b></span><span>Policer <b class="mono">${drops.policer}</b></span><span>Lien <b class="mono">${drops.link}</b></span></div>
          <hr class="hr">
          <div class="field" style="margin-bottom:12px"><div class="field-head"><label>Politique de file d'attente</label></div>
            <div class="seg" id="p-sched">${["fifo", "priority", "wfq", "llq"].map((s) => `<button data-s="${s}" class="${s === sched ? "on" : ""}">${SCHED_SHORT[s]}</button>`).join("")}</div></div>
          ${slider("bandwidth_mbps", "Bande passante du lien", 1, 200, 1, cfg.network.bandwidth_mbps, "Mbit/s")}
          <div style="height:10px"></div>
          ${slider("buffer_pkts", "Taille du buffer", 10, 1000, 10, cfg.network.buffer_pkts, "pkts")}`;
      } else if (selected.kind === "wan") {
        html = `<div class="card-head"><div class="card-title">${icon("cloud")}Lien WAN</div></div>
          <p class="small muted" style="margin-top:-4px">Propagation, gigue et pertes aléatoires du lien (indépendantes de la congestion).</p>
          <div class="stack" style="gap:14px;margin-top:10px">
          ${slider("base_latency_ms", "Latence de base (one-way)", 0, 300, 5, cfg.network.base_latency_ms, "ms")}
          ${slider("jitter_ms", "Gigue du lien", 0, 40, 1, cfg.network.jitter_ms, "ms")}
          ${slider("loss_pct", "Pertes aléatoires", 0, 15, 0.5, cfg.network.loss_pct, "%")}
          <div class="field"><div class="field-head"><label>Modèle de pertes</label></div>
            <div class="seg" id="p-lossm"><button data-l="random" class="${cfg.network.loss_model !== "burst" ? "on" : ""}">Aléatoire</button><button data-l="burst" class="${cfg.network.loss_model === "burst" ? "on" : ""}">Rafales (Gilbert-Elliott)</button></div></div>
          </div>`;
      } else if (selected.kind === "rcv") {
        const c = selected.id;
        const g = a[c];
        html = `<div class="card-head"><div class="card-title">${classIcon(c)}Récepteurs ${CLASS_INFO[c].label.toLowerCase()}</div><span class="tag cls-${c}">${CLASS_INFO[c].dscp}</span></div>
          <div class="stats">${[["Débit", fmtAuto(g.throughput), "Mbit/s"], ["Latence", fmtAuto(g.latency), "ms"], ["Jitter", fmtAuto(g.jitter), "ms"], ["Pertes", fmt(g.loss, 2), "%"]]
            .map(([l, v, u]) => `<div class="stat"><span class="s-label">${l}</span><span class="s-val">${v}<small>${u}</small></span></div>`).join("")}</div>
          ${c === "voice" && g.mos != null ? `<p class="small" style="margin-top:12px">MOS estimé : <b class="mono">${fmt(g.mos, 2)}</b></p>` : ""}
          <p class="small muted" style="margin-top:12px">Moyenne glissante sur la dernière seconde simulée.</p>`;
      } else if (selected.kind === "flow") {
        const f = cfg.flows.find((x) => x.id === selected.id);
        if (!f) { selected = { kind: "router" }; return renderPanel(); }
        const s = st?.flows?.find((x) => x.id === f.id) || {};
        const stat = s.recv ? worst(["latency", "jitter", "loss"].map((m) => statusOf(th, f.type, m, s[m]))) : "idle";
        const params = f.type === "voice"
          ? `${slider("calls", "Appels simultanés", 1, 100, 1, f.calls, "appels")}
             <div class="field"><div class="field-head"><label>Codec</label></div><select class="select" data-fk="codec">${Object.entries(store.meta.codecs).map(([k, c]) => `<option value="${k}" ${k === f.codec ? "selected" : ""}>${esc(c.label)} — ${c.ip_kbps} kbit/s IP</option>`).join("")}</select></div>`
          : `${slider("rate_mbps", "Débit", 0.5, f.type === "video" ? 25 : 50, 0.5, f.rate_mbps, "Mbit/s")}
             ${f.type === "data" ? `<div class="field"><div class="field-head"><label>Protocole</label></div><div class="seg" id="p-proto"><button data-p="tcp" class="${f.protocol !== "udp" ? "on" : ""}">TCP (réactif)</button><button data-p="udp" class="${f.protocol === "udp" ? "on" : ""}">UDP (constant)</button></div></div>` : ""}`;
        html = `<div class="card-head"><div class="card-title">${classIcon(f.type)}${esc(f.name)}</div><span class="status-text st-${stat}">${STATUS[stat].label}</span></div>
          <div class="row small muted" style="margin-top:-6px;margin-bottom:12px">${CLASS_INFO[f.type].long} · ${CLASS_INFO[f.type].proto} · DSCP ${CLASS_INFO[f.type].dscp} · <b class="mono">${fmtAuto(flowRate(f))} Mbit/s</b></div>
          <div class="stats" style="margin-bottom:12px">${[["Envoyés", s.sent ?? "—", ""], ["Reçus", s.recv ?? "—", ""], ["Latence", fmtAuto(s.latency), "ms"], ["Jitter", fmtAuto(s.jitter), "ms"], ["Pertes", s.loss == null ? "—" : fmt(s.loss, 2), "%"], ...(s.cwnd != null ? [["cwnd TCP", fmt(s.cwnd, 0), "pkts"]] : [])]
            .map(([l, v, u]) => `<div class="stat"><span class="s-label">${l}</span><span class="s-val">${typeof v === "number" ? v.toLocaleString("fr-FR") : v}<small>${u}</small></span></div>`).join("")}</div>
          <div class="stack" style="gap:12px">${params}</div>
          <div class="row" style="margin-top:14px">
            <label class="switch"><input type="checkbox" id="p-en" ${f.enabled !== false ? "checked" : ""}><span class="track"></span>Flux actif</label>
            <button class="btn sm danger" id="p-del" style="margin-left:auto">${icon("trash")}Supprimer</button></div>`;
      }
      panel.innerHTML = html;
      panel.querySelectorAll("input[type=range]").forEach((r) => {
        setRangeFill(r);
        r.addEventListener("input", () => {
          setRangeFill(r);
          const lab = panel.querySelector(`[data-val="${r.dataset.k}"]`);
          if (lab) lab.textContent = lab.textContent.replace(/^[\d\s,.]+/, fmt(+r.value, +r.step < 1 ? 1 : 0) + " ");
        });
        r.addEventListener("change", () => {
          const k = r.dataset.k, v = +r.value;
          mutate((cfg) => {
            if (selected.kind === "flow") {
              const f = cfg.flows.find((x) => x.id === selected.id);
              if (f) { f[k] = v; if (k === "rate_mbps") f.profile = "custom"; }
            } else cfg.network[k] = v;
          });
        });
      });
      panel.querySelector("#p-sched")?.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-s]");
        if (!b) return;
        mutate((cfg) => { if (b.dataset.s === "fifo") cfg.qos.enabled = false; else { cfg.qos.enabled = true; cfg.qos.scheduler = b.dataset.s; } });
      });
      panel.querySelector("#p-lossm")?.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-l]");
        if (b) mutate((cfg) => (cfg.network.loss_model = b.dataset.l));
      });
      panel.querySelector("#p-proto")?.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-p]");
        if (b) mutate((cfg) => (cfg.flows.find((x) => x.id === selected.id).protocol = b.dataset.p));
      });
      panel.querySelector("[data-fk=codec]")?.addEventListener("change", (e) => mutate((cfg) => (cfg.flows.find((x) => x.id === selected.id).codec = e.target.value)));
      panel.querySelector("#p-en")?.addEventListener("change", (e) => mutate((cfg) => (cfg.flows.find((x) => x.id === selected.id).enabled = e.target.checked)));
      panel.querySelector("#p-del")?.addEventListener("click", () => {
        mutate((cfg) => (cfg.flows = cfg.flows.filter((x) => x.id !== selected.id)));
        selected = { kind: "router" };
        renderPanel();
      });
    }

    function renderFlows() {
      const cfg = store.config;
      const st = live();
      view.querySelector("#t-flows").innerHTML = `<thead><tr><th>Flux</th><th>Classe</th><th class="r">Débit offert</th><th class="r">Envoyés</th><th class="r">Reçus</th><th class="r">Latence</th><th class="r">Jitter</th><th class="r">Pertes</th><th>État</th><th></th></tr></thead><tbody>
        ${cfg.flows.map((f) => {
          const s = st?.flows?.find((x) => x.id === f.id) || {};
          const stat = s.recv ? worst(["latency", "jitter", "loss"].map((m) => statusOf(th, f.type, m, s[m]))) : "idle";
          return `<tr style="${f.enabled === false ? "opacity:.5" : ""}"><td><b>${esc(f.name)}</b></td><td><span class="tag cls-${f.type}">${CLASS_INFO[f.type].label}</span></td>
            <td class="r num">${fmtAuto(flowRate(f))} Mbit/s</td><td class="r num">${s.sent?.toLocaleString("fr-FR") ?? "—"}</td><td class="r num">${s.recv?.toLocaleString("fr-FR") ?? "—"}</td>
            <td class="r num">${fmtAuto(s.latency)}</td><td class="r num">${fmtAuto(s.jitter)}</td><td class="r num">${s.loss == null ? "—" : fmt(s.loss, 2) + " %"}</td>
            <td><span class="status-text st-${stat}">${STATUS[stat].label}</span></td>
            <td class="r"><button class="btn sm ghost" data-sel="${esc(f.id)}">${icon("eye")}</button></td></tr>`;
        }).join("")}</tbody>`;
      view.querySelectorAll("[data-sel]").forEach((b) => (b.onclick = () => { selected = { kind: "flow", id: b.dataset.sel }; topo.select(selected); renderPanel(); window.scrollTo({ top: 0, behavior: "smooth" }); }));
    }

    renderPanel();
    renderFlows();
    let n = 0;
    const offs = [
      on("tick", (m) => {
        topo.update(m.state, store.live.windows[store.live.windows.length - 1]);
        view.querySelector(".topo-empty")?.remove();
        if (++n % 3 === 0) {
          const active = document.activeElement;
          if (!(active && view.querySelector("#t-panel").contains(active) && active.matches("input,select"))) renderPanel();
          renderFlows();
        }
      }),
      on("config", () => { if (store.live.status === "idle") draw(); renderPanel(); renderFlows(); }),
      on("live-patched", () => draw()),
      on("live-reset", () => { draw(); topo.clearParticles(); }),
    ];
    return () => { offs.forEach((f) => f()); topo.destroy(); };
  },
};
