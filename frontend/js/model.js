// Fonctions de manipulation des configurations de scénario côté client.

import { store } from "./store.js";

const RTP_OVERHEAD = 40;

export function codecKbps(codec) {
  const c = store.meta?.codecs?.[codec];
  return c ? c.ip_kbps : 80;
}

export function flowRate(f) {
  if (f.type === "voice") return (f.calls * codecKbps(f.codec)) / 1000;
  return +f.rate_mbps || 0;
}

export function offered(cfg) {
  const per = { voice: 0, video: 0, data: 0 };
  for (const f of cfg.flows) if (f.enabled !== false) per[f.type] += flowRate(f);
  const total = per.voice + per.video + per.data;
  return { per, total, capacity: cfg.network.bandwidth_mbps, utilization: total / cfg.network.bandwidth_mbps };
}

let counter = 0;
export function newFlow(type, cfg) {
  const n = cfg.flows.filter((f) => f.type === type).length + 1;
  const id = `${type}-${Date.now().toString(36)}${(counter++).toString(36)}`;
  if (type === "voice") return { id, type, name: `Client VoIP ${n}`, codec: "G.711", calls: 5, enabled: true };
  if (type === "video") return { id, type, name: `Serveur vidéo ${n}`, rate_mbps: 3, fps: 30, profile: "720p", enabled: true };
  return { id, type, name: `Hôte data ${n}`, rate_mbps: 5, protocol: "tcp", enabled: true };
}

export const RTP = RTP_OVERHEAD;
