// 03 — Scenario Builder : scénarios prédéfinis + éditeur complet avec aperçu interactif.

import { API } from "../api.js";
import { flowRate, newFlow, offered } from "../model.js";
import {
  clone, customScenarios, deleteCustomScenario, liveStart, on, presetConfig, saveCustomScenario, setConfig, setResult, store,
} from "../store.js";
import {
  CLASSES, CLASS_INFO, SCHED_LABEL, classIcon, debounce, download, esc, fmt, fmtAuto, icon, setRangeFill, toast, withLoading,
} from "../ui.js";

export default {
  title: "Scenario Builder",
  eyebrow: "Création de scénarios",
  mount(view) {
    let cfg = clone(store.config);
    const meta = store.meta;

    view.innerHTML = `
      <div class="page-head">
        <div><div class="eyebrow">Scenario Builder</div><h1>Créer et configurer un scénario</h1>
          <p>Partez d'un des 8 scénarios du laboratoire ou construisez le vôtre : flux, débits, bande passante, latence, buffer et politique QoS.</p></div>
        <div class="head-meta">
          <button class="btn" id="b-import">${icon("upload")}Importer JSON</button>
          <button class="btn" id="b-export">${icon("download")}Exporter JSON</button>
          <input type="file" id="b-file" accept="application/json" class="hide">
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">${icon("layers")}Scénarios du laboratoire</div><span class="card-sub">cliquez pour charger dans l'éditeur</span></div>
        <div class="preset-grid" id="b-presets"></div>
        <div id="b-custom"></div>
      </div>
      <div class="grid g-builder">
        <div class="stack" id="b-editor"></div>
        <div class="stack" style="position:sticky;top:78px" id="b-preview"></div>
      </div>`;

    // ------------------------------------------------------------------ presets
    function renderPresets() {
      view.querySelector("#b-presets").innerHTML = store.presets.map((p) => `
        <button class="preset ${cfg.preset === p.id ? "on" : ""}" data-preset="${p.id}">
          <span class="row between"><span class="p-num">SCÉNARIO ${String(p.number).padStart(2, "0")}</span><span class="tag">${esc(p.level)}</span></span>
          <span class="p-name">${esc(p.name)}</span><span class="p-obj">${esc(p.objective)}</span></button>`).join("");
      const custom = customScenarios();
      view.querySelector("#b-custom").innerHTML = custom.length ? `<div class="hr"></div><div class="small muted" style="margin-bottom:8px">Mes scénarios enregistrés</div>
        <div class="row">${custom.map((c, i) => `<span class="tag" style="padding:4px 4px 4px 10px;gap:8px"><a href="#" data-custom="${i}">${esc(c.name)}</a>
          <button class="btn sm ghost icon" data-delcustom="${i}" title="Supprimer" style="height:20px;width:20px">${icon("x")}</button></span>`).join("")}</div>` : "";
      view.querySelectorAll("[data-preset]").forEach((b) => (b.onclick = () => load(presetConfig(b.dataset.preset))));
      view.querySelectorAll("[data-custom]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); load(clone(custom[+a.dataset.custom])); }));
      view.querySelectorAll("[data-delcustom]").forEach((b) => (b.onclick = () => { deleteCustomScenario(custom[+b.dataset.delcustom].name); renderPresets(); }));
    }

    function load(c) {
      cfg = clone(c);
      commit(true);
      renderAll();
      toast(`Scénario « ${esc(cfg.name)} » chargé.`, "info", 2000);
    }

    const commit = (immediate = false) => {
      if (immediate) setConfig(cfg);
      else commitLater();
    };
    const commitLater = debounce(() => setConfig(cfg), 350);

    // ------------------------------------------------------------------ éditeur
    const slider = (path, label, min, max, step, value, unit, hint = "") => `
      <div class="field">
        <div class="field-head"><label>${label}</label>
          <span class="row" style="gap:6px"><input class="input sm num" data-num="${path}" type="number" min="${min}" max="${max}" step="${step}" value="${value}"><span class="small muted" style="min-width:42px">${unit}</span></span></div>
        <input type="range" data-path="${path}" min="${min}" max="${max}" step="${step}" value="${Math.min(max, value)}">
        ${hint ? `<span class="hint">${hint}</span>` : ""}
      </div>`;

    function flowParams(f, i) {
      if (f.type === "voice") {
        return `<select class="select sm" data-f="${i}" data-key="codec">${Object.entries(meta.codecs).map(([k, c]) => `<option value="${k}" ${k === f.codec ? "selected" : ""}>${k} · ${c.ip_kbps} kbit/s</option>`).join("")}</select>
          <span class="row" style="gap:6px"><input class="input sm num" type="number" min="1" max="500" step="1" data-f="${i}" data-key="calls" value="${f.calls}"><span class="small muted">appels</span></span>`;
      }
      if (f.type === "video") {
        return `<select class="select sm" data-f="${i}" data-key="profile"><option value="custom">Débit libre</option>${Object.entries(meta.video_profiles).map(([k, v]) => `<option value="${k}" ${k === f.profile ? "selected" : ""}>${k} · ${v} Mbit/s</option>`).join("")}</select>
          <span class="row" style="gap:6px"><input class="input sm num" type="number" min="0.1" max="100" step="0.5" data-f="${i}" data-key="rate_mbps" value="${f.rate_mbps}"><span class="small muted">Mbit/s</span></span>
          <select class="select sm" data-f="${i}" data-key="fps">${[24, 25, 30, 50, 60].map((v) => `<option value="${v}" ${+f.fps === v ? "selected" : ""}>${v} i/s</option>`).join("")}</select>`;
      }
      return `<div class="seg"><button data-f="${i}" data-proto="tcp" class="${f.protocol !== "udp" ? "on" : ""}">TCP</button><button data-f="${i}" data-proto="udp" class="${f.protocol === "udp" ? "on" : ""}">UDP</button></div>
        <span class="row" style="gap:6px"><input class="input sm num" type="number" min="0.1" max="1000" step="0.5" data-f="${i}" data-key="rate_mbps" value="${f.rate_mbps}"><span class="small muted">Mbit/s</span></span>`;
    }

    function renderEditor() {
      const n = cfg.network, q = cfg.qos;
      const schedOpts = ["priority", "wfq", "llq"];
      view.querySelector("#b-editor").innerHTML = `
        <div class="card">
          <div class="card-head"><div class="card-title">${icon("file")}Identité du scénario</div></div>
          <div class="grid g-2">
            <div class="field"><div class="field-head"><label>Nom</label></div><input class="input" id="e-name" value="${esc(cfg.name)}" maxlength="80"></div>
            <div class="grid g-2">
              <div class="field"><div class="field-head"><label>Durée simulée</label></div><span class="row" style="gap:6px"><input class="input num" style="width:100%" type="number" id="e-dur" min="2" max="120" value="${cfg.duration}"><span class="small muted">s</span></span></div>
              <div class="field"><div class="field-head"><label>Graine aléatoire</label></div><input class="input num" style="width:100%" type="number" id="e-seed" value="${cfg.seed}"></div>
            </div>
          </div>
          <div class="field" style="margin-top:12px"><div class="field-head"><label>Description / objectif</label></div><input class="input" id="e-desc" value="${esc(cfg.description || "")}" maxlength="240" placeholder="Que cherche-t-on à démontrer ?"></div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">${icon("cloud")}Réseau</div><span class="card-sub">lien goulot d'étranglement + WAN</span></div>
          <div class="grid g-2">
            ${slider("network.bandwidth_mbps", "Bande passante", 1, 200, 1, n.bandwidth_mbps, "Mbit/s", "capacité du lien entre R1 et le WAN")}
            ${slider("network.base_latency_ms", "Latence de base", 0, 300, 1, n.base_latency_ms, "ms", "propagation one-way (fibre locale ≈ 5 ms, satellite ≈ 270 ms)")}
            ${slider("network.jitter_ms", "Gigue du lien", 0, 40, 0.5, n.jitter_ms, "ms", "variation aléatoire du délai (Wi-Fi, radio…)")}
            ${slider("network.loss_pct", "Perte de paquets", 0, 15, 0.1, n.loss_pct, "%", "pertes aléatoires du lien, hors congestion")}
            ${slider("network.buffer_pkts", "Taille du buffer", 10, 1000, 5, n.buffer_pkts, "pkts", "file d'attente du routeur R1 (tail-drop)")}
            <div class="field"><div class="field-head"><label>Modèle de pertes</label></div>
              <div class="seg" id="e-lossm"><button data-l="random" class="${n.loss_model !== "burst" ? "on" : ""}">Aléatoire (Bernoulli)</button><button data-l="burst" class="${n.loss_model === "burst" ? "on" : ""}">Rafales (Gilbert-Elliott)</button></div>
              <span class="hint">les rafales dégradent davantage la voix et la vidéo</span></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">${icon("bolt")}Qualité de service</div>
            <label class="switch"><input type="checkbox" id="e-qos" ${q.enabled ? "checked" : ""}><span class="track"></span>${q.enabled ? "QoS activée" : "QoS désactivée (FIFO)"}</label></div>
          <div class="${q.enabled ? "" : "hide"}" id="e-qos-body">
            <div class="field" style="margin-bottom:14px"><div class="field-head"><label>Ordonnanceur</label></div>
              <div class="seg" id="e-sched">${schedOpts.map((s) => `<button data-s="${s}" class="${q.scheduler === s ? "on" : ""}">${esc(SCHED_LABEL[s])}</button>`).join("")}</div></div>
            <div class="grid g-3">
              ${q.scheduler === "wfq" ? slider("qos.weights.voice", "Poids voix", 1, 100, 1, q.weights.voice, "") : slider("qos.priority_cap_pct", "Plafond file prioritaire", 5, 100, 1, q.priority_cap_pct, "%", q.scheduler === "llq" ? "policer LLQ (Cisco : ≤ 33 %)" : "non utilisé en PQ")}
              ${slider("qos.weights.video", "Poids vidéo", 1, 100, 1, q.weights.video, "", "AF41")}
              ${slider("qos.weights.data", "Poids data", 1, 100, 1, q.weights.data, "", "best effort")}
            </div>
          </div>
          <div class="table-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Type de trafic</th><th>Priorité</th><th>DSCP</th><th>File (QoS active)</th></tr></thead><tbody>
            ${CLASSES.map((c) => `<tr><td>${CLASS_INFO[c].long}</td><td>${CLASS_INFO[c].prio} — ${["Haute", "Moyenne", "Basse"][CLASS_INFO[c].prio - 1]}</td><td class="mono small">${CLASS_INFO[c].dscp}</td><td>${CLASS_INFO[c].queue}</td></tr>`).join("")}
          </tbody></table></div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">${icon("topology")}Flux de trafic <span class="tag">${cfg.flows.length}</span></div>
            <div class="row"><button class="btn sm" data-addf="voice">${icon("plus")}Voix</button><button class="btn sm" data-addf="video">${icon("plus")}Vidéo</button><button class="btn sm" data-addf="data">${icon("plus")}Data</button></div></div>
          <div class="stack" style="gap:8px" id="e-flows">
            ${cfg.flows.length ? cfg.flows.map((f, i) => `
              <div class="flow-row ${f.enabled === false ? "off" : ""}">
                <div class="flow-icon ${f.type}">${classIcon(f.type)}</div>
                <input class="input sm" data-f="${i}" data-key="name" value="${esc(f.name)}" maxlength="60">
                <div class="flow-params">${flowParams(f, i)}</div>
                <div class="flow-rate">${fmtAuto(flowRate(f))} Mbit/s</div>
                <div class="row" style="gap:4px;flex-wrap:nowrap">
                  <label class="switch" title="Activer / désactiver"><input type="checkbox" data-f="${i}" data-key="enabled" ${f.enabled !== false ? "checked" : ""}><span class="track"></span></label>
                  <button class="btn sm ghost icon" data-delf="${i}" title="Supprimer">${icon("trash")}</button>
                </div>
              </div>`).join("") : `<div class="empty-state">${icon("topology")}<div>Aucun flux. Ajoutez des flux voix, vidéo ou data.</div></div>`}
          </div>
          <p class="hint" style="margin-top:10px">Voix : débit IP réel = (charge utile + 40 octets IP/UDP/RTP) / ptime — G.711 = 80 kbit/s par appel. Vidéo : VBR, GOP de 30 images, images I ≈ 4× les images P.</p>
        </div>`;
      bindEditor();
      view.querySelectorAll("#b-editor input[type=range]").forEach(setRangeFill);
    }

    const setPath = (path, v) => {
      const keys = path.split(".");
      let o = cfg;
      for (const k of keys.slice(0, -1)) o = o[k];
      o[keys[keys.length - 1]] = v;
    };

    function bindEditor() {
      const ed = view.querySelector("#b-editor");
      ed.querySelectorAll("input[type=range][data-path]").forEach((r) => r.addEventListener("input", () => {
        setRangeFill(r);
        setPath(r.dataset.path, +r.value);
        const num = ed.querySelector(`[data-num="${r.dataset.path}"]`);
        if (num) num.value = r.value;
        changed();
      }));
      ed.querySelectorAll("input[data-num]").forEach((inp) => inp.addEventListener("change", () => {
        const v = Math.max(+inp.min, Math.min(+inp.max, +inp.value || 0));
        inp.value = v;
        setPath(inp.dataset.num, v);
        const r = ed.querySelector(`input[type=range][data-path="${inp.dataset.num}"]`);
        if (r) { r.value = v; setRangeFill(r); }
        changed();
      }));
      ed.querySelector("#e-name").addEventListener("input", (e) => { cfg.name = e.target.value || "Scénario personnalisé"; delete cfg.preset; changed(false); });
      ed.querySelector("#e-desc").addEventListener("input", (e) => { cfg.description = e.target.value; changed(false); });
      ed.querySelector("#e-dur").addEventListener("change", (e) => { cfg.duration = Math.max(2, Math.min(120, +e.target.value || 20)); changed(false); });
      ed.querySelector("#e-seed").addEventListener("change", (e) => { cfg.seed = Math.max(0, Math.floor(+e.target.value || 0)); changed(false); });
      ed.querySelector("#e-lossm").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; cfg.network.loss_model = b.dataset.l; renderEditor(); changed(); });
      ed.querySelector("#e-qos").addEventListener("change", (e) => { cfg.qos.enabled = e.target.checked; renderEditor(); changed(); });
      ed.querySelector("#e-sched").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; cfg.qos.scheduler = b.dataset.s; renderEditor(); changed(); });
      ed.querySelectorAll("[data-addf]").forEach((b) => (b.onclick = () => { cfg.flows.push(newFlow(b.dataset.addf, cfg)); renderEditor(); changed(); }));
      ed.querySelectorAll("[data-delf]").forEach((b) => (b.onclick = () => { cfg.flows.splice(+b.dataset.delf, 1); renderEditor(); changed(); }));
      ed.querySelectorAll("[data-proto]").forEach((b) => (b.onclick = () => { cfg.flows[+b.dataset.f].protocol = b.dataset.proto; renderEditor(); changed(); }));
      ed.querySelectorAll("[data-f][data-key]").forEach((inp) => {
        const evt = inp.tagName === "SELECT" || inp.type === "checkbox" || inp.type === "number" ? "change" : "input";
        inp.addEventListener(evt, () => {
          const f = cfg.flows[+inp.dataset.f], k = inp.dataset.key;
          if (k === "enabled") f.enabled = inp.checked;
          else if (k === "name") f.name = inp.value;
          else if (k === "codec") f.codec = inp.value;
          else if (k === "profile") { f.profile = inp.value; if (meta.video_profiles[inp.value]) f.rate_mbps = meta.video_profiles[inp.value]; }
          else if (k === "rate_mbps") { f.rate_mbps = Math.max(0.1, +inp.value || 0.1); if (f.type === "video") f.profile = "custom"; }
          else f[k] = Math.max(1, Math.round(+inp.value || 1));
          if (k !== "name") renderEditor();
          changed(k !== "name");
        });
      });
    }

    function changed(structural = true) {
      if (structural) delete cfg.preset;
      renderPreview();
      commit();
    }

    // ------------------------------------------------------------------ aperçu
    function renderPreview() {
      const o = offered(cfg);
      const u = o.utilization;
      const st = u < 0.7 ? "good" : u < 0.95 ? "warn" : "critical";
      const msg = u < 0.7 ? "Le trafic tient dans la capacité configurée." : u < 0.95 ? "Charge élevée : des rafales peuvent remplir le buffer."
        : u <= 1 ? "Lien saturé : congestion probable." : `Trafic demandé supérieur de ${fmt((u - 1) * 100, 0)} % à la capacité : congestion et pertes certaines.`;
      const max = Math.max(o.total, o.capacity) || 1;
      const sched = cfg.qos.enabled ? cfg.qos.scheduler : "fifo";
      view.querySelector("#b-preview").innerHTML = `
        <div class="card glow">
          <div class="card-head"><div class="card-title">${icon("eye")}Aperçu interactif</div><span class="tag">${esc(SCHED_LABEL[sched].split(" —")[0])}</span></div>
          <div class="grid g-2" style="gap:12px">
            <div class="stat"><span class="s-label">Trafic total</span><span class="s-val" style="font-size:26px">${fmtAuto(o.total)}<small>Mbit/s</small></span></div>
            <div class="stat"><span class="s-label">Utilisation</span><span class="s-val status-text st-${st}" style="font-size:26px">${fmt(u * 100, 0)}<small>%</small></span></div>
          </div>
          <div style="margin:14px 0 6px" class="meter" title="Charge offerte par classe">
            ${CLASSES.map((c) => `<span style="width:${(o.per[c] / max) * 100}%;background:${CLASS_INFO[c].color}"></span>`).join("")}
          </div>
          <div style="position:relative;height:14px;margin-bottom:8px"><span style="position:absolute;left:calc(${(o.capacity / max) * 100}% - 1px);top:-24px;width:2px;height:22px;background:#e5ecf6;border-radius:2px"></span>
            <span class="small muted" style="position:absolute;left:${Math.min(70, (o.capacity / max) * 100)}%;white-space:nowrap">capacité ${fmtAuto(o.capacity)} Mbit/s</span></div>
          <div class="stack" style="gap:6px;margin-bottom:12px">${CLASSES.map((c) => `<div class="row between small"><span class="row" style="gap:7px"><i class="swatch" style="background:${CLASS_INFO[c].color}"></i>${CLASS_INFO[c].label}</span><span class="mono">${fmtAuto(o.per[c])} Mbit/s</span></div>`).join("")}</div>
          <div class="finding st-${st}" style="margin-bottom:14px"><span class="dot" style="margin-top:5px"></span><div><b>${st === "good" ? "Configuration saine" : st === "warn" ? "Attention" : "Congestion attendue"}</b><p>${msg}</p></div></div>
          <div class="stack" style="gap:8px">
            <button class="btn primary" id="p-live">${icon("play")}Lancer en temps réel</button>
            <button class="btn" id="p-analyze">${icon("analysis")}Simuler et analyser (${fmt(cfg.duration, 0)} s)</button>
            <button class="btn" id="p-compare">${icon("compare")}Comparer sans / avec QoS</button>
            <button class="btn ghost" id="p-save">${icon("save")}Enregistrer dans mes scénarios</button>
          </div>
        </div>`;
      const pv = view.querySelector("#b-preview");
      pv.querySelector("#p-live").onclick = () => { setConfig(cfg); liveStart(cfg); location.hash = "#/dashboard"; };
      pv.querySelector("#p-analyze").onclick = (e) => withLoading(e.currentTarget, async () => {
        setConfig(cfg);
        try {
          const r = await API.simulate(cfg);
          setResult({ ...r, source: "batch" });
          location.hash = "#/analysis";
        } catch (err) { toast(err.message, "critical"); }
      });
      pv.querySelector("#p-compare").onclick = () => { setConfig(cfg); location.hash = "#/optimization?run=1"; };
      pv.querySelector("#p-save").onclick = () => { saveCustomScenario(cfg); renderPresets(); toast(`« ${esc(cfg.name)} » enregistré dans ce navigateur.`, "good", 2200); };
    }

    // ------------------------------------------------------------------ import / export
    view.querySelector("#b-export").onclick = () => download(`${(cfg.name || "scenario").replace(/[^\w-]+/g, "_")}.json`, JSON.stringify(cfg, null, 2));
    view.querySelector("#b-import").onclick = () => view.querySelector("#b-file").click();
    view.querySelector("#b-file").onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!data.network || !Array.isArray(data.flows)) throw new Error("format inattendu");
        load({ ...clone(store.config), ...data, network: { ...store.config.network, ...data.network }, qos: { ...store.config.qos, ...(data.qos || {}) } });
      } catch (err) { toast(`Import impossible : ${esc(err.message)}`, "critical"); }
      e.target.value = "";
    };

    const renderAll = () => { renderPresets(); renderEditor(); renderPreview(); };
    renderAll();
    const off = on("config", (c) => {
      // modification externe (topologie, barre supérieure) : on resynchronise l'éditeur
      if (JSON.stringify(c) !== JSON.stringify(cfg)) { cfg = clone(c); renderAll(); }
    });
    return () => { off(); };
  },
};
