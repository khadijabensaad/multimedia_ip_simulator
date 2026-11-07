// Agrégation côté client des fenêtres de mesure (lissage, score de santé, MOS).

import { CLASSES } from "./ui.js";

export function aggregate(windows) {
  const out = {};
  for (const g of [...CLASSES, "all"]) {
    let recv = 0, drops = 0, lat = 0, jit = 0, thr = 0, off = 0, qd = 0, mosW = 0, mosN = 0;
    for (const w of windows) {
      const c = w.classes[g];
      recv += c.recv; drops += c.drops; thr += c.throughput; off += c.offered;
      if (c.recv) { lat += c.latency * c.recv; jit += c.jitter * c.recv; qd += (c.queue_delay || 0) * c.recv; }
      if (c.mos != null) { mosW += c.mos * c.recv; mosN += c.recv; }
    }
    const n = Math.max(1, windows.length);
    out[g] = {
      recv, drops,
      latency: recv ? lat / recv : null,
      jitter: recv ? jit / recv : null,
      queue_delay: recv ? qd / recv : null,
      loss: recv + drops ? (drops / (recv + drops)) * 100 : (windows.length ? 0 : null),
      throughput: thr / n,
      offered: off / n,
      mos: mosN ? mosW / mosN : null,
    };
  }
  const n = Math.max(1, windows.length);
  out.utilization = windows.length ? windows.reduce((a, w) => a + w.utilization, 0) / n : null;
  out.capacity = windows.length ? windows[windows.length - 1].capacity : null;
  out.queue = windows.length ? windows.reduce((a, w) => a + w.queue.avg, 0) / n : 0;
  return out;
}

function metricScore(th, cls, metric, v) {
  if (v == null) return 100;
  const [good, crit] = th[cls][metric];
  if (v <= good) return 100;
  if (v <= crit) return 100 - (50 * (v - good)) / (crit - good);
  return (50 * crit) / v;
}
const WEIGHTS = { voice: 0.4, video: 0.35, data: 0.25 };

export function healthScore(agg, th) {
  let s = 0, w = 0;
  for (const c of CLASSES) {
    const g = agg[c];
    if (!g || !g.recv) continue;
    const sc = [metricScore(th, c, "latency", g.latency), metricScore(th, c, "jitter", g.jitter), metricScore(th, c, "loss", g.loss)];
    const cs = Math.min(...sc) * 0.6 + (sc.reduce((a, b) => a + b, 0) / 3) * 0.4;
    s += cs * WEIGHTS[c]; w += WEIGHTS[c];
  }
  return w ? s / w : null;
}
