// 06 — Rapports : historique des simulations, aperçu, export PDF / CSV / JSON.

import { API } from "../api.js";
import { setResult, store } from "../store.js";
import { CLASSES, CLASS_INFO, STATUS, download, esc, fmt, fmtAuto, fmtDate, healthStatus, icon, pill, ring, toast } from "../ui.js";

const KIND = {
  simulation: ["Simulation", "analysis"], live: ["Temps réel", "dashboard"], comparison: ["Comparaison QoS", "compare"],
  optimization: ["Optimisation", "optimize"], sweep: ["Balayage", "builder"],
};

export default {
  title: "Rapports",
  eyebrow: "Reports",
  mount(view) {
    let runs = [];
    let current = null;

    view.innerHTML = `
      <div class="page-head">
        <div><div class="eyebrow">Reports</div><h1>Rapports et historique des simulations</h1>
          <p>Chaque simulation, comparaison, optimisation ou session temps réel est enregistrée. Exportez-la en PDF (rapport mis en page) ou en CSV (séries temporelles pour Excel).</p></div>
        <div class="head-meta">
          <button class="btn" id="r-refresh">${icon("refresh")}Rafraîchir</button>
          <button class="btn" id="r-json">${icon("download")}Résultat courant (JSON)</button>
        </div>
      </div>
      <div class="grid g-main">
        <div class="card"><div class="card-head"><div class="card-title">${icon("reports")}Historique</div><span class="card-sub" id="r-count"></span></div>
          <div class="table-wrap"><table class="tbl" id="r-table"></table></div></div>
        <div class="card" id="r-preview"><div class="empty-state">${icon("eye")}<div>Sélectionnez un enregistrement pour afficher son aperçu.</div></div></div>
      </div>`;

    async function load() {
      try {
        runs = (await API.history()).runs;
      } catch (e) { toast(e.message, "critical"); runs = []; }
      renderTable();
    }

    function renderTable() {
      view.querySelector("#r-count").textContent = `${runs.length} enregistrement${runs.length > 1 ? "s" : ""}`;
      view.querySelector("#r-table").innerHTML = runs.length ? `<thead><tr><th>Date</th><th>Scénario</th><th>Type</th><th>Politique</th><th class="r">Santé</th><th class="r">Exports</th></tr></thead><tbody>
        ${runs.map((r) => `<tr data-id="${r.id}" style="cursor:pointer;${current?.id === r.id ? "background:rgba(34,211,238,.06)" : ""}">
          <td class="mono small">${fmtDate(r.created)}</td><td><b>${esc(r.name)}</b></td>
          <td><span class="tag">${icon(KIND[r.kind]?.[1] || "file")}${KIND[r.kind]?.[0] || r.kind}</span></td>
          <td class="mono small">${esc(r.scheduler || "")}</td>
          <td class="r">${r.health != null ? `<span class="status-text st-${healthStatus(r.health)} mono">${fmt(r.health, 0)}</span>` : "—"}</td>
          <td class="r"><div class="row" style="gap:4px;justify-content:flex-end;flex-wrap:nowrap">
            <a class="btn sm" href="${API.reportUrl(r.id, "pdf")}" target="_blank" title="Rapport PDF" data-stop>PDF</a>
            <a class="btn sm" href="${API.reportUrl(r.id, "csv")}" title="Données CSV" data-stop>CSV</a>
            <button class="btn sm ghost icon" data-del="${r.id}" title="Supprimer" data-stop>${icon("trash")}</button></div></td></tr>`).join("")}</tbody>`
        : `<tbody><tr><td><div class="empty-state">${icon("reports")}<h3>Aucun enregistrement</h3><p>Lancez une simulation depuis le Dashboard, le Scenario Builder ou l'Optimisation.</p></div></td></tr></tbody>`;
      view.querySelectorAll("#r-table tr[data-id]").forEach((tr) => tr.addEventListener("click", (e) => { if (!e.target.closest("[data-stop]")) open(tr.dataset.id); }));
      view.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
        await API.historyDelete(b.dataset.del);
        if (current?.id === b.dataset.del) { current = null; view.querySelector("#r-preview").innerHTML = ""; }
        load();
      }));
    }

    async function open(id) {
      try { current = await API.historyGet(id); } catch (e) { return toast(e.message, "critical"); }
      renderTable();
      renderPreview();
    }

    function classTable(S) {
      return `<table class="tbl"><thead><tr><th>Classe</th><th class="r">Latence</th><th class="r">Jitter</th><th class="r">Pertes</th><th class="r">Débit</th></tr></thead><tbody>
        ${CLASSES.filter((c) => S.classes[c].recv).map((c) => { const g = S.classes[c]; return `<tr><td><span class="row" style="gap:7px"><i class="swatch" style="background:${CLASS_INFO[c].color}"></i>${CLASS_INFO[c].label}</span></td>
          <td class="r num status-text st-${g.status.latency}">${fmtAuto(g.latency)} ms</td><td class="r num status-text st-${g.status.jitter}">${fmtAuto(g.jitter)} ms</td>
          <td class="r num status-text st-${g.status.loss}">${fmt(g.loss, 2)} %</td><td class="r num">${fmtAuto(g.throughput)}</td></tr>`; }).join("")}</tbody></table>`;
    }

    function renderPreview() {
      const el = view.querySelector("#r-preview");
      const it = current;
      const P = it.payload;
      let body = "", openLabel = "", openFn = null;
      if (it.kind === "simulation" || it.kind === "live") {
        const S = P.summary;
        body = `<div class="row" style="gap:16px;margin-bottom:12px">${ring(S.health.score, { size: 92, color: STATUS[S.health.status].color, label: fmt(S.health.score, 0), sub: "santé" })}
          <div class="stack" style="gap:6px">${pill(S.health.status, S.health.label)}<span class="small muted">${fmt(S.elapsed, 0)} s simulées · ${S.scheduler.toUpperCase()} · ${fmtAuto(S.offered.total_mbps)} / ${fmtAuto(S.network.capacity_mbps)} Mbit/s</span>
          ${S.voice_quality ? `<span class="small">MOS voix estimé <b class="mono">${fmt(S.voice_quality.mos, 2)}</b> (${esc(S.voice_quality.label)})</span>` : ""}</div></div>${classTable(S)}`;
        openLabel = "Ouvrir dans Analyse QoS";
        openFn = () => { setResult({ ...P, history_id: it.id, source: it.kind === "live" ? "live" : "batch" }); location.hash = "#/analysis"; };
      } else if (it.kind === "comparison") {
        body = `<div class="stack" style="gap:12px">${P.runs.map((r) => `<div><div class="row between" style="margin-bottom:6px"><b>${esc(r.label)}</b>${pill(r.summary.health.status, `${fmt(r.summary.health.score, 0)}/100`)}</div>${classTable(r.summary)}</div>`).join("")}</div>`;
        openLabel = "Ouvrir dans Optimisation";
        openFn = () => { store.lastCompare = P; location.hash = "#/optimization"; };
      } else if (it.kind === "optimization") {
        const b = P.before.summary, a = P.after.summary;
        body = `<div class="row" style="gap:12px;margin-bottom:12px;justify-content:center">${ring(b.health.score, { size: 88, color: STATUS[b.health.status].color, label: fmt(b.health.score, 0), sub: "avant" })}<span class="dim" style="font-size:20px">→</span>${ring(a.health.score, { size: 88, color: STATUS[a.health.status].color, label: fmt(a.health.score, 0), sub: "après" })}</div>
          <div class="small muted" style="margin-bottom:8px">Recommandations appliquées : ${P.applied.map((r) => esc(r.title)).join(" · ") || "aucune"}</div>${classTable(a)}`;
        openLabel = "Ouvrir dans Optimisation";
        openFn = () => { store.lastOptimize = P; location.hash = "#/optimization?view=optimize"; };
      } else if (it.kind === "sweep") {
        body = `<div class="small muted" style="margin-bottom:8px">Balayage : ${esc(P.label)}</div><table class="tbl"><thead><tr><th>Valeur</th>${P.modes.map((m) => `<th class="r">MOS ${m.toUpperCase()}</th><th class="r">Lat. voix ${m.toUpperCase()}</th>`).join("")}</tr></thead><tbody>
          ${P.points.map((p) => `<tr><td class="mono">${p.value}</td>${P.modes.map((m) => `<td class="r num">${fmt(p.modes[m].mos, 2)}</td><td class="r num">${fmtAuto(p.modes[m].voice.latency)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
        openLabel = "Ouvrir dans Analyse QoS";
        openFn = () => { store.lastSweep = P; location.hash = "#/analysis"; };
      }
      el.innerHTML = `<div class="card-head"><div class="card-title">${icon("eye")}${esc(it.name)}</div><span class="tag">${KIND[it.kind]?.[0] || it.kind}</span></div>
        <div class="small dim" style="margin:-6px 0 12px">${fmtDate(it.created)} · #${it.id}</div>
        <div class="table-wrap">${body}</div>
        <div class="row" style="margin-top:14px">
          ${openFn ? `<button class="btn primary" id="r-open">${icon("eye")}${openLabel}</button>` : ""}
          <a class="btn" href="${API.reportUrl(it.id, "pdf")}" target="_blank">${icon("download")}PDF</a>
          <a class="btn" href="${API.reportUrl(it.id, "csv")}">${icon("download")}CSV</a></div>`;
      el.querySelector("#r-open")?.addEventListener("click", openFn);
    }

    view.querySelector("#r-refresh").onclick = load;
    view.querySelector("#r-json").onclick = () => {
      const data = store.lastResult || store.lastCompare || store.lastOptimize;
      if (!data) return toast("Aucun résultat courant à exporter.", "warn");
      download(`qoslab-resultat-${Date.now()}.json`, JSON.stringify(data, null, 2));
    };
    load();
    return () => {};
  },
};
