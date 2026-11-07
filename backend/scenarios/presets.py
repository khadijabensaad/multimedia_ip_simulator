"""
Les 8 scénarios prédéfinis du laboratoire QoS.
Chaque scénario décrit son objectif pédagogique, les résultats attendus et,
le cas échéant, le paramètre à faire varier (balayage / sweep).
"""

from __future__ import annotations

import copy

from ..config import normalize_config


def _voice(fid, calls, codec="G.711", name="Appels VoIP"):
    return {"id": fid, "type": "voice", "name": name, "calls": calls, "codec": codec}


def _video(fid, rate, name="Streaming vidéo", profile="custom"):
    return {"id": fid, "type": "video", "name": name, "rate_mbps": rate, "profile": profile, "fps": 30}


def _data(fid, rate, protocol="tcp", name="Transfert de fichiers"):
    return {"id": fid, "type": "data", "name": name, "rate_mbps": rate, "protocol": protocol}


PRESETS = [
    {
        "id": "normal",
        "number": 1,
        "name": "Réseau normal",
        "level": "Facile",
        "tag": "Référence",
        "objective": "Montrer le comportement d'un réseau stable et correctement dimensionné.",
        "expected": "Latence faible, jitter faible, aucune congestion, MOS excellent.",
        "config": {
            "duration": 20,
            "network": {"bandwidth_mbps": 100, "base_latency_ms": 10, "jitter_ms": 1, "loss_pct": 0, "buffer_pkts": 200},
            "qos": {"enabled": False},
            "flows": [
                _voice("voice-1", 4, name="VoIP — Accueil"), _voice("voice-2", 4, name="VoIP — Support"),
                _video("video-1", 5, "Visioconférence 1080p", "1080p"),
                _data("data-1", 10, name="Navigation web"), _data("data-2", 8, name="Transfert FTP"),
                _data("data-3", 5, name="Messagerie / Cloud"),
            ],
        },
    },
    {
        "id": "congestion",
        "number": 2,
        "name": "Congestion réseau",
        "level": "Important",
        "tag": "Surcharge",
        "objective": "Observer ce qui se passe quand le trafic demandé (15 Mbit/s) dépasse la capacité (10 Mbit/s).",
        "expected": "File d'attente pleine, retards, pertes de paquets par débordement du buffer, indicateurs au rouge.",
        "config": {
            "duration": 20,
            "network": {"bandwidth_mbps": 10, "base_latency_ms": 10, "jitter_ms": 1, "loss_pct": 0, "buffer_pkts": 100},
            "qos": {"enabled": False},
            "flows": [
                _voice("voice-1", 25, name="Appels VoIP (≈2 Mbit/s)"),
                _video("video-1", 8, "Streaming vidéo (8 Mbit/s)"),
                _data("data-1", 5, "udp", "Sauvegarde UDP (5 Mbit/s)"),
            ],
        },
    },
    {
        "id": "video_overload",
        "number": 3,
        "name": "Surcharge streaming vidéo",
        "level": "Important",
        "tag": "Vidéo",
        "objective": "Plusieurs utilisateurs regardent des vidéos simultanément (1, 5, 10 ou 20 flux).",
        "expected": "Au-delà de la capacité, le trafic vidéo perturbe les appels VoIP et le trafic data.",
        "sweep": {"param": "video_count", "values": [1, 5, 10, 20], "label": "Nombre de flux vidéo"},
        "config": {
            "duration": 15,
            "network": {"bandwidth_mbps": 50, "base_latency_ms": 15, "jitter_ms": 1, "loss_pct": 0, "buffer_pkts": 150},
            "qos": {"enabled": False},
            "flows": [_voice("voice-1", 10)] + [_video(f"video-{i}", 4, f"Utilisateur vidéo {i}") for i in range(1, 11)]
                     + [_data("data-1", 10, name="Navigation web")],
        },
    },
    {
        "id": "voip_stress",
        "number": 4,
        "name": "VoIP sous stress",
        "level": "Important",
        "tag": "Voix",
        "objective": "Étudier la qualité d'un appel vocal (latence, jitter, pertes, MOS) pendant une congestion.",
        "expected": "TCP remplit le buffer surdimensionné (bufferbloat) : la latence voix dépasse 150 ms et le MOS chute sous 4.",
        "config": {
            "duration": 20,
            "network": {"bandwidth_mbps": 15, "base_latency_ms": 40, "jitter_ms": 6, "loss_pct": 0, "buffer_pkts": 400},
            "qos": {"enabled": False},
            "flows": [
                _voice("voice-1", 20, name="Centre d'appels (20 appels)"),
                _video("video-1", 5, "Webinaire HD"), _video("video-2", 5, "Vidéo à la demande"),
                _data("data-1", 8, name="Mise à jour logicielle"), _data("data-2", 8, name="Synchronisation cloud"),
            ],
        },
    },
    {
        "id": "qos_priority",
        "number": 5,
        "name": "Priorité QoS activée",
        "level": "Démonstration",
        "tag": "QoS",
        "objective": "Comparer le même réseau congestionné SANS QoS puis AVEC QoS (LLQ : voix prioritaire).",
        "expected": "Avec la QoS, la voix est protégée : latence et pertes voix proches de zéro, MOS excellent.",
        "compare": True,
        "config": {
            "duration": 20,
            "network": {"bandwidth_mbps": 10, "base_latency_ms": 10, "jitter_ms": 1, "loss_pct": 0, "buffer_pkts": 100},
            "qos": {"enabled": True, "scheduler": "llq", "weights": {"voice": 30, "video": 60, "data": 15}},
            "flows": [
                _voice("voice-1", 25, name="Appels VoIP (≈2 Mbit/s)"),
                _video("video-1", 8, "Streaming vidéo (8 Mbit/s)"),
                _data("data-1", 5, "tcp", "Transfert TCP (5 Mbit/s)"),
            ],
        },
    },
    {
        "id": "packet_loss",
        "number": 6,
        "name": "Simulation de pertes",
        "level": "Intermédiaire",
        "tag": "Pertes",
        "objective": "Simuler un lien avec un taux de perte contrôlé : 0 %, 1 %, 5 % ou 10 %.",
        "expected": "La QoS ne corrige pas les pertes du lien : le MOS et l'intégrité vidéo chutent rapidement.",
        "sweep": {"param": "loss_pct", "values": [0, 1, 5, 10], "label": "Taux de perte du lien (%)"},
        "config": {
            "duration": 15,
            "network": {"bandwidth_mbps": 50, "base_latency_ms": 20, "jitter_ms": 2, "loss_pct": 5, "buffer_pkts": 150},
            "qos": {"enabled": True, "scheduler": "llq"},
            "flows": [_voice("voice-1", 10), _video("video-1", 5, "Visioconférence 1080p", "1080p"),
                      _data("data-1", 10, name="Transfert TCP")],
        },
    },
    {
        "id": "latency",
        "number": 7,
        "name": "Réseau à forte latence",
        "level": "Intermédiaire",
        "tag": "Délai",
        "objective": "Simuler un réseau distant (satellite, intercontinental) : 10, 50, 100 ou 200 ms.",
        "expected": "Au-delà de 150 ms la voix se dégrade (ITU-T G.114) ; le débit TCP diminue avec le RTT.",
        "sweep": {"param": "base_latency_ms", "values": [10, 50, 100, 200], "label": "Latence de base (ms)"},
        "config": {
            "duration": 15,
            "network": {"bandwidth_mbps": 50, "base_latency_ms": 100, "jitter_ms": 3, "loss_pct": 0.2, "buffer_pkts": 150},
            "qos": {"enabled": True, "scheduler": "llq"},
            "flows": [_voice("voice-1", 10), _video("video-1", 5, "Visioconférence 1080p", "1080p"),
                      _data("data-1", 20, name="Transfert TCP")],
        },
    },
    {
        "id": "custom",
        "number": 8,
        "name": "Scénario personnalisé",
        "level": "Avancé",
        "tag": "Builder",
        "objective": "Créez votre propre scénario : flux, débits, bande passante, latence, buffer, QoS.",
        "expected": "À vous de jouer : le Smart Advisor analysera vos résultats.",
        "custom": True,
        "config": {
            "duration": 20,
            "network": {"bandwidth_mbps": 20, "base_latency_ms": 20, "jitter_ms": 1, "loss_pct": 1, "buffer_pkts": 100},
            "qos": {"enabled": False},
            "flows": [_voice("voice-1", 37, name="Appels VoIP"), _video("video-1", 5, "Streaming vidéo"),
                      _data("data-1", 8, name="Transfert de fichiers")],
        },
    },
]

_BY_ID = {p["id"]: p for p in PRESETS}


def list_presets():
    out = []
    for p in PRESETS:
        item = {k: v for k, v in p.items() if k != "config"}
        cfg = get_preset_config(p["id"])
        item["config"] = cfg
        out.append(item)
    return out


def get_preset(preset_id):
    return _BY_ID.get(preset_id)


def get_preset_config(preset_id):
    p = _BY_ID.get(preset_id)
    if p is None:
        return None
    cfg = copy.deepcopy(p["config"])
    cfg["name"] = p["name"]
    cfg["description"] = p["objective"]
    cfg["preset"] = p["id"]
    return normalize_config(cfg)


# --------------------------------------------------------------------------
# Balayage de paramètres (scénarios 3, 6, 7…)
# --------------------------------------------------------------------------
SWEEP_PARAMS = {
    "video_count": "Nombre de flux vidéo",
    "loss_pct": "Taux de perte (%)",
    "base_latency_ms": "Latence de base (ms)",
    "bandwidth_mbps": "Bande passante (Mbit/s)",
    "buffer_pkts": "Taille du buffer (paquets)",
    "voice_calls": "Nombre d'appels VoIP",
}


def apply_sweep_value(cfg, param, value):
    cfg = copy.deepcopy(cfg)
    if param in ("loss_pct", "base_latency_ms", "bandwidth_mbps", "buffer_pkts", "jitter_ms"):
        cfg["network"][param] = value
    elif param == "video_count":
        videos = [f for f in cfg["flows"] if f["type"] == "video"]
        others = [f for f in cfg["flows"] if f["type"] != "video"]
        template = videos[0] if videos else {"type": "video", "rate_mbps": 4, "fps": 30, "name": "Utilisateur vidéo"}
        n = int(value)
        new_videos = []
        for i in range(n):
            v = copy.deepcopy(videos[i] if i < len(videos) else template)
            v["id"] = f"video-{i + 1}"
            v["name"] = f"Utilisateur vidéo {i + 1}"
            new_videos.append(v)
        cfg["flows"] = others + new_videos
    elif param == "voice_calls":
        for f in cfg["flows"]:
            if f["type"] == "voice":
                f["calls"] = int(value)
                break
        else:
            cfg["flows"].append({"type": "voice", "calls": int(value), "codec": "G.711"})
    else:
        raise ValueError(f"Paramètre de balayage inconnu : {param}")
    return normalize_config(cfg)
