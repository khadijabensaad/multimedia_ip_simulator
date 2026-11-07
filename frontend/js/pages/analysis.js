// 04 — Analyse QoS : latence, jitter, pertes, débit, MOS, causes de dégradation, Smart Advisor, balayages.

import { API } from "../api.js";
import { BarChart, LineChart, gauge } from "../charts.js";
import { on, setConfig, setResult, store } from "../store.js";
import {
  CLASSES, CLASS_INFO, SCHED_LABEL, STATUS, esc, fmt, fmtAuto, healthStatus, icon, mosStatus, pill, ring, toast, withLoading,
} from "../ui.js";

export function advisorHtml(adv, { applyButton = true } = {}) {
  if (!adv) return "";
  return `<div class="card">
    <div class="card-head"><div class="card-title">${icon("spark")}QoS Smart Advisor</div>${pill(adv.health.status, `Santé ${fmt(adv.health.score, 0)}/100`)}</div>
    <p class="muted" style="margin:-4px 0 12px">${esc(adv.headline)}</p>
    <div class="grid g-2" style="align-items:start">
      <div class="stack" style="gap:8px"><div class="small dim" style="text-transform:uppercase;letter-spacing:1.4px;font-weight:700">Diagnostic</div>
        ${adv.findings.map((f) => `<div class="finding st-${f.severity}"><span class="dot" style="margin-top:5px"></span><div><b>${esc(f.title)}</b><p>${esc(f.detail)}</p></div></div>`).join("")}</div>
      <div class="stack" style="gap:8px"><div class="small dim" style="text-transform:uppercase;letter-spacing:1.4px;font-weight:700">Recommandations</div>
        ${adv.recommendations.map((r, i) => `<div class="rec"><span class="r-num">${i + 1}</span><div><h4>${esc(r.title)}</h4><p>${esc(r.rationale)}</p>${r.impact ? `<div class="impact">↗ ${esc(r.impact)}</div>` : ""}</div>
          ${r.applicable ? `<span class="tag">${{ qos: "QoS", queue: "File", traffic: "Trafic", capacity: "Capacité", link: "Lien" }[r.category] || r.category}</span>` : ""}</div>`).join("")}
        ${applyButton && adv.recommendations.some((r) => r.applicable) ? `<button class="btn primary" data-advisor-apply>${icon("bolt")}Optimiser automatiquement et comparer</button>` : ""}
      </div>
    </div></div>`;
}

export default {
  title: "Analyse QoS",
  eyebrow: "QoS Analysis",
  mount(view) {
    const th = store.meta.thresholds;
    let tab = "latency";
    let charts = [];
    const destroyCharts = () => { charts.forEach((c) => c.destroy()); charts = []; };

    async function runAnalysis(btn) {
      await withLoading(btn, async () => {
        try {
          const r = await API.simulate(store.config);
          setResult({ ...r, source: "batch" });
        } catch (e) { toast(e.message, "critical"); }
      });
    }

    function render() {
      destroyCharts();
      const R = store.lastResult;
      if (!R) {
        view.innerHTML = `<div class="page-head"><div><div class="eyebrow">QoS Analysis</div><h1>Analyse détaillée de la QoS</h1>
          <p>Latence, jitter, pertes, débit, MOS et causes de la dégradation, par classe de trafic.</p></div></div>
          <div class="card"><div class="empty-state">${icon("analysis")}<h3>Aucun résultat à analyser</h3>
          <p>Simulez le scénario courant « ${esc(store.config.name)} » (${fmt(store.config.duration, 0)} s simulées) ou terminez une session temps réel.</p>
          <button class="btn primary" id="a-run">${icon("play")}Simuler et analyser</button></div></div>`;
        view.querySelector("#a-run").onclick = (e) => runAnalysis(e.currentTarget);
        return;
      }
      const S = R.summary, cfg = R.config;
      const hs = S.health;
      const sched = S.scheduler;
      view.innerHTML = `
        <div class="page-head">
          <div><div class="eyebrow">QoS Analysis</div><h1>${esc(cfg.name)}</h1>
            <p>${esc(cfg.description || "")} ${R.source === "live" ? "<span class='tag'>session temps réel</span>" : ""}</p></div>
          <div class="head-meta">
            <button class="btn" id="a-rerun">${icon("refresh")}Relancer sur le scénario courant</button>
            <a class="btn" href="#/optimization?run=1">${icon("compare")}Comparer sans / avec QoS</a>
            ${R.history_id ? `<a class="btn" href="${API.reportUrl(R.history_id, "pdf")}" target="_blank">${icon("download")}PDF</a>` : ""}
          </div>
        </div>

        <div class="card">
          <div class="row" style="gap:26px;align-items:center">
            ${ring(hs.score, { color: STATUS[hs.status].color, label: fmt(hs.score, 0), sub: "santé / 100" })}
            <div class="grow stack" style="gap:10px">
              <div class="row">${pill(hs.status, hs.label)}<span class="pill">${esc(SCHED_LABEL[sched])}</span>
                <span class="pill">${fmtAuto(S.offered.total_mbps)} Mbit/s offerts / ${fmtAuto(S.network.capacity_mbps)} Mbit/s</span></div>
              <div class="stats">
                <div class="stat"><span class="s-label">Durée simulée</span><span class="s-val">${fmt(S.elapsed, 0)}<small>s</small></span></div>
                <div class="stat"><span class="s-label">Paquets</span><span class="s-val">${(S.packets || S.all.sent).toLocaleString("fr-FR")}</span></div>
                <div class="stat"><span class="s-label">Utilisation moy.</span><span class="s-val">${fmt(S.network.utilization_avg * 100, 0)}<small>%</small></span></div>
                <div class="stat"><span class="s-label">File moy. / max</span><span class="s-val">${fmt(S.network.queue_avg, 0)}<small>/ ${S.network.queue_max} pkts</small></span></div>
                <div class="stat"><span class="s-label">Rejets buffer</span><span class="s-val">${S.network.drops.buffer.toLocaleString("fr-FR")}</span></div>
                <div class="stat"><span class="s-label">Pertes lien</span><span class="s-val">${S.network.drops.link.toLocaleString("fr-FR")}</span></div>
              </div>
            </div>
          </div>
        </div>

        <div class="grid g-3" id="a-classes"></div>

        <div class="card">
          <div class="tabs" id="a-tabs">${[["latency", "Latence"], ["jitter", "Jitter"], ["throughput", "Débit"], ["loss", "Pertes"], ["queue", "File d'attente"]].map(([k, l]) => `<button data-t="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}</div>
          <div id="a-chart"></div>
          <div class="legend" style="margin-top:8px" id="a-legend"></div>
        </div>

        <div class="grid g-2">
          <div class="card">
            <div class="card-head"><div class="card-title">${icon("layers")}Pourquoi la latence augmente ? Décomposition</div><span class="card-sub">ms par paquet, moyenne</span></div>
            <div id="a-break"></div>
            <div class="legend" style="margin-top:6px"><span><i style="background:#fb923c"></i>Attente en file</span><span><i style="background:#60a5fa"></i>Sérialisation</span><span><i style="background:#64748b"></i>Propagation + gigue</span></div>
            <p class="small muted" id="a-why" style="margin-bottom:0"></p>
          </div>
          <div class="card">
            <div class="card-head"><div class="card-title">${icon("analysis")}Distribution de la latence</div><span class="card-sub">% des paquets</span></div>
            <div id="a-hist"></div>
            <div class="table-wrap"><table class="tbl" id="a-pct"></table></div>
          </div>
        </div>

        <div id="a-advisor">${advisorHtml(R.advisor)}</div>

        <div class="card" id="a-sweep"></div>

        <details class="method">
          <summary>Méthodologie et formules</summary>
          <p><b>Latence one-way</b> — mesurée pour chaque paquet entre son émission et sa réception :</p><div class="formula">Latence = t_réception − t_émission = attente en file + sérialisation (taille × 8 / débit) + propagation + gigue</div>
          <p><b>Jitter</b> — gigue inter-arrivées lissée (RFC 3550, utilisée par RTCP), calculée par appel / session :</p><div class="formula">D(i−1,i) = (R_i − R_i−1) − (S_i − S_i−1)        J ← J + (|D| − J) / 16</div>
          <p><b>Débit</b> et <b>pertes</b> :</p><div class="formula">Débit = bits reçus / durée        Perte = paquets perdus / (reçus + perdus) × 100</div>
          <p><b>MOS estimé</b> — E-model ITU-T G.107 simplifié (Ie, Bpl : G.113). Le MOS est une estimation à partir des paramètres réseau simulés :</p>
          <div class="formula">d = latence + max(20, 2·jitter) + ptime + délai codec
Id = 0,024·d + 0,11·(d − 177,3)·H(d − 177,3)
Ie,eff = Ie + (95 − Ie) · Ppl / (Ppl + Bpl)
R = 93,2 − Id − Ie,eff        MOS = 1 + 0,035·R + 7·10⁻⁶·R·(R − 60)·(100 − R)</div>
          <p><b>Seuils</b> — voix et vidéo interactive : latence ≤ 150 ms (ITU-T G.114), jitter ≤ 30 ms, pertes ≤ 1 % ; data : latence ≤ 400 ms, pertes ≤ 2 %.</p>
          <p><b>Moteur</b> — simulation à événements discrets : chaque paquet est un événement daté (émission, mise en file, sérialisation, propagation, réception). Même graine aléatoire ⇒ résultats reproductibles, ce qui permet une comparaison équitable avec et sans QoS.</p>
        </details>`;

      view.querySelector("#a-rerun").onclick = (e) => runAnalysis(e.currentTarget);
      view.querySelector("#a-tabs").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; tab = b.dataset.t; view.querySelectorAll("#a-tabs button").forEach((x) => x.classList.toggle("on", x === b)); renderTab(); };
      bindAdvisor(view.querySelector("#a-advisor"), cfg);
      renderClasses(S);
      const main = new LineChart(view.querySelector("#a-chart"), { height: 280 });
      charts.push(main);
      const renderTab = () => {
        const T = R.timeline, x = T.map((w) => w.t);
        const legend = view.querySelector("#a-legend");
        const clsLegend = CLASSES.map((c) => `<span><i style="background:${CLASS_INFO[c].color}"></i>${CLASS_INFO[c].label}</span>`).join("");
        if (tab === "queue") {
          Object.assign(main.o, { stacked: true, unit: "pkts", tipUnit: "pkts", tipDigits: 0, thresholds: [] });
          main.set({ x, series: CLASSES.map((c) => ({ name: CLASS_INFO[c].label, color: CLASS_INFO[c].color, values: T.map((w) => w.queue[c]) })) });
          legend.innerHTML = clsLegend + `<span class="muted">occupation moyenne du buffer de R1 par fenêtre de 250 ms</span>`;
          return;
        }
        if (tab === "throughput") {
          Object.assign(main.o, { stacked: false, unit: "Mbit/s", tipUnit: "Mbit/s", tipDigits: 2, thresholds: [] });
          main.set({ x, series: [
            ...CLASSES.map((c) => ({ name: `${CLASS_INFO[c].label} reçu`, color: CLASS_INFO[c].color, values: T.map((w) => w.classes[c].throughput), area: true })),
            ...CLASSES.map((c) => ({ name: `${CLASS_INFO[c].label} offert`, color: CLASS_INFO[c].color, values: T.map((w) => w.classes[c].offered), dash: "3 4", width: 1.2 })),
            { name: "Capacité", color: "#e5ecf6", values: T.map((w) => w.capacity), dash: "6 5", width: 1.2 },
          ] });
          legend.innerHTML = clsLegend + `<span><i class="dash" style="color:#8494ad"></i>débit offert</span><span><i class="dash" style="color:#e5ecf6"></i>capacité</span>`;
          return;
        }
        const unit = tab === "loss" ? "%" : "ms";
        const thr = CLASSES.filter((c) => S.classes[c].recv).map((c) => ({ y: th[c][tab][0], label: `seuil ${CLASS_INFO[c].label.toLowerCase()} ${th[c][tab][0]} ${unit}`, color: CLASS_INFO[c].color }));
        const uniq = thr.filter((t, i) => thr.findIndex((u) => u.y === t.y) === i);
        Object.assign(main.o, { stacked: false, unit, tipUnit: unit, tipDigits: tab === "loss" ? 2 : 1, thresholds: uniq });
        main.set({ x, series: CLASSES.map((c) => ({ name: CLASS_INFO[c].label, color: CLASS_INFO[c].color, values: T.map((w) => (w.classes[c].recv || w.classes[c].drops ? w.classes[c][tab] : null)) })) });
        legend.innerHTML = clsLegend + `<span class="muted">pointillés : seuils de qualité</span>`;
      };
      renderTab();

      // Décomposition
      const bd = S.latency_breakdown;
      const active = CLASSES.filter((c) => S.classes[c].recv);
      const br = new BarChart(view.querySelector("#a-break"), { height: 210, stacked: true, unit: "ms", tipUnit: "ms", digits: 1 });
      br.set({ categories: active.map((c) => CLASS_INFO[c].label), series: [
        { name: "Attente en file", color: "#fb923c", values: active.map((c) => bd[c].queueing) },
        { name: "Sérialisation", color: "#60a5fa", values: active.map((c) => bd[c].transmission) },
        { name: "Propagation + gigue", color: "#64748b", values: active.map((c) => bd[c].propagation) },
      ] });
      charts.push(br);
      const why = [];
      for (const c of active) {
        const tot = bd[c].queueing + bd[c].transmission + bd[c].propagation;
        if (tot <= 0) continue;
        const qs = bd[c].queueing / tot;
        why.push(qs > 0.5
          ? `<b>${CLASS_INFO[c].label}</b> : ${fmt(qs * 100, 0)} % du délai est passé dans la file du routeur → congestion (le buffer se remplit plus vite qu'il ne se vide).`
          : `<b>${CLASS_INFO[c].label}</b> : le délai est dominé par la propagation (${fmtAuto(bd[c].propagation)} ms) — ${qs < 0.15 ? "pas de congestion significative" : "congestion modérée"}.`);
      }
      view.querySelector("#a-why").innerHTML = why.join("<br>");

      // Histogrammes
      const hist = new LineChart(view.querySelector("#a-hist"), { height: 190, unit: "%", tipUnit: "%", tipDigits: 1, xFormat: (v) => `${fmt(v, v < 10 ? 1 : 0)} ms` });
      const edges = S.histograms[active[0]]?.edges || [];
      const centers = edges.slice(0, -1).map((e, i) => +((e + edges[i + 1]) / 2).toFixed(3));
      hist.set({ x: centers, series: active.map((c) => ({ name: CLASS_INFO[c].label, color: CLASS_INFO[c].color, area: true, values: S.histograms[c].counts })) });
      charts.push(hist);
      view.querySelector("#a-pct").innerHTML = `<thead><tr><th>Classe</th><th class="r">min</th><th class="r">p50</th><th class="r">p95</th><th class="r">p99</th><th class="r">max</th></tr></thead><tbody>
        ${active.map((c) => { const g = S.classes[c]; return `<tr><td>${CLASS_INFO[c].label}</td>${["latency_min", "latency_p50", "latency_p95", "latency_p99", "latency_max"].map((k) => `<td class="r num">${fmtAuto(g[k])}</td>`).join("")}</tr>`; }).join("")}</tbody>`;

      renderSweep(cfg);
    }

    function renderClasses(S) {
      const el = view.querySelector("#a-classes");
      el.innerHTML = CLASSES.map((c) => {
        const g = S.classes[c];
        if (!g.recv && !g.sent) return `<div class="card class-card" style="--c:${CLASS_INFO[c].color}"><div class="c-head"><h3>${CLASS_INFO[c].long}</h3></div><p class="muted small">Aucun flux de cette classe dans le scénario.</p></div>`;
        const line = (m, label, unit) => {
          const st = g.status[m];
          const [good] = th[c][m];
          return `<div class="row between small" style="padding:5px 0;border-bottom:1px solid var(--line)"><span>${label} <span class="dim">≤ ${good} ${unit}</span></span>
            <span class="row" style="gap:8px"><b class="mono">${m === "loss" ? fmt(g[m], 2) : fmtAuto(g[m])} ${unit}</b><span class="status-text st-${st}">${st === "good" ? "✓" : st === "warn" ? "!" : "✗"}</span></span></div>`;
        };
        let extra = "";
        if (c === "voice" && S.voice_quality) {
          const v = S.voice_quality;
          extra = `<div style="margin-top:12px">${gauge(v.mos, { min: 1, max: 5, width: 230, label: "MOS estimé (E-model)", sub: v.label, stops: [{ to: 3.1, color: "#f87171" }, { to: 3.6, color: "#fb923c" }, { to: 4, color: "#facc15" }, { to: 5, color: "#34d399" }] })}
            <div class="center small muted">R-factor ${fmt(v.r_factor, 1)} · ${v.calls} appels</div></div>`;
        } else if (c === "video" && S.video_quality) {
          const v = S.video_quality;
          const st = v.frame_integrity >= 98 ? "good" : v.frame_integrity >= 90 ? "warn" : "critical";
          extra = `<div style="margin-top:14px"><div class="row between small"><span>Images intactes</span><b class="mono status-text st-${st}">${fmt(v.frame_integrity, 1)} %</b></div>
            <div class="meter" style="margin:6px 0"><span style="width:${v.frame_integrity}%;background:var(--st)" class="st-${st}"></span></div>
            <div class="small muted">${v.damaged.toLocaleString("fr-FR")} images sur ${v.frames.toLocaleString("fr-FR")} ont perdu au moins un paquet (dont ${v.i_frames_damaged} images I).</div></div>`;
        } else if (c === "data" && S.data_quality) {
          const d = S.data_quality;
          extra = `<div class="stats" style="margin-top:14px"><div class="stat"><span class="s-label">Goodput</span><span class="s-val">${fmtAuto(d.goodput_mbps)}<small>Mbit/s</small></span></div>
            ${d.tcp_flows ? `<div class="stat"><span class="s-label">Retransm. TCP</span><span class="s-val">${d.retransmissions.toLocaleString("fr-FR")}</span></div>
            <div class="stat"><span class="s-label">Réductions cwnd</span><span class="s-val">${d.cwnd_reductions.toLocaleString("fr-FR")}</span></div>` : `<div class="stat"><span class="s-label">Transport</span><span class="s-val" style="font-size:14px">UDP<small>non réactif</small></span></div>`}</div>
            ${d.tcp_flows ? `<p class="small muted" style="margin:8px 0 0">TCP réduit sa fenêtre à chaque perte : il s'adapte à la capacité restante.</p>` : ""}`;
        }
        return `<div class="card class-card" style="--c:${CLASS_INFO[c].color}">
          <div class="c-head"><h3>${CLASS_INFO[c].long}</h3><span class="tag">${CLASS_INFO[c].dscp}</span><span style="margin-left:auto">${pill(g.overall, STATUS[g.overall].label)}</span></div>
          <div class="stats" style="margin-bottom:10px">
            <div class="stat"><span class="s-label">Débit reçu</span><span class="s-val">${fmtAuto(g.throughput)}<small>/ ${fmtAuto(g.offered)} Mb/s</small></span></div>
            <div class="stat"><span class="s-label">Lat. p95</span><span class="s-val">${fmtAuto(g.latency_p95)}<small>ms</small></span></div>
            <div class="stat"><span class="s-label">Lat. max</span><span class="s-val">${fmtAuto(g.latency_max)}<small>ms</small></span></div>
          </div>
          ${line("latency", "Latence moyenne", "ms")}${line("jitter", "Jitter", "ms")}${line("loss", "Pertes", "%")}
          <div class="small dim" style="margin-top:6px">Pertes : ${g.drops_detail.buffer} buffer · ${g.drops_detail.link} lien${g.drops_detail.policer ? ` · ${g.drops_detail.policer} policer` : ""}</div>
          ${extra}</div>`;
      }).join("");
    }

    function bindAdvisor(root, cfg) {
      const b = root.querySelector("[data-advisor-apply]");
      if (!b) return;
      b.onclick = () => withLoading(b, async () => {
        try {
          store.lastOptimize = await API.optimize(cfg);
          location.hash = "#/optimization?view=optimize";
        } catch (e) { toast(e.message, "critical"); }
      });
    }

    // ------------------------------------------------------------------ balayage de paramètres
    function renderSweep(cfg) {
      const el = view.querySelector("#a-sweep");
      const preset = store.presets.find((p) => p.id === cfg.preset);
      const def = preset?.sweep || { param: "loss_pct", values: [0, 1, 5, 10] };
      const sw = store.lastSweep;
      el.innerHTML = `<div class="card-head"><div class="card-title">${icon("compare")}Balayage de paramètre — impact sur la QoS</div><span class="card-sub">chaque point = 2 simulations (sans / avec QoS)</span></div>
        <div class="row" style="margin-bottom:12px">
          <select class="select" id="s-param">${Object.entries(store.meta.sweep_params).map(([k, l]) => `<option value="${k}" ${k === (sw?.param || def.param) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
          <input class="input" id="s-values" style="width:200px" value="${(sw?.values || def.values).join(", ")}" title="valeurs séparées par des virgules">
          <button class="btn primary" id="s-run">${icon("play")}Lancer le balayage</button>
          <span class="small muted">Scénarios 3 (flux vidéo), 6 (pertes) et 7 (latence) du laboratoire.</span>
        </div>
        <div class="grid g-2" id="s-charts">${sw ? "" : `<div class="empty-state span-2 small">${icon("analysis")}<div>Choisissez un paramètre et des valeurs (ex. pertes 0, 1, 5, 10 %) puis lancez le balayage.</div></div>`}</div>`;
      const defaults = { video_count: "1, 5, 10, 20", loss_pct: "0, 1, 5, 10", base_latency_ms: "10, 50, 100, 200", bandwidth_mbps: "5, 10, 20, 50", buffer_pkts: "25, 50, 100, 300", voice_calls: "5, 20, 50, 100" };
      el.querySelector("#s-param").onchange = (e) => (el.querySelector("#s-values").value = defaults[e.target.value] || "");
      el.querySelector("#s-run").onclick = (e) => withLoading(e.currentTarget, async () => {
        const values = el.querySelector("#s-values").value.split(/[,;\s]+/).filter(Boolean).map(Number).filter((v) => !Number.isNaN(v));
        if (!values.length) return toast("Indiquez au moins une valeur.", "warn");
        try {
          store.lastSweep = await API.sweep(cfg, el.querySelector("#s-param").value, values);
          renderSweep(cfg);
        } catch (err) { toast(err.message, "critical"); }
      });
      if (!sw) return;
      const box = el.querySelector("#s-charts");
      const specs = [
        ["Latence voix", "ms", (d) => d.voice.latency], ["MOS voix estimé", "MOS", (d) => d.mos],
        ["Pertes vidéo", "%", (d) => d.video.loss], ["Débit data (goodput)", "Mbit/s", (d) => d.data.throughput],
      ];
      box.innerHTML = specs.map((s, i) => `<div><div class="small" style="font-weight:600;margin-bottom:4px">${s[0]}</div><div id="sw-${i}"></div></div>`).join("") +
        `<div class="legend span-2">${sw.modes.map((m, i) => `<span><i ${i === 0 ? 'class="dash"' : ""} style="background:${i === 0 ? "#94a3b8" : "#22d3ee"};color:#94a3b8"></i>${esc(sw.mode_labels[m])}</span>`).join("")}<span class="muted">Axe horizontal : ${esc(sw.label)}</span></div>`;
      specs.forEach((s, i) => {
        const ch = new LineChart(box.querySelector(`#sw-${i}`), { height: 170, unit: s[1], tipUnit: s[1], tipDigits: 2, xFormat: (v) => fmt(v, Number.isInteger(v) ? 0 : 1), yMin: s[1] === "MOS" ? 1 : 0, yMax: s[1] === "MOS" ? 5 : null });
        ch.set({ x: sw.points.map((p) => p.value), series: sw.modes.map((m, k) => ({ name: sw.mode_labels[m], color: k === 0 ? "#94a3b8" : "#22d3ee", dash: k === 0 ? "5 4" : null, width: 2.2, dots: true, values: sw.points.map((p) => s[2](p.modes[m])) })) });
        charts.push(ch);
      });
    }

    render();
    const off = on("result", render);
    return () => { off(); destroyCharts(); };
  },
};
