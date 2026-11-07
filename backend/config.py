"""
Constantes du simulateur et validation des configurations de scénario.

Toutes les valeurs « métier » (codecs, profils vidéo, seuils QoS, marquage DSCP)
sont centralisées ici pour que le backend et l'interface parlent le même langage.
"""

from __future__ import annotations

import copy
import uuid

TRAFFIC_CLASSES = ("voice", "video", "data")

# En-têtes protocolaires (octets)
IP_HEADER = 20
UDP_HEADER = 8
RTP_HEADER = 12
TCP_HEADER = 20
RTP_OVERHEAD = IP_HEADER + UDP_HEADER + RTP_HEADER  # 40 octets
TCP_OVERHEAD = IP_HEADER + TCP_HEADER               # 40 octets
MTU = 1500

# --------------------------------------------------------------------------
# Codecs voix (valeurs Ie / Bpl : ITU-T G.113 Appendice I, utilisées par l'E-model)
# --------------------------------------------------------------------------
CODECS = {
    "G.711": {
        "label": "G.711 PCM — 64 kbit/s",
        "bitrate": 64_000, "ptime": 0.020, "payload": 160,
        "ie": 0.0, "bpl": 25.1, "codec_delay": 0.000,
    },
    "G.729": {
        "label": "G.729A — 8 kbit/s",
        "bitrate": 8_000, "ptime": 0.020, "payload": 20,
        "ie": 11.0, "bpl": 19.0, "codec_delay": 0.015,
    },
    "G.723.1": {
        "label": "G.723.1 — 6,3 kbit/s",
        "bitrate": 6_300, "ptime": 0.030, "payload": 24,
        "ie": 15.0, "bpl": 16.1, "codec_delay": 0.0375,
    },
}


def codec_ip_bps(codec: str) -> float:
    """Débit IP réel d'un appel (charge utile + 40 octets IP/UDP/RTP)."""
    c = CODECS[codec]
    return (c["payload"] + RTP_OVERHEAD) * 8 / c["ptime"]


# Profils vidéo (débit moyen en Mbit/s)
VIDEO_PROFILES = {
    "480p": 1.5,
    "720p": 3.0,
    "1080p": 5.0,
    "1440p": 9.0,
    "4K": 16.0,
}

# Ordonnanceurs disponibles sur le routeur goulot d'étranglement
SCHEDULERS = {
    "fifo": "FIFO — Best effort (sans QoS)",
    "priority": "PQ — Priorité stricte",
    "wfq": "WFQ — Files pondérées (DRR)",
    "llq": "LLQ — Priorité voix + CBWFQ",
}

# Marquage DiffServ (RFC 4594)
DSCP = {
    "voice": {"name": "EF", "value": 46, "phb": "Expedited Forwarding"},
    "video": {"name": "AF41", "value": 34, "phb": "Assured Forwarding 4.1"},
    "data": {"name": "BE", "value": 0, "phb": "Best Effort"},
}

# Seuils QoS : (bon, critique). Voix : ITU-T G.114 / recommandations Cisco.
THRESHOLDS = {
    "voice": {"latency": (150.0, 400.0), "jitter": (30.0, 50.0), "loss": (1.0, 3.0)},
    "video": {"latency": (150.0, 400.0), "jitter": (30.0, 50.0), "loss": (1.0, 3.0)},
    "data": {"latency": (400.0, 1000.0), "jitter": (100.0, 250.0), "loss": (2.0, 5.0)},
}

# Plafond de chaque file (fraction du buffer partagé) quand la QoS est active
CLASS_BUFFER_SHARE = {"voice": 0.30, "video": 1.00, "data": 0.70}

DEFAULT_CONFIG = {
    "name": "Scénario personnalisé",
    "description": "",
    "duration": 20.0,
    "seed": 42,
    "network": {
        "bandwidth_mbps": 20.0,
        "base_latency_ms": 10.0,
        "jitter_ms": 1.0,
        "loss_pct": 0.0,
        "loss_model": "random",   # random | burst (Gilbert-Elliott)
        "buffer_pkts": 100,
    },
    "qos": {
        "enabled": False,
        "scheduler": "llq",
        "weights": {"voice": 30, "video": 60, "data": 15},
        "priority_cap_pct": 33,
    },
    "flows": [],
}

FLOW_DEFAULTS = {
    "voice": {"name": "Appels VoIP", "codec": "G.711", "calls": 4},
    "video": {"name": "Streaming vidéo", "rate_mbps": 5.0, "fps": 30, "profile": "1080p"},
    "data": {"name": "Transfert de fichiers", "rate_mbps": 5.0, "protocol": "tcp"},
}


def _clamp(value, lo, hi, default):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return max(lo, min(hi, v))


def flow_rate_bps(flow: dict) -> float:
    """Débit offert (bit/s, niveau IP) d'un flux."""
    if flow["type"] == "voice":
        return flow["calls"] * codec_ip_bps(flow["codec"])
    return flow["rate_mbps"] * 1e6


def normalize_flow(raw: dict, index: int = 0) -> dict:
    ftype = raw.get("type", "data")
    if ftype not in TRAFFIC_CLASSES:
        raise ValueError(f"Type de flux inconnu : {ftype}")
    flow = copy.deepcopy(FLOW_DEFAULTS[ftype])
    flow.update({k: v for k, v in raw.items() if v is not None})
    flow["type"] = ftype
    flow["id"] = str(raw.get("id") or f"{ftype}-{index + 1}")  # identifiant déterministe (graine des sources)
    flow["name"] = str(flow.get("name") or FLOW_DEFAULTS[ftype]["name"])[:60]
    flow["enabled"] = bool(raw.get("enabled", True))
    if ftype == "voice":
        if flow["codec"] not in CODECS:
            flow["codec"] = "G.711"
        flow["calls"] = int(_clamp(flow.get("calls"), 1, 500, 4))
        flow["rate_mbps"] = round(flow_rate_bps(flow) / 1e6, 4)
    elif ftype == "video":
        flow["rate_mbps"] = _clamp(flow.get("rate_mbps"), 0.1, 100, 5.0)
        flow["fps"] = int(_clamp(flow.get("fps"), 10, 60, 30))
        if flow.get("profile") not in VIDEO_PROFILES:
            flow["profile"] = "custom"
    else:
        flow["rate_mbps"] = _clamp(flow.get("rate_mbps"), 0.1, 1000, 5.0)
        if flow.get("protocol") not in ("tcp", "udp"):
            flow["protocol"] = "tcp"
    return flow


def normalize_config(raw: dict | None) -> dict:
    """Complète une configuration avec les valeurs par défaut et borne les paramètres."""
    raw = raw or {}
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    for key in ("name", "description", "id", "category", "preset"):
        if key in raw and raw[key] is not None:
            cfg[key] = raw[key]
    cfg["name"] = str(cfg["name"])[:80]
    cfg["duration"] = _clamp(raw.get("duration"), 2, 120, 20.0)
    cfg["seed"] = int(_clamp(raw.get("seed"), 0, 2**31 - 1, 42))

    net = {**cfg["network"], **(raw.get("network") or {})}
    cfg["network"] = {
        "bandwidth_mbps": _clamp(net["bandwidth_mbps"], 0.5, 10_000, 20.0),
        "base_latency_ms": _clamp(net["base_latency_ms"], 0, 1000, 10.0),
        "jitter_ms": _clamp(net["jitter_ms"], 0, 200, 1.0),
        "loss_pct": _clamp(net["loss_pct"], 0, 50, 0.0),
        "loss_model": net["loss_model"] if net.get("loss_model") in ("random", "burst") else "random",
        "buffer_pkts": int(_clamp(net["buffer_pkts"], 5, 5000, 100)),
    }

    qos_raw = raw.get("qos") or {}
    qos = {**cfg["qos"], **qos_raw}
    weights = {**cfg["qos"]["weights"], **(qos_raw.get("weights") or {})}
    cfg["qos"] = {
        "enabled": bool(qos["enabled"]),
        "scheduler": qos["scheduler"] if qos.get("scheduler") in SCHEDULERS and qos["scheduler"] != "fifo" else "llq",
        "weights": {c: _clamp(weights.get(c), 1, 100, 20) for c in TRAFFIC_CLASSES},
        "priority_cap_pct": _clamp(qos["priority_cap_pct"], 5, 100, 33),
    }

    flows = raw.get("flows")
    if flows is None:
        flows = []
    cfg["flows"] = [normalize_flow(f, i) for i, f in enumerate(flows[:200])]
    ids = set()
    for f in cfg["flows"]:  # identifiants uniques
        base, k = f["id"], 2
        while f["id"] in ids:
            f["id"] = f"{base}-{k}"
            k += 1
        ids.add(f["id"])
    return cfg


def effective_scheduler(cfg: dict) -> str:
    return cfg["qos"]["scheduler"] if cfg["qos"]["enabled"] else "fifo"


def offered_load(cfg: dict) -> dict:
    """Charge offerte par classe (Mbit/s) et taux d'utilisation théorique."""
    per_class = {c: 0.0 for c in TRAFFIC_CLASSES}
    for f in cfg["flows"]:
        if f.get("enabled", True):
            per_class[f["type"]] += flow_rate_bps(f) / 1e6
    total = sum(per_class.values())
    bw = cfg["network"]["bandwidth_mbps"]
    return {
        "per_class": {k: round(v, 3) for k, v in per_class.items()},
        "total_mbps": round(total, 3),
        "capacity_mbps": bw,
        "utilization": round(total / bw, 4) if bw else 0.0,
    }


def meta() -> dict:
    return {
        "classes": list(TRAFFIC_CLASSES),
        "codecs": {k: {"label": v["label"], "ip_kbps": round(codec_ip_bps(k) / 1000, 1),
                       "ptime_ms": v["ptime"] * 1000} for k, v in CODECS.items()},
        "video_profiles": VIDEO_PROFILES,
        "schedulers": SCHEDULERS,
        "dscp": DSCP,
        "thresholds": THRESHOLDS,
        "defaults": {"config": DEFAULT_CONFIG, "flow": FLOW_DEFAULTS},
    }
