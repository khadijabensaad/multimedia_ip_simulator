"""
Mesure de la QoS à partir des paquets simulés.

  Latence        = instant de réception − instant d'émission (one-way, en ms)
  Jitter         = gigue inter-arrivées RFC 3550 :  J ← J + (|D(i−1,i)| − J) / 16
  Débit          = bits reçus / durée
  Perte          = paquets perdus / (paquets reçus + paquets perdus)
  Décomposition  = file d'attente + sérialisation + propagation

Le collecteur agrège en continu (fenêtres de 250 ms) pour le mode temps réel,
et produit un résumé complet en fin de simulation.
"""

from __future__ import annotations

import random

from ..config import THRESHOLDS, TRAFFIC_CLASSES
from .mos import class_score, estimate_mos, metric_status, mos_label, worst

WINDOW = 0.25
RESERVOIR = 60_000
MAX_TIMELINE = 2400
ALL = "all"
GROUPS = TRAFFIC_CLASSES + (ALL,)


# ----------------------------------------------------------------------------
# Fonctions de calcul unitaires (reprises et généralisées du premier prototype)
# ----------------------------------------------------------------------------
def calculate_average_latency(latencies):
    return round(sum(latencies) / len(latencies), 2) if latencies else 0


def calculate_jitter(latencies):
    """Gigue moyenne = moyenne des |différences| entre délais successifs."""
    if len(latencies) < 2:
        return 0
    diffs = [abs(latencies[i] - latencies[i - 1]) for i in range(1, len(latencies))]
    return round(sum(diffs) / len(diffs), 2)


def calculate_rfc3550_jitter(latencies):
    """Gigue lissée RFC 3550 (celle utilisée par RTP/RTCP)."""
    j = 0.0
    for i in range(1, len(latencies)):
        j += (abs(latencies[i] - latencies[i - 1]) - j) / 16
    return round(j, 3)


def calculate_bandwidth(data_size_mb, duration_seconds):
    if duration_seconds <= 0:
        return 0
    return round(data_size_mb * 8 / duration_seconds, 2)


def calculate_packet_loss(sent_packets, received_packets):
    if sent_packets <= 0:
        return 0
    return round((sent_packets - received_packets) / sent_packets * 100, 2)


def calculate_improvement(before, after):
    """Amélioration en % (positive = la valeur a diminué)."""
    if not before:
        return 0
    return round((before - after) / before * 100, 2)


def percentile(sorted_values, p):
    if not sorted_values:
        return None
    k = (len(sorted_values) - 1) * p / 100
    lo = int(k)
    hi = min(lo + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (k - lo)


# ----------------------------------------------------------------------------
class _Acc:
    __slots__ = ("sent", "recv", "d_buffer", "d_link", "d_policer", "b_sent", "b_recv",
                 "lat_sum", "lat_max", "lat_min", "jit_sum", "q_sum", "tx_sum", "prop_sum")

    def __init__(self):
        self.sent = self.recv = self.d_buffer = self.d_link = self.d_policer = 0
        self.b_sent = self.b_recv = 0
        self.lat_sum = self.jit_sum = self.q_sum = self.tx_sum = self.prop_sum = 0.0
        self.lat_max = 0.0
        self.lat_min = float("inf")

    @property
    def drops(self):
        return self.d_buffer + self.d_link + self.d_policer


class _Window:
    __slots__ = ("acc", "tx_bits", "q_n", "q_sum", "q_max", "capacity", "q_cls")

    def __init__(self, capacity):
        self.acc = {g: _Acc() for g in GROUPS}
        self.tx_bits = 0
        self.q_n = 0
        self.q_sum = 0
        self.q_max = 0
        self.q_cls = {c: 0 for c in TRAFFIC_CLASSES}
        self.capacity = capacity


def _ms(x):
    return None if x is None else round(x * 1000, 3)


class Collector:
    def __init__(self, sim):
        self.sim = sim
        self.rng = random.Random(sim.seed + 7)
        self.total = {g: _Acc() for g in GROUPS}
        self.flows: dict[str, _Acc] = {}
        self.streams: dict = {}
        self.samples = {c: [] for c in TRAFFIC_CLASSES}
        self.sample_seen = {c: 0 for c in TRAFFIC_CLASSES}
        self.windows: dict[int, _Window] = {}
        self.next_window = 0
        self.timeline: list = []
        self.frames: dict = {}
        self.frame_stats = {"total": 0, "damaged": 0, "i_total": 0, "i_damaged": 0}
        self.queue_n = 0
        self.queue_sum = 0
        self.queue_max = 0
        self.drop_events = 0

    # ------------------------------------------------------------------ helpers
    def _window(self, t):
        idx = int(t / WINDOW)
        w = self.windows.get(idx)
        if w is None:
            w = self.windows[idx] = _Window(self.sim.bandwidth)
        return w

    def _flow(self, fid):
        acc = self.flows.get(fid)
        if acc is None:
            acc = self.flows[fid] = _Acc()
        return acc

    # ------------------------------------------------------------------ événements
    def on_sent(self, pkt):
        w = self._window(pkt.created)
        for acc in (self.total[pkt.cls], self.total[ALL], w.acc[pkt.cls], w.acc[ALL], self._flow(pkt.flow)):
            acc.sent += 1
            acc.b_sent += pkt.size

    def on_drop(self, pkt, reason, now):
        w = self._window(now)
        attr = "d_" + reason
        for acc in (self.total[pkt.cls], self.total[ALL], w.acc[pkt.cls], w.acc[ALL], self._flow(pkt.flow)):
            setattr(acc, attr, getattr(acc, attr) + 1)
        self.drop_events += 1
        if pkt.frame is not None:
            self._frame_update(pkt.frame, lost=True)

    def on_transmit(self, pkt):
        self._window(pkt.txdone).tx_bits += pkt.size * 8

    def on_arrive(self, pkt, now):
        latency = now - pkt.created
        # Jitter RFC 3550 par sous-flux (chaque appel / session)
        st = self.streams.get(pkt.stream)
        if st is None:
            jitter = 0.0
        else:
            jitter = st[1] + (abs(latency - st[0]) - st[1]) / 16.0
        self.streams[pkt.stream] = (latency, jitter)

        q = pkt.dequeued - pkt.enqueued
        tx = pkt.txdone - pkt.dequeued
        prop = now - pkt.txdone
        w = self._window(now)
        for acc in (self.total[pkt.cls], self.total[ALL], w.acc[pkt.cls], w.acc[ALL], self._flow(pkt.flow)):
            acc.recv += 1
            acc.b_recv += pkt.size
            acc.lat_sum += latency
            acc.jit_sum += jitter
            acc.q_sum += q
            acc.tx_sum += tx
            acc.prop_sum += prop
            if latency > acc.lat_max:
                acc.lat_max = latency
            if latency < acc.lat_min:
                acc.lat_min = latency

        # Échantillonnage par réservoir pour les percentiles / histogrammes
        cls = pkt.cls
        self.sample_seen[cls] += 1
        bucket = self.samples[cls]
        if len(bucket) < RESERVOIR:
            bucket.append(latency)
        else:
            j = self.rng.randrange(self.sample_seen[cls])
            if j < RESERVOIR:
                bucket[j] = latency
        if pkt.frame is not None:
            self._frame_update(pkt.frame, lost=False)

    def register_frame(self, key, n_packets, is_i):
        self.frames[key] = [n_packets, 0, 0, is_i]

    def _frame_update(self, key, lost):
        f = self.frames.get(key)
        if f is None:
            return
        if lost:
            f[2] += 1
        else:
            f[1] += 1
        if f[1] + f[2] >= f[0]:
            fs = self.frame_stats
            fs["total"] += 1
            if f[3]:
                fs["i_total"] += 1
            if f[2]:
                fs["damaged"] += 1
                if f[3]:
                    fs["i_damaged"] += 1
            del self.frames[key]

    def sample_queue(self, now, lengths):
        total = sum(lengths.values())
        w = self._window(now)
        w.q_n += 1
        w.q_sum += total
        for c, n in lengths.items():
            w.q_cls[c] += n
        if total > w.q_max:
            w.q_max = total
        self.queue_n += 1
        self.queue_sum += total
        if total > self.queue_max:
            self.queue_max = total

    # ------------------------------------------------------------------ fenêtres
    def _format_group(self, acc, span):
        n_loss = acc.recv + acc.drops
        out = {
            "sent": acc.sent,
            "recv": acc.recv,
            "drops": acc.drops,
            "throughput": round(acc.b_recv * 8 / span / 1e6, 4),
            "offered": round(acc.b_sent * 8 / span / 1e6, 4),
            "latency": _ms(acc.lat_sum / acc.recv) if acc.recv else None,
            "latency_max": _ms(acc.lat_max) if acc.recv else None,
            "jitter": _ms(acc.jit_sum / acc.recv) if acc.recv else None,
            "queue_delay": _ms(acc.q_sum / acc.recv) if acc.recv else None,
            "loss": round(acc.drops / n_loss * 100, 3) if n_loss else 0.0,
        }
        return out

    def flush_windows(self, now):
        """Finalise les fenêtres entièrement écoulées et les retourne."""
        out = []
        last_complete = int(now / WINDOW) - 1
        while self.next_window <= last_complete:
            idx = self.next_window
            w = self.windows.pop(idx, None) or _Window(self.sim.bandwidth)
            groups = {g: self._format_group(w.acc[g], WINDOW) for g in GROUPS}
            v = groups["voice"]
            mos = None
            if v["recv"]:
                mos, _ = estimate_mos(v["latency"], v["jitter"], v["loss"], self.sim.voice_codec)
            groups["voice"]["mos"] = mos
            rec = {
                "t": round((idx + 1) * WINDOW, 3),
                "capacity": round(w.capacity / 1e6, 3),
                "utilization": round(min(1.0, w.tx_bits / (w.capacity * WINDOW)), 4),
                "queue": {
                    "avg": round(w.q_sum / w.q_n, 2) if w.q_n else 0,
                    "max": w.q_max,
                    **{c: round(w.q_cls[c] / w.q_n, 2) if w.q_n else 0 for c in TRAFFIC_CLASSES},
                },
                "classes": groups,
            }
            out.append(rec)
            self.timeline.append(rec)
            self.next_window += 1
        if len(self.timeline) > MAX_TIMELINE:
            del self.timeline[: len(self.timeline) - MAX_TIMELINE]
        return out

    # ------------------------------------------------------------------ résumé
    def summary(self, elapsed, cfg, sources):
        span = max(elapsed, 1e-9)
        classes = {}
        breakdown = {}
        sorted_samples = {}
        active_classes = {f["type"] for f in cfg["flows"] if f.get("enabled", True)}
        for c in TRAFFIC_CLASSES:
            acc = self.total[c]
            g = self._format_group(acc, span)
            s = sorted(self.samples[c])
            g["latency_min"] = _ms(acc.lat_min) if acc.recv else None
            g["latency_p50"] = _ms(percentile(s, 50))
            g["latency_p95"] = _ms(percentile(s, 95))
            g["latency_p99"] = _ms(percentile(s, 99))
            g["drops_detail"] = {"buffer": acc.d_buffer, "link": acc.d_link, "policer": acc.d_policer}
            g["active"] = c in active_classes or acc.sent > 0
            g["status"] = {
                m: metric_status(c, m, g[k]) if g["active"] and acc.recv else "idle"
                for m, k in (("latency", "latency"), ("jitter", "jitter"), ("loss", "loss"))
            }
            g["overall"] = worst(list(g["status"].values()))
            g["score"] = round(class_score(c, g["latency"], g["jitter"], g["loss"]), 1) if acc.recv else None
            classes[c] = g
            breakdown[c] = {
                "queueing": _ms(acc.q_sum / acc.recv) if acc.recv else 0,
                "transmission": _ms(acc.tx_sum / acc.recv) if acc.recv else 0,
                "propagation": _ms(acc.prop_sum / acc.recv) if acc.recv else 0,
            }
            sorted_samples[c] = s

        histograms = _histograms(sorted_samples)
        allg = self._format_group(self.total[ALL], span)

        # Qualité perçue de la voix : MOS par flux (codec propre à chaque flux)
        flows_out = []
        voice_mos = []
        for f in cfg["flows"]:
            acc = self.flows.get(f["id"]) or _Acc()
            g = self._format_group(acc, span)
            item = {"id": f["id"], "name": f["name"], "type": f["type"], "enabled": f.get("enabled", True),
                    "rate_mbps": f.get("rate_mbps"), **g}
            if f["type"] == "voice" and acc.recv:
                mos, r = estimate_mos(g["latency"], g["jitter"], g["loss"], f["codec"])
                item.update(mos=mos, r_factor=r, codec=f["codec"], calls=f["calls"])
                voice_mos.append((mos, r, f["calls"]))
            src = sources.get(f["id"])
            if src is not None and hasattr(src, "cwnd"):
                item.update(cwnd=round(src.cwnd, 1), retransmissions=src.retransmissions,
                            srtt_ms=_ms(src.srtt) if src.srtt else None)
            flows_out.append(item)

        voice_quality = None
        if voice_mos:
            calls = sum(v[2] for v in voice_mos)
            mos = sum(v[0] * v[2] for v in voice_mos) / calls
            r = sum(v[1] * v[2] for v in voice_mos) / calls
            voice_quality = {"mos": round(mos, 2), "r_factor": round(r, 1), "label": mos_label(mos),
                             "min_mos": min(v[0] for v in voice_mos), "calls": calls}
            classes["voice"]["mos"] = voice_quality["mos"]

        fs = self.frame_stats
        video_quality = None
        if fs["total"]:
            video_quality = {
                "frames": fs["total"],
                "damaged": fs["damaged"],
                "frame_integrity": round((1 - fs["damaged"] / fs["total"]) * 100, 2),
                "i_frames_damaged": fs["i_damaged"],
            }

        tcp = [s for s in sources.values() if hasattr(s, "cwnd")]
        data_quality = None
        if classes["data"]["recv"]:
            data_quality = {
                "goodput_mbps": classes["data"]["throughput"],
                "retransmissions": sum(s.retransmissions for s in tcp),
                "cwnd_reductions": sum(s.cwnd_reductions for s in tcp),
                "tcp_flows": len(tcp),
            }

        utils = [w["utilization"] for w in self.timeline]
        net = {
            "capacity_mbps": round(self.sim.bandwidth / 1e6, 3),
            "utilization_avg": round(sum(utils) / len(utils), 4) if utils else 0,
            "utilization_peak": round(max(utils), 4) if utils else 0,
            "queue_avg": round(self.queue_sum / self.queue_n, 2) if self.queue_n else 0,
            "queue_max": self.queue_max,
            "drops": {"buffer": self.total[ALL].d_buffer, "link": self.total[ALL].d_link,
                      "policer": self.total[ALL].d_policer},
        }

        # Score de santé global pondéré
        weights = {"voice": 0.4, "video": 0.35, "data": 0.25}
        present = [c for c in TRAFFIC_CLASSES if classes[c]["score"] is not None]
        if present:
            wsum = sum(weights[c] for c in present)
            score = sum(classes[c]["score"] * weights[c] for c in present) / wsum
        else:
            score = 100.0
        status = "good" if score >= 80 else "warn" if score >= 55 else "critical"
        label = {"good": "Réseau stable", "warn": "Dégradation modérée", "critical": "Congestion critique"}[status]

        return {
            "elapsed": round(elapsed, 3),
            "classes": classes,
            "all": allg,
            "flows": flows_out,
            "network": net,
            "voice_quality": voice_quality,
            "video_quality": video_quality,
            "data_quality": data_quality,
            "latency_breakdown": breakdown,
            "histograms": histograms,
            "health": {"score": round(score, 1), "status": status, "label": label},
            "thresholds": THRESHOLDS,
        }


def _histograms(samples: dict, bins=30):
    """Histogrammes de latence (en % des paquets) sur des classes de largeur commune."""
    present = {c: v for c, v in samples.items() if v}
    if not present:
        return {c: {"edges": [], "counts": []} for c in samples}
    lo = min(v[0] for v in present.values()) * 1000
    hi = max(percentile(v, 99.5) for v in present.values()) * 1000
    if hi - lo < 1:
        hi = lo + 1
    step = (hi - lo) / bins
    edges = [round(lo + i * step, 3) for i in range(bins + 1)]
    out = {}
    for c, v in samples.items():
        if not v:
            out[c] = {"edges": edges, "counts": []}
            continue
        counts = [0] * bins
        for x in v:
            i = int((x * 1000 - lo) / step)
            if 0 <= i < bins:
                counts[i] += 1
            elif i == bins:
                counts[-1] += 1  # valeur égale à la borne haute
        out[c] = {"edges": edges, "counts": [round(n / len(v) * 100, 3) for n in counts]}
    return out
