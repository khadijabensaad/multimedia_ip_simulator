// Utilitaires d'interface : formatage, icônes, statuts, notifications.

export const CLASSES = ["voice", "video", "data"];
export const CLASS_INFO = {
  voice: { label: "Voix", long: "Voix (VoIP)", color: "#22d3ee", dscp: "EF 46", proto: "RTP/UDP", prio: 1, queue: "Priority Queue" },
  video: { label: "Vidéo", long: "Vidéo (streaming)", color: "#a78bfa", dscp: "AF41 34", proto: "RTP/UDP", prio: 2, queue: "Weighted Queue" },
  data: { label: "Data", long: "Data (TCP/UDP)", color: "#f472b6", dscp: "BE 0", proto: "TCP / UDP", prio: 3, queue: "Best Effort" },
};
export const STATUS = {
  good: { label: "Stable", color: "#34d399" },
  warn: { label: "Dégradé", color: "#fb923c" },
  critical: { label: "Critique", color: "#f87171" },
  idle: { label: "—", color: "#64748b" },
  info: { label: "Info", color: "#60a5fa" },
  success: { label: "OK", color: "#34d399" },
};
export const SCHED_SHORT = { fifo: "FIFO", priority: "PQ", wfq: "WFQ", llq: "LLQ" };
export const SCHED_LABEL = {
  fifo: "FIFO — sans QoS", priority: "PQ — priorité stricte", wfq: "WFQ — files pondérées", llq: "LLQ — voix prioritaire + CBWFQ",
};

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function fmt(v, digits = 1, fallback = "—") {
  if (v === null || v === undefined || Number.isNaN(v)) return fallback;
  const n = Number(v);
  if (Math.abs(n) >= 1000 && digits <= 1) return n.toLocaleString("fr-FR", { maximumFractionDigits: 0 });
  return n.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export const fmtAuto = (v, unit = "") => {
  if (v === null || v === undefined) return "—";
  const a = Math.abs(v);
  const d = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return fmt(v, d) + (unit ? ` ${unit}` : "");
};
export const pct = (v, d = 0) => (v === null || v === undefined ? "—" : `${fmt(v * 100, d)} %`);
export const fmtTime = (t) => {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
export const fmtDate = (iso) => {
  try { return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }); } catch { return iso; }
};

export function statusOf(thresholds, cls, metric, value) {
  if (value === null || value === undefined || !thresholds) return "idle";
  const [good, crit] = thresholds[cls][metric];
  return value <= good ? "good" : value <= crit ? "warn" : "critical";
}
export const worst = (list) => {
  const order = ["idle", "good", "warn", "critical"];
  return list.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), "idle");
};
export const mosStatus = (m) => (m == null ? "idle" : m >= 4 ? "good" : m >= 3.6 ? "warn" : "critical");
export const healthStatus = (s) => (s == null ? "idle" : s >= 80 ? "good" : s >= 55 ? "warn" : "critical");
export const utilStatus = (u) => (u == null ? "idle" : u < 0.7 ? "good" : u < 0.9 ? "warn" : "critical");
export const mosLabel = (m) => (m >= 4.3 ? "Excellente" : m >= 4 ? "Bonne" : m >= 3.6 ? "Correcte" : m >= 3.1 ? "Médiocre" : "Mauvaise");

export const pill = (status, text, pulse = false) =>
  `<span class="pill st-${status}"><span class="dot ${pulse ? "pulse" : ""}"></span>${esc(text)}</span>`;
export const clsTag = (c) => `<span class="tag cls-${c}">${CLASS_INFO[c].label}</span>`;

// ------------------------------------------------------------------ icônes (traits 24×24)
export const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  topology: '<circle cx="5" cy="6" r="2.2"/><circle cx="5" cy="18" r="2.2"/><circle cx="19" cy="12" r="2.2"/><rect x="10" y="9.5" width="5" height="5" rx="1"/><path d="M7 7l3 3.5M7 17l3-3.5M15 12h2"/>',
  builder: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  analysis: '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
  optimize: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  reports: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>',
  stop: '<rect x="5.5" y="5.5" width="13" height="13" rx="2" fill="currentColor" stroke="none"/>',
  phone: '<path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  video: '<rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="m15.5 10 6-3.5v11l-6-3.5"/>',
  data: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  server: '<rect x="3" y="3.5" width="18" height="7" rx="1.5"/><rect x="3" y="13.5" width="18" height="7" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  router: '<rect x="2.5" y="13" width="19" height="7" rx="2"/><path d="M6 16.5h.01M10 16.5h.01M12 13V8M8.5 6.5a5 5 0 0 1 7 0M6 4a8.5 8.5 0 0 1 12 0"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.5 4.5 0 0 1-.5 9.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0"/>',
  gauge: '<path d="M12 14l4-6"/><path d="M3.5 18a9 9 0 1 1 17 0"/>',
  download: '<path d="M12 3v12m0 0 5-5m-5 5-5-5M4 19h16"/>',
  upload: '<path d="M12 21V9m0 0 5 5m-5-5-5 5M4 5h16"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  compare: '<path d="M8 3v18M16 3v18M3 8h5M16 16h5M3 16h5M16 8h5"/>',
  save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2"/><path d="M7 3v5h8M7 21v-7h10v7"/>',
  refresh: '<path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 13.7 4.7L20 15.5M20 20v-4.5h-4.5"/>',
  print: '<path d="M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2"/><rect x="6" y="14" width="12" height="7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  switch: '<rect x="2.5" y="8" width="19" height="8" rx="2"/><path d="M6 12h.01M9 12h.01M12 12h.01M15 12h.01M18 12h.01"/>',
};
export const icon = (name, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
export const classIcon = (c) => icon(c === "voice" ? "phone" : c === "video" ? "video" : "data");

// ------------------------------------------------------------------ toasts
export function toast(message, status = "info", ms = 3800) {
  const zone = document.getElementById("toasts");
  if (!zone) return;
  const el = document.createElement("div");
  el.className = `toast st-${status}`;
  el.innerHTML = `<span class="dot"></span><div>${message}</div>`;
  zone.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 320); }, ms);
}

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function setRangeFill(input) {
  const min = +input.min || 0, max = +input.max || 100;
  input.style.setProperty("--p", `${((+input.value - min) / (max - min)) * 100}%`);
}

export async function withLoading(btn, fn) {
  if (btn) btn.classList.add("loading");
  try { return await fn(); } finally { if (btn) btn.classList.remove("loading"); }
}

export function ring(value, { size = 112, stroke = 9, max = 100, color, label = "", sub = "" } = {}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, (value ?? 0) / max));
  return `<div class="ring" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="#1a2640" stroke-width="${stroke}" fill="none"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${color}" stroke-width="${stroke}" fill="none" stroke-linecap="round"
      stroke-dasharray="${c * v} ${c}" style="filter:drop-shadow(0 0 6px ${color}66);transition:stroke-dasharray .5s"/></svg>
    <div class="ring-val"><b>${label}</b><small>${sub}</small></div></div>`;
}

// change = variation relative en % (après − avant) / avant ; higherIsBetter pour débit, MOS…
export function deltaHtml(change, { higherIsBetter = false, unit = "%" } = {}) {
  if (change === null || change === undefined || Number.isNaN(change)) return `<span class="delta flat">—</span>`;
  const flat = Math.abs(change) < 0.5;
  const good = higherIsBetter ? change > 0 : change < 0;
  const cls = flat ? "flat" : good ? "up" : "down";
  const arrow = flat ? "=" : change > 0 ? "▲" : "▼";
  return `<span class="delta ${cls}">${arrow} ${fmt(Math.abs(change), 0)}${unit}</span>`;
}

export function download(filename, content, type = "application/json") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
