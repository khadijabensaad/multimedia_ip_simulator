// Accès à l'API REST et client temps réel (WebSocket, avec repli automatique en REST).

const ORIGIN = location.protocol.startsWith("http") ? "" : "http://127.0.0.1:8000";

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(ORIGIN + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* corps vide */ }
  if (!res.ok) throw new Error((data && data.detail) || `Erreur ${res.status}`);
  return data;
}

export const API = {
  health: () => api("/api/health"),
  meta: () => api("/api/meta"),
  presets: () => api("/api/presets"),
  simulate: (config, save = true) => api("/api/simulate", { method: "POST", body: { config, save } }),
  compare: (config, schedulers) => api("/api/compare", { method: "POST", body: { config, schedulers } }),
  sweep: (config, param, values, compare_qos = true) => api("/api/sweep", { method: "POST", body: { config, param, values, compare_qos } }),
  optimize: (config, recommendations) => api("/api/optimize", { method: "POST", body: { config, recommendations } }),
  history: () => api("/api/history"),
  historyGet: (id) => api(`/api/history/${id}`),
  historyDelete: (id) => api(`/api/history/${id}`, { method: "DELETE" }),
  reportUrl: (id, ext) => `${ORIGIN}/api/reports/${id}.${ext}`,
};

// ---------------------------------------------------------------------------- temps réel
export class LiveClient extends EventTarget {
  constructor() {
    super();
    this.mode = null;        // "ws" | "rest"
    this.ws = null;
    this.session = null;
    this.running = false;
    this.timer = null;
    this.speed = 1;
    this.wsFailed = false;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async start(config, speed = 1) {
    this.speed = speed;
    await this.stopSilently();
    if (!this.wsFailed && "WebSocket" in window) {
      try {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) await this.openWs();
        this.mode = "ws";
        this.emit("mode", "ws");
        this.ws.send(JSON.stringify({ type: "start", config, speed }));
        this.running = true;
        return;
      } catch {
        this.wsFailed = true;
      }
    }
    this.mode = "rest";
    this.emit("mode", "rest");
    const r = await api("/api/live", { method: "POST", body: { config, speed } });
    this.session = r.session;
    this.running = true;
    this.emit("started", r);
    this.loop();
  }

  openWs() {
    return new Promise((resolve, reject) => {
      const url = (ORIGIN || location.origin).replace(/^http/, "ws") + "/ws/live";
      const ws = new WebSocket(url);
      const t = setTimeout(() => { ws.close(); reject(new Error("timeout")); }, 2000);
      ws.onopen = () => { clearTimeout(t); this.ws = ws; resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error("ws")); };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "started") this.session = msg.session;
        if (msg.type === "summary") { this.running = false; this.session = null; }
        this.emit(msg.type, msg);
      };
      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
          if (this.running) { this.running = false; this.emit("error", { message: "Connexion temps réel interrompue" }); }
        }
      };
    });
  }

  async loop() {
    clearTimeout(this.timer);
    if (!this.running || this.mode !== "rest" || !this.session) return;
    const t0 = performance.now();
    try {
      const tick = await api(`/api/live/${this.session}/step`, { method: "POST", body: { wall_dt: 0.2 } });
      if (this.running) this.emit("tick", tick);
    } catch (e) {
      this.running = false;
      this.emit("error", { message: e.message });
      return;
    }
    const spent = performance.now() - t0;
    this.timer = setTimeout(() => this.loop(), Math.max(10, 200 - spent));
  }

  async patch(p) {
    if (!this.session && this.mode !== "ws") return;
    if (p.speed) this.speed = p.speed;
    if (this.mode === "ws" && this.ws) this.ws.send(JSON.stringify({ type: "patch", ...p }));
    else if (this.session) this.emit("patched", await api(`/api/live/${this.session}`, { method: "PATCH", body: p }));
  }

  pause() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.mode === "ws" && this.ws) this.ws.send(JSON.stringify({ type: "pause" }));
    else this.emit("paused", {});
  }

  resume() {
    this.running = true;
    if (this.mode === "ws" && this.ws) this.ws.send(JSON.stringify({ type: "resume" }));
    else { this.emit("resumed", {}); this.loop(); }
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.mode === "ws" && this.ws) { this.ws.send(JSON.stringify({ type: "stop" })); return; }
    if (this.session) {
      const sid = this.session;
      this.session = null;
      this.emit("summary", await api(`/api/live/${sid}/finish`, { method: "POST", body: { save: true } }));
    }
  }

  async stopSilently() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.session && this.mode === "rest") {
      try { await api(`/api/live/${this.session}/finish`, { method: "POST", body: { save: false } }); } catch { /* ignore */ }
    }
    this.session = null;
  }
}
