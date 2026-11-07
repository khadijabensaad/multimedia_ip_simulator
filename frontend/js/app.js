// Point d'entrée : navigation, barre supérieure (contrôles temps réel), état latéral.

import { boot, emit, liveSpeed, liveStart, livePause, liveResume, liveStop, on, setConfig, store } from "./store.js";
import { SCHED_SHORT, esc, fmtTime, icon, toast } from "./ui.js";
import dashboard from "./pages/dashboard.js";
import topology from "./pages/topology.js";
import builder from "./pages/builder.js";
import analysis from "./pages/analysis.js";
import optimization from "./pages/optimization.js";
import reports from "./pages/reports.js";

const PAGES = [
  { id: "dashboard", n: "01", label: "Dashboard", icon: "dashboard", page: dashboard },
  { id: "topology", n: "02", label: "Topologie réseau", icon: "topology", page: topology },
  { id: "builder", n: "03", label: "Scenario Builder", icon: "builder", page: builder },
  { id: "analysis", n: "04", label: "Analyse QoS", icon: "analysis", page: analysis },
  { id: "optimization", n: "05", label: "Optimisation QoS", icon: "optimize", page: optimization },
  { id: "reports", n: "06", label: "Rapports", icon: "reports", page: reports },
];

let cleanup = null;

function renderNav(active) {
  document.getElementById("nav").innerHTML = PAGES.map((p) =>
    `<a href="#/${p.id}" class="${p.id === active ? "active" : ""}"><span class="idx">${p.n}</span>${icon(p.icon)}<span>${p.label}</span></a>`).join("");
}

function route() {
  const id = (location.hash.replace(/^#\/?/, "").split("?")[0]) || "dashboard";
  const entry = PAGES.find((p) => p.id === id) || PAGES[0];
  renderNav(entry.id);
  document.getElementById("crumb-eyebrow").textContent = entry.page.eyebrow || "QoS Lab";
  document.getElementById("crumb-title").textContent = entry.page.title || entry.label;
  document.getElementById("sidebar").classList.remove("open");
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } }
  const view = document.getElementById("view");
  view.innerHTML = "";
  window.scrollTo(0, 0);
  try {
    cleanup = entry.page.mount(view) || null;
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="card"><div class="empty-state">${icon("info")}<h3>Erreur d'affichage</h3><p>${esc(e.message)}</p></div></div>`;
  }
}

function renderControls() {
  const L = store.live;
  const el = document.getElementById("live-controls");
  const cfg = store.config;
  const qosOn = cfg?.qos?.enabled;
  const status = L.status;
  const main = status === "idle"
    ? `<button class="btn primary" data-act="start">${icon("play")}Démarrer</button>`
    : status === "connecting"
      ? `<button class="btn primary loading" disabled>Connexion</button>`
      : `${status === "running"
        ? `<button class="btn" data-act="pause" title="Pause">${icon("pause")}Pause</button>`
        : `<button class="btn primary" data-act="resume">${icon("play")}Reprendre</button>`}
         <button class="btn danger" data-act="stop" title="Arrêter et analyser">${icon("stop")}Arrêter</button>`;
  el.innerHTML = `
    <span class="tag" title="Scénario courant" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(cfg?.name || "—")}</span>
    <label class="switch" title="Activer / désactiver la QoS (appliqué à chaud pendant la simulation)">
      <input type="checkbox" data-act="qos" ${qosOn ? "checked" : ""}><span class="track"></span>QoS ${qosOn ? SCHED_SHORT[cfg.qos.scheduler] : "OFF"}
    </label>
    <div class="seg" title="Vitesse de simulation">${[1, 2, 4, 8].map((s) => `<button data-speed="${s}" class="${L.speed === s ? "on" : ""}">${s}×</button>`).join("")}</div>
    ${main}`;
}

function renderSideStatus() {
  const L = store.live;
  const st = { idle: ["idle", "Arrêtée"], connecting: ["warn", "Connexion…"], running: ["good", "En cours"], paused: ["warn", "En pause"] }[L.status];
  document.getElementById("side-status").innerHTML = `
    <div class="row"><span>Simulation</span><b><span class="dot st-${st[0]} ${L.status === "running" ? "pulse" : ""}"></span> ${st[1]}</b></div>
    <div class="row"><span>Temps simulé</span><b class="mono">${fmtTime(L.t || 0)}</b></div>
    <div class="row"><span>Paquets</span><b class="mono">${(L.state?.packets ?? 0).toLocaleString("fr-FR")}</b></div>
    <div class="row"><span>Canal</span><b>${L.mode === "ws" ? "WebSocket" : L.mode === "rest" ? "REST" : "—"}</b></div>
    <div class="row"><span>Backend</span><b>${store.backend.ok ? `v${store.backend.version}` : "hors ligne"}</b></div>`;
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act],[data-speed]");
  if (!t || !t.closest("#live-controls")) return;
  if (t.dataset.speed) return liveSpeed(+t.dataset.speed);
  const act = t.dataset.act;
  if (act === "start") liveStart(store.config);
  else if (act === "pause") livePause();
  else if (act === "resume") liveResume();
  else if (act === "stop") liveStop();
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset?.act === "qos" && t.closest("#live-controls")) {
    const cfg = JSON.parse(JSON.stringify(store.config));
    cfg.qos.enabled = t.checked;
    setConfig(cfg);
    toast(t.checked ? `QoS activée (${SCHED_SHORT[cfg.qos.scheduler]}) — la voix passe en file prioritaire.` : "QoS désactivée — file unique FIFO.", t.checked ? "good" : "warn", 2600);
  }
});
document.getElementById("menu-btn").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));

on("live-status", () => { renderControls(); renderSideStatus(); });
on("config", renderControls);
on("tick", renderSideStatus);
window.addEventListener("hashchange", route);

(async function init() {
  renderNav("dashboard");
  renderSideStatus();
  try {
    await boot();
  } catch (e) {
    document.getElementById("view").innerHTML = `<div class="card"><div class="empty-state">${icon("info")}
      <h3>Backend injoignable</h3><p>Démarrez le serveur : <span class="kbd">python run.py</span> puis rechargez la page.</p>
      <p class="small dim">${esc(e.message)}</p></div></div>`;
    return;
  }
  renderControls();
  renderSideStatus();
  route();
  emit("ready");
})();
