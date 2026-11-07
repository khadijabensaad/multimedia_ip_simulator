// 05 — Optimisation QoS : comparaison avant / après priorisation des flux + optimisation automatique.

import { API } from "../api.js";
import { BarChart, LineChart } from "../charts.js";
import { clone, liveStart, setConfig, store } from "../store.js";
import {
  CLASSES, CLASS_INFO, SCHED_LABEL, SCHED_SHORT, STATUS, deltaHtml, esc, fmt, fmtAuto, healthStatus, icon, mosStatus, pill, ring, toast, withLoading,
} from "../ui.js";
import { advisorHtml } from "./analysis.js";

const neg = (v) => (v == null ? v : -v);
const RUN_COLOR = { fifo: "#94a3b8", priority: "#facc15", wfq: "#60a5fa", llq: "#22d3ee" };

export default {
  title: "Optimisation QoS",
  eyebrow: "QoS Optimization",
  mount(view) {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    let selected = ["fifo", store.config.qos.scheduler || "llq"];
    let charts = [];
    let tab = "voice-latency";
    const destroy = () => { charts.forEach((c) => c.destroy()); charts = []; };

    view.innerHTML = `
      <div class="page-head">
        <div><div class="eyebrow">QoS Optimization</div><h1>Avant / après priorisation des flux</h1>
          <p>Le même scénario est rejoué avec la même graine aléatoire (trafic identique) sous plusieurs politiques de file d'attente : l'écart mesuré est uniquement dû à la QoS.</p></div>
      </div>
      <div class="grid g-main">
        <div class="card">
          <div class="card-head"><div class="card-title">${icon("compare")}Politiques à comparer</div><span class="card-sub" id="o-scn"></span></div>
          <div class="row" id="o-sched" style="margin-bottom:14px">
            ${["fifo", "priority", "wfq", "llq"].map((s) => `<label class="pill" style="cursor:pointer;--st:${RUN_COLOR[s]}"><input type="checkbox" value="${s}" style="accent-color:${RUN_COLOR[s]}" ${selected.includes(s) ? "checked" : ""}> ${esc(SCHED_LABEL[s])}</label>`).join("")}
          </div>
          <div class="row">
            <button class="btn primary" id="o-run">${icon("play")}Lancer la comparaison</button>
            <button class="btn" id="o-auto">${icon("spark")}Optimiser automatiquement (Smart Advisor)</button>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">${icon("layers")}Politique de priorité (LLQ)</div></div>
          <table class="tbl"><thead><tr><th>Trafic</th><th>Priorité</th><th>File</th></tr></thead><tbody>
            ${CLASSES.map((c) => `<tr><td><span class="row" style="gap:7px"><i class="swatch" style="background:${CLASS_INFO[c].color}"></i>${CLASS_INFO[c].label} <span class="dim mono small">${CLASS_INFO[c].dscp}</span></span></td><td>${CLASS_INFO[c].prio} — ${["Haute", "Moyenne", "Basse"][CLASS_INFO[c].prio - 1]}</td><td>${CLASS_INFO[c].queue}</td></tr>`).join("")}
          </tbody></table>
        </div>
      </div>
      <div id="o-opt"></div>
      <div id="o-results"></div>`;

    view.querySelector("#o-scn").textContent = store.config.name;
    view.querySelector("#o-sched").addEventListener("change", () => {
      selected = [...view.querySelectorAll("#o-sched input:checked")].map((i) => i.value);
    });
    const run = (btn) => withLoading(btn, async () => {
      const order = ["fifo", "priority", "wfq", "llq"].filter((s) => selected.includes(s));
      if (order.length < 2) return toast("Sélectionnez au moins deux politiques à comparer.", "warn");
      try {
        store.lastCompare = await API.compare(store.config, order);
        renderResults();
      } catch (e) { toast(e.message, "critical"); }
    });
    const auto = (btn) => withLoading(btn, async () => {
      try {
        store.lastOptimize = await API.optimize(store.config);
        renderOptimize();
        view.querySelector("#o-opt").scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) { toast(e.message, "critical"); }
    });
    view.querySelector("#o-run").onclick = (e) => run(e.currentTarget);
    view.querySelector("#o-auto").onclick = (e) => auto(e.currentTarget);

    // ------------------------------------------------------------------ comparaison
    function renderResults() {
      destroy();
      const C = store.lastCompare;
      const el = view.querySelector("#o-results");
      if (!C) {
        el.innerHTML = `<div class="card"><div class="empty-state">${icon("compare")}<h3>Aucune comparaison</h3><p>Lancez la comparaison pour mesurer l'effet de la QoS sur « ${esc(store.config.name)} ».</p></div></div>`;
        if (store.lastOptimize) renderOptimize();
        return;
      }
      const runs = C.runs, first = runs[0], last = runs[runs.length - 1];
      const imp = C.improvement;
      const vb = first.summary, va = last.summary;
      const big = (label, unit, b, a, change, higherIsBetter = false, digits = 1) => `
        <div class="stat" style="gap:6px"><span class="s-label">${label}</span>
          <div class="row" style="gap:10px;align-items:baseline"><span class="mono muted" style="font-size:15px;text-decoration:line-through;text-decoration-color:#56657f">${b == null ? "—" : fmt(b, digits)}</span>
          <span>→</span><span class="s-val" style="font-size:24px">${a == null ? "—" : fmt(a, digits)}<small>${unit}</small></span></div>${deltaHtml(change, { higherIsBetter })}</div>`;
      const voiceImp = imp.voice || {};
      el.innerHTML = `
        <div class="card glow">
          <div class="card-head"><div class="card-title">${icon("phone")}Protection de la voix : ${esc(first.label)} → ${esc(last.label)}</div><span class="card-sub">${esc(C.config.name)} · ${fmtAuto(C.offered.total_mbps)} Mbit/s offerts pour ${fmtAuto(C.config.network.bandwidth_mbps)} Mbit/s</span></div>
          <div class="row" style="gap:28px;align-items:center">
            <div class="row" style="gap:14px">
              ${ring(vb.health.score, { size: 96, color: STATUS[vb.health.status].color, label: fmt(vb.health.score, 0), sub: SCHED_SHORT[first.scheduler] })}
              <span style="font-size:22px;color:var(--dim)">→</span>
              ${ring(va.health.score, { size: 96, color: STATUS[va.health.status].color, label: fmt(va.health.score, 0), sub: SCHED_SHORT[last.scheduler] })}
            </div>
            <div class="grow stats" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
              ${big("Latence voix", "ms", vb.classes.voice.latency, va.classes.voice.latency, neg(voiceImp.latency?.improvement))}
              ${big("Jitter voix", "ms", vb.classes.voice.jitter, va.classes.voice.jitter, neg(voiceImp.jitter?.improvement))}
              ${big("Pertes voix", "%", vb.classes.voice.loss, va.classes.voice.loss, neg(voiceImp.loss?.improvement), false, 2)}
              ${big("MOS estimé", "/5", vb.voice_quality?.mos, va.voice_quality?.mos, imp.mos ? (imp.mos.delta / (imp.mos.before || 1)) * 100 : null, true, 2)}
            </div>
          </div>
          <p class="small muted" style="margin:12px 0 0">${conclusion(C)}</p>
        </div>
        <div class="grid g-2" id="o-bars"></div>
        <div class="card">
          <div class="tabs" id="o-tabs">${[["voice-latency", "Latence voix"], ["voice-jitter", "Jitter voix"], ["video-loss", "Pertes vidéo"], ["video-latency", "Latence vidéo"], ["data-throughput", "Débit data"], ["queue", "File d'attente"]]
            .map(([k, l]) => `<button data-t="${k}" class="${k === tab ? "on" : ""}">${l}</button>`).join("")}</div>
          <div id="o-time"></div>
          <div class="legend" style="margin-top:8px">${runs.map((r) => `<span><i style="background:${RUN_COLOR[r.scheduler]}"></i>${esc(r.label)}</span>`).join("")}</div>
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">${icon("analysis")}Tableau des gains</div><span class="card-sub">${esc(first.label)} → ${esc(last.label)}</span></div>
          <div class="table-wrap"><table class="tbl"><thead><tr><th>Classe</th><th>Indicateur</th>${runs.map((r) => `<th class="r">${esc(SCHED_SHORT[r.scheduler])}</th>`).join("")}<th class="r">Évolution</th></tr></thead><tbody>
            ${CLASSES.filter((c) => imp[c]).map((c) => [["latency", "Latence moy. (ms)"], ["latency_p95", "Latence p95 (ms)"], ["jitter", "Jitter (ms)"], ["loss", "Pertes (%)"], ["throughput", "Débit (Mbit/s)"]].map(([m, l], i) => `
              <tr><td>${i === 0 ? `<span class="tag cls-${c}">${CLASS_INFO[c].label}</span>` : ""}</td><td>${l}</td>
              ${runs.map((r) => `<td class="r num">${m === "loss" ? fmt(r.summary.classes[c][m], 2) : fmtAuto(r.summary.classes[c][m])}</td>`).join("")}
              <td class="r">${m === "throughput" ? deltaHtml(imp[c][m]?.improvement, { higherIsBetter: true }) : deltaHtml(neg(imp[c][m]?.improvement))}</td></tr>`).join("")).join("")}
            ${imp.mos ? `<tr><td><span class="tag cls-voice">Voix</span></td><td>MOS estimé</td>${runs.map((r) => `<td class="r num">${fmt(r.summary.voice_quality?.mos, 2)}</td>`).join("")}<td class="r"><span class="delta ${imp.mos.delta > 0.05 ? "up" : imp.mos.delta < -0.05 ? "down" : "flat"}">${imp.mos.delta > 0 ? "+" : ""}${fmt(imp.mos.delta, 2)}</span></td></tr>` : ""}
          </tbody></table></div>
        </div>
        ${advisorHtml(C.advisor_after && C.runs.length > 1 ? C.advisor_after : C.advisor)}`;

      // barres groupées
      const bars = el.querySelector("#o-bars");
      const metrics = [["latency", "Latence moyenne", "ms"], ["jitter", "Jitter", "ms"], ["loss", "Taux de perte", "%"], ["throughput", "Débit reçu", "Mbit/s"]];
      bars.innerHTML = metrics.map((m, i) => `<div class="card"><div class="card-head"><div class="card-title">${m[1]}</div><span class="card-sub">${m[2]}</span></div><div id="ob-${i}"></div></div>`).join("");
      const active = CLASSES.filter((c) => imp[c]);
      metrics.forEach((m, i) => {
        const ch = new BarChart(bars.querySelector(`#ob-${i}`), { height: 200, unit: m[2], tipUnit: m[2], digits: m[0] === "loss" ? 2 : 1 });
        ch.set({ categories: active.map((c) => CLASS_INFO[c].label), series: runs.map((r) => ({ name: r.label, color: RUN_COLOR[r.scheduler], values: active.map((c) => r.summary.classes[c][m[0]] ?? 0) })) });
        charts.push(ch);
      });

      const time = new LineChart(el.querySelector("#o-time"), { height: 250 });
      charts.push(time);
      const renderTime = () => {
        const x = first.timeline.map((w) => w.t);
        let series, unit;
        if (tab === "queue") {
          unit = "pkts";
          series = runs.map((r) => ({ name: r.label, color: RUN_COLOR[r.scheduler], values: r.timeline.map((w) => w.queue.avg) }));
        } else {
          const [c, m] = tab.split("-");
          unit = m === "loss" ? "%" : m === "throughput" ? "Mbit/s" : "ms";
          series = runs.map((r) => ({ name: r.label, color: RUN_COLOR[r.scheduler], values: r.timeline.map((w) => (w.classes[c].recv || w.classes[c].drops ? w.classes[c][m] : null)) }));
        }
        const thresholds = tab === "voice-latency" ? [{ y: 150, label: "150 ms (G.114)", color: "#fb923c" }] : tab === "voice-jitter" ? [{ y: 30, label: "30 ms", color: "#fb923c" }] : [];
        Object.assign(time.o, { unit, tipUnit: unit, tipDigits: 1, thresholds });
        time.set({ x, series });
      };
      el.querySelector("#o-tabs").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; tab = b.dataset.t; el.querySelectorAll("#o-tabs button").forEach((x) => x.classList.toggle("on", x === b)); renderTime(); };
      renderTime();
      const ab = el.querySelector("[data-advisor-apply]");
      if (ab) ab.onclick = () => auto(ab);
    }

    function conclusion(C) {
      const f = C.runs[0].summary, l = C.runs[C.runs.length - 1].summary;
      const v0 = f.classes.voice, v1 = l.classes.voice;
      const parts = [];
      if (v0.recv && v1.recv) {
        parts.push(`Avec ${SCHED_SHORT[C.runs[C.runs.length - 1].scheduler]}, la latence voix passe de ${fmtAuto(v0.latency)} à ${fmtAuto(v1.latency)} ms et les pertes voix de ${fmt(v0.loss, 2)} % à ${fmt(v1.loss, 2)} %.`);
      }
      const vid0 = f.classes.video, vid1 = l.classes.video, d0 = f.classes.data, d1 = l.classes.data;
      if (d1.recv && d1.latency > d0.latency * 1.2) parts.push(`En contrepartie, le trafic data (best effort) attend davantage (${fmtAuto(d0.latency)} → ${fmtAuto(d1.latency)} ms) : la QoS redistribue la capacité, elle ne la crée pas.`);
      if (l.offered.utilization > 1) parts.push(`Le lien reste surchargé (${fmt(l.offered.utilization * 100, 0)} % de la capacité demandée) : pour aussi protéger la vidéo il faut réduire le débit vidéo ou augmenter la bande passante.`);
      if (vid0.recv && vid1.loss < vid0.loss * 0.8) parts.push(`Les pertes vidéo diminuent également (${fmt(vid0.loss, 1)} → ${fmt(vid1.loss, 1)} %).`);
      return parts.join(" ");
    }

    // ------------------------------------------------------------------ optimisation automatique
    function renderOptimize() {
      const O = store.lastOptimize;
      const el = view.querySelector("#o-opt");
      if (!O) { el.innerHTML = ""; return; }
      const b = O.before.summary, a = O.after.summary;
      const changes = diffConfig(O.before.config, O.after.config);
      el.innerHTML = `<div class="card glow">
        <div class="card-head"><div class="card-title">${icon("spark")}Optimisation automatique — Smart Advisor</div><span class="card-sub">${esc(O.before.config.name)}</span></div>
        <div class="grid g-main-r" style="align-items:center">
          <div class="row" style="gap:14px;justify-content:center">
            ${ring(b.health.score, { size: 104, color: STATUS[b.health.status].color, label: fmt(b.health.score, 0), sub: "avant" })}
            <span style="font-size:24px;color:var(--dim)">→</span>
            ${ring(a.health.score, { size: 104, color: STATUS[a.health.status].color, label: fmt(a.health.score, 0), sub: "après" })}
          </div>
          <div class="stack" style="gap:12px">
            ${O.stages.length ? `<div class="stepper">${O.stages.map((s, i) => `<div class="step ${s.kept === false ? "skip" : "kept"}"><div class="s-n">ÉTAPE ${i + 1}</div><div class="s-t">${esc(s.label)}</div>
              <div class="small"><span class="mono">${fmt(s.health, 0)}/100</span>${s.mos ? ` · MOS ${fmt(s.mos, 2)}` : ""} ${s.kept === false ? '<span class="dim">— écartée</span>' : '<span class="status-text st-good">✓</span>'}</div></div>`).join("")}</div>`
              : `<div class="finding st-good"><span class="dot" style="margin-top:5px"></span><div><b>Aucune optimisation nécessaire</b><p>Le scénario respecte déjà les objectifs de QoS.</p></div></div>`}
            <div class="stats">
              ${[["Latence voix", b.classes.voice.latency, a.classes.voice.latency, "ms"], ["Pertes voix", b.classes.voice.loss, a.classes.voice.loss, "%"], ["Pertes vidéo", b.classes.video.loss, a.classes.video.loss, "%"], ["MOS", b.voice_quality?.mos, a.voice_quality?.mos, ""]]
                .map(([l, x, y, u]) => `<div class="stat"><span class="s-label">${l}</span><span class="s-val">${y == null ? "—" : fmt(y, u === "%" || !u ? 2 : 1)}<small>${u}</small></span><span class="small dim">avant ${x == null ? "—" : fmt(x, u === "%" || !u ? 2 : 1)}</span></div>`).join("")}
            </div>
          </div>
        </div>
        ${O.applied.length ? `<div class="hr"></div><div class="grid g-2"><div><div class="small dim" style="text-transform:uppercase;letter-spacing:1.4px;font-weight:700;margin-bottom:8px">Recommandations appliquées</div>
          <div class="stack" style="gap:8px">${O.applied.map((r, i) => `<div class="rec"><span class="r-num">${i + 1}</span><div><h4>${esc(r.title)}</h4><p>${esc(r.rationale)}</p></div><span></span></div>`).join("")}</div></div>
          <div><div class="small dim" style="text-transform:uppercase;letter-spacing:1.4px;font-weight:700;margin-bottom:8px">Modifications de configuration</div>
          <table class="tbl"><tbody>${changes.map((c) => `<tr><td>${esc(c.label)}</td><td class="r mono small muted">${esc(c.from)}</td><td>→</td><td class="mono small">${esc(c.to)}</td></tr>`).join("")}</tbody></table>
          <div class="row" style="margin-top:12px"><button class="btn primary" id="o-load">${icon("save")}Utiliser la configuration optimisée</button><button class="btn" id="o-live">${icon("play")}La lancer en temps réel</button></div></div></div>` : ""}
      </div>`;
      el.querySelector("#o-load")?.addEventListener("click", () => { setConfig(clone(O.optimized_config)); toast("Configuration optimisée chargée comme scénario courant.", "good"); });
      el.querySelector("#o-live")?.addEventListener("click", () => { setConfig(clone(O.optimized_config)); liveStart(O.optimized_config); location.hash = "#/dashboard"; });
    }

    function diffConfig(a, b) {
      const out = [];
      const labels = { bandwidth_mbps: ["Bande passante", "Mbit/s"], buffer_pkts: ["Buffer", "pkts"], base_latency_ms: ["Latence de base", "ms"], loss_pct: ["Pertes du lien", "%"], jitter_ms: ["Gigue", "ms"] };
      for (const [k, [l, u]] of Object.entries(labels)) if (a.network[k] !== b.network[k]) out.push({ label: l, from: `${a.network[k]} ${u}`, to: `${b.network[k]} ${u}` });
      const qa = a.qos.enabled ? SCHED_SHORT[a.qos.scheduler] : "FIFO", qb = b.qos.enabled ? SCHED_SHORT[b.qos.scheduler] : "FIFO";
      if (qa !== qb) out.push({ label: "Ordonnanceur", from: qa, to: qb });
      if (a.qos.priority_cap_pct !== b.qos.priority_cap_pct) out.push({ label: "Plafond prioritaire", from: `${a.qos.priority_cap_pct} %`, to: `${b.qos.priority_cap_pct} %` });
      for (const fb of b.flows) {
        const fa = a.flows.find((f) => f.id === fb.id);
        if (!fa) continue;
        if (fa.rate_mbps !== fb.rate_mbps && fb.type !== "voice") out.push({ label: fb.name, from: `${fmtAuto(fa.rate_mbps)} Mbit/s`, to: `${fmtAuto(fb.rate_mbps)} Mbit/s` });
        if (fa.codec !== fb.codec) out.push({ label: fb.name, from: fa.codec, to: fb.codec });
      }
      return out;
    }

    renderOptimize();
    renderResults();
    if (params.get("run") === "1") {
      history.replaceState(null, "", "#/optimization");
      run(view.querySelector("#o-run"));
    } else if (params.get("view") === "optimize") {
      history.replaceState(null, "", "#/optimization");
    }
    return destroy;
  },
};
