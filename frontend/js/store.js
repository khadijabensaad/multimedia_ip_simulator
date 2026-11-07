// État global de l'application + bus d'événements + contrôleur de la simulation temps réel.

import { API, LiveClient } from "./api.js";
import { toast } from "./ui.js";

const LS_CONFIG = "qoslab.config";
const LS_CUSTOM = "qoslab.customScenarios";
const MAX_WINDOWS = 480;   // 2 minutes de simulation en fenêtres de 250 ms
const MAX_ALERTS = 120;

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export function on(name, fn) {
  const h = (e) => fn(e.detail);
  bus.addEventListener(name, h);
  return () => bus.removeEventListener(name, h);
}

export const store = {
  meta: null,
  presets: [],
  config: null,
  backend: { ok: false, version: null, pdf: false },
  live: { status: "idle", mode: null, session: null, windows: [], state: null, alerts: [], summary: null, t: 0, speed: 1, config: null },
  lastResult: null,     // { config, summary, timeline, advisor, history_id }
  lastCompare: null,
  lastOptimize: null,
  lastSweep: null,
};

const safe = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};

export const clone = (o) => JSON.parse(JSON.stringify(o));

export function setConfig(cfg, { silent = false, patchLive = true } = {}) {
  store.config = clone(cfg);
  safe.set(LS_CONFIG, store.config);
  if (!silent) emit("config", store.config);
  if (patchLive && store.live.status !== "idle") livePatch({ network: cfg.network, qos: cfg.qos, flows: cfg.flows });
}
export const savedConfig = () => safe.get(LS_CONFIG);
export const customScenarios = () => safe.get(LS_CUSTOM) || [];
export function saveCustomScenario(cfg) {
  const list = customScenarios().filter((c) => c.name !== cfg.name);
  list.unshift({ ...clone(cfg), savedAt: new Date().toISOString() });
  safe.set(LS_CUSTOM, list.slice(0, 20));
}
export function deleteCustomScenario(name) { safe.set(LS_CUSTOM, customScenarios().filter((c) => c.name !== name)); }

export function presetConfig(id) {
  const p = store.presets.find((x) => x.id === id);
  return p ? clone(p.config) : null;
}

export function setResult(result) {
  store.lastResult = result;
  emit("result", result);
}

// ---------------------------------------------------------------------------- live
export const live = new LiveClient();

function setLiveStatus(status) {
  store.live.status = status;
  emit("live-status", store.live);
}

live.addEventListener("mode", (e) => { store.live.mode = e.detail; emit("live-status", store.live); });
live.addEventListener("started", (e) => {
  const m = e.detail;
  Object.assign(store.live, { session: m.session, windows: [], alerts: [], summary: null, t: 0, state: m.state, config: m.config });
  setLiveStatus("running");
  emit("live-reset", store.live);
});
live.addEventListener("tick", (e) => {
  const m = e.detail;
  const L = store.live;
  L.t = m.t;
  L.state = m.state;
  if (m.windows.length) {
    L.windows.push(...m.windows);
    if (L.windows.length > MAX_WINDOWS) L.windows.splice(0, L.windows.length - MAX_WINDOWS);
  }
  if (m.alerts.length) {
    L.alerts.unshift(...m.alerts.reverse());
    if (L.alerts.length > MAX_ALERTS) L.alerts.length = MAX_ALERTS;
  }
  emit("tick", m);
});
live.addEventListener("patched", (e) => {
  store.live.config = e.detail.config;
  if (e.detail.state) store.live.state = e.detail.state;
  emit("live-patched", e.detail);
});
live.addEventListener("paused", () => setLiveStatus("paused"));
live.addEventListener("resumed", () => setLiveStatus("running"));
live.addEventListener("summary", (e) => {
  const m = e.detail;
  store.live.summary = m;
  setLiveStatus("idle");
  setResult({ config: m.config, summary: m.summary, timeline: m.timeline, advisor: m.advisor, history_id: m.history_id, source: "live" });
  toast(`Session terminée — score de santé <b>${Math.round(m.summary.health.score)}/100</b>. Résultats disponibles dans <a href="#/analysis">Analyse QoS</a>.`, m.summary.health.status);
  emit("live-summary", m);
});
live.addEventListener("error", (e) => {
  setLiveStatus("idle");
  toast(e.detail.message || "Erreur temps réel", "critical");
});

export async function liveStart(cfg = store.config) {
  if (!cfg || !cfg.flows?.some((f) => f.enabled !== false)) { toast("Ajoutez au moins un flux actif avant de démarrer.", "warn"); return; }
  setLiveStatus("connecting");
  try {
    await live.start(cfg, store.live.speed);
  } catch (err) {
    setLiveStatus("idle");
    toast(`Impossible de démarrer : ${err.message}`, "critical");
  }
}
export const livePause = () => live.pause();
export const liveResume = () => live.resume();
export async function liveStop() {
  try { await live.stop(); } catch (err) { toast(err.message, "critical"); setLiveStatus("idle"); }
}
export function livePatch(p) {
  if (store.live.status === "idle") return;
  live.patch(p).catch((err) => toast(err.message, "critical"));
}
export function liveSpeed(speed) {
  store.live.speed = speed;
  livePatch({ speed });
  emit("live-status", store.live);
}

export async function boot() {
  const [meta, presets] = await Promise.all([API.meta(), API.presets()]);
  store.meta = meta;
  store.presets = presets.presets;
  store.backend = { ok: true, version: meta.version, pdf: meta.pdf };
  const saved = savedConfig();
  store.config = saved && saved.flows ? saved : presetConfig("congestion");
}
