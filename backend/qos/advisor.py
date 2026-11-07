"""
QoS Smart Advisor — système expert à base de règles.

Analyse le résumé d'une simulation, établit un diagnostic (causes probables de
la dégradation) et propose des recommandations chiffrées. Chaque recommandation
« applicable » contient un patch de configuration : l'application peut donc
rejouer automatiquement la simulation avec les corrections pour mesurer le gain.
"""

from __future__ import annotations

import copy
import math

from ..config import THRESHOLDS, VIDEO_PROFILES, codec_ip_bps, effective_scheduler, offered_load

SEVERITY_ORDER = {"critical": 0, "warn": 1, "info": 2, "success": 3}


def _round_up(x, step):
    return max(step, math.ceil(x / step) * step)


def analyze(cfg: dict, summary: dict) -> dict:
    findings = []
    recs = []
    cls = summary["classes"]
    net = summary["network"]
    load = offered_load(cfg)
    sched = effective_scheduler(cfg)
    bw = cfg["network"]["bandwidth_mbps"]
    util = load["utilization"]
    voice, video, data = cls["voice"], cls["video"], cls["data"]
    total_drops_buffer = net["drops"]["buffer"]
    all_sent = max(1, summary["all"]["sent"])
    buffer_loss = total_drops_buffer / all_sent * 100

    def bad(c, metric):
        return cls[c]["active"] and cls[c]["status"].get(metric) in ("warn", "critical")

    voice_bad = any(bad("voice", m) for m in ("latency", "jitter", "loss"))
    video_bad = any(bad("video", m) for m in ("latency", "jitter", "loss"))
    congested = util > 0.95 or buffer_loss > 0.5 or net["utilization_avg"] > 0.97

    # ------------------------------------------------------------------ diagnostic
    if congested:
        findings.append({
            "severity": "critical" if util > 1.0 or buffer_loss > 2 else "warn",
            "title": "Congestion détectée",
            "detail": f"Trafic offert {load['total_mbps']:.1f} Mbit/s pour {bw:g} Mbit/s disponibles "
                      f"({util * 100:.0f} % de la capacité). {total_drops_buffer} paquets rejetés par le buffer.",
        })
    for c, label in (("voice", "Voix"), ("video", "Vidéo"), ("data", "Data")):
        g = cls[c]
        if not g["active"] or not g["recv"]:
            continue
        issues = []
        if g["status"]["latency"] != "good":
            issues.append(f"latence {g['latency']:.0f} ms (seuil {THRESHOLDS[c]['latency'][0]:.0f})")
        if g["status"]["jitter"] != "good":
            issues.append(f"jitter {g['jitter']:.1f} ms (seuil {THRESHOLDS[c]['jitter'][0]:.0f})")
        if g["status"]["loss"] != "good":
            issues.append(f"pertes {g['loss']:.2f} % (seuil {THRESHOLDS[c]['loss'][0]:g})")
        if issues:
            findings.append({"severity": g["overall"], "title": f"{label} dégradée", "detail": ", ".join(issues) + "."})

    vq = summary.get("voice_quality")
    if vq and vq["mos"] < 4.0:
        findings.append({"severity": "critical" if vq["mos"] < 3.6 else "warn",
                         "title": f"MOS estimé {vq['mos']:.2f} — qualité {vq['label'].lower()}",
                         "detail": "La qualité perçue des appels est insuffisante (objectif ≥ 4,0)."})

    bd = summary["latency_breakdown"]
    q_voice = bd["voice"]["queueing"] if voice["recv"] else 0
    q_max_class = max((bd[c]["queueing"] for c in bd if cls[c]["recv"]), default=0)
    if q_max_class > 50:
        findings.append({"severity": "warn", "title": "Délai de mise en file élevé",
                         "detail": f"Jusqu'à {q_max_class:.0f} ms passés dans la file du routeur : le buffer amplifie la latence (bufferbloat)."})
    if cfg["network"]["base_latency_ms"] >= 100:
        findings.append({"severity": "info", "title": "Latence de propagation importante",
                         "detail": f"{cfg['network']['base_latency_ms']:g} ms de délai de base : la QoS ne réduit pas la propagation."})
    if cfg["network"]["loss_pct"] >= 1:
        findings.append({"severity": "warn" if cfg["network"]["loss_pct"] < 5 else "critical",
                         "title": "Pertes sur le lien physique",
                         "detail": f"{cfg['network']['loss_pct']:g} % de pertes aléatoires sur le lien, indépendantes de la congestion."})
    if sched == "priority" and data["active"] and data["offered"] > 0 and data["throughput"] < 0.3 * data["offered"]:
        findings.append({"severity": "warn", "title": "Famine du trafic data",
                         "detail": "La priorité stricte laisse très peu de bande passante au trafic best-effort."})

    tcp_flows = [f for f in cfg["flows"] if f["type"] == "data" and f.get("protocol") == "tcp" and f.get("enabled", True)]
    if tcp_flows and data["recv"] and data["throughput"] < 0.6 * data["offered"] and (
            cfg["network"]["loss_pct"] >= 0.5 or cfg["network"]["base_latency_ms"] >= 80):
        findings.append({"severity": "info", "title": "Débit TCP limité par le RTT et les pertes",
                         "detail": f"TCP n'obtient que {data['throughput']:.1f} Mbit/s sur {data['offered']:.1f} demandés : "
                                   "son débit est ≈ MSS / (RTT·√p) (formule de Mathis), il chute avec la latence et les pertes."})

    # ------------------------------------------------------------------ recommandations
    def add(rid, title, rationale, patch=None, impact="", category="qos"):
        recs.append({"id": rid, "title": title, "rationale": rationale, "patch": patch,
                     "applicable": patch is not None, "impact": impact, "category": category})

    if (voice_bad or (vq and vq["mos"] < 4.0) or (congested and voice["active"])) and sched == "fifo":
        add("enable_llq", "Donner la priorité haute au trafic VoIP (LLQ)",
            "Placer la voix (DSCP EF) dans une file prioritaire stricte et partager le reste en CBWFQ "
            "(vidéo AF41, data best-effort). La voix ne subit plus l'attente derrière les gros paquets.",
            {"qos": {"enabled": True, "scheduler": "llq"}}, "Latence et pertes voix fortement réduites")
    elif sched == "priority" and data["active"] and data["throughput"] < 0.3 * max(data["offered"], 1e-9):
        add("use_llq", "Passer de la priorité stricte à LLQ",
            "LLQ conserve la priorité de la voix mais garantit une part minimale de bande passante à la vidéo et à la data.",
            {"qos": {"enabled": True, "scheduler": "llq"}}, "Fin de la famine du trafic data")

    if voice["active"] and voice["drops_detail"]["policer"] > 0:
        cap = cfg["qos"]["priority_cap_pct"]
        need = voice["offered"] / bw * 100 * 1.2
        add("raise_priority_cap", "Augmenter la bande passante réservée à la file prioritaire",
            f"Le policer LLQ ({cap:g} % du lien) rejette des paquets voix ; il faut au moins {need:.0f} %.",
            {"qos": {"priority_cap_pct": min(100, _round_up(need, 5))}}, "Supprime les rejets du policer voix")

    if util > 0.9 and (congested or video_bad or voice_bad):
        new_bw = _round_up(load["total_mbps"] * 1.25, 5 if load["total_mbps"] > 10 else 1)
        add("increase_bandwidth", f"Augmenter la bande passante à {new_bw:g} Mbit/s",
            f"Le trafic offert ({load['total_mbps']:.1f} Mbit/s) dépasse {util * 100:.0f} % de la capacité. "
            "Une marge de 25 % absorbe les rafales vidéo.",
            {"network": {"bandwidth_mbps": new_bw}}, "Supprime la congestion à la source", "capacity")

    video_share = load["per_class"]["video"] / max(load["total_mbps"], 1e-9)
    if video["active"] and util > 0.9 and video_share > 0.4:
        target_video = max(0.5, load["per_class"]["video"] - (load["total_mbps"] - 0.85 * bw))
        factor = max(0.25, min(0.9, target_video / load["per_class"]["video"]))
        updates = {f["id"]: {"rate_mbps": round(f["rate_mbps"] * factor, 2), "profile": "custom"}
                   for f in cfg["flows"] if f["type"] == "video"}
        sample = next(iter(updates.values()), None)
        prof = min(VIDEO_PROFILES, key=lambda k: abs(VIDEO_PROFILES[k] - sample["rate_mbps"])) if sample else "720p"
        add("reduce_video_bitrate", f"Réduire le débit vidéo de {100 - factor * 100:.0f} %",
            f"La vidéo représente {video_share * 100:.0f} % du trafic. Un encodage plus léger (≈ {prof}) "
            "ou un streaming adaptatif (ABR) libère de la capacité.",
            {"flow_updates": updates}, "Moins de rafales, moins de pertes vidéo", "traffic")

    voice_g711 = [f for f in cfg["flows"] if f["type"] == "voice" and f["codec"] == "G.711"]
    if voice_g711 and congested and load["per_class"]["voice"] / bw > 0.1:
        updates = {f["id"]: {"codec": "G.729"} for f in voice_g711}
        saving = sum(f["calls"] for f in voice_g711) * (codec_ip_bps("G.711") - codec_ip_bps("G.729")) / 1e6
        add("use_g729", "Utiliser un codec voix compressé (G.729)",
            f"G.729 consomme 24 kbit/s par appel au lieu de 80 kbit/s : économie de {saving:.1f} Mbit/s, "
            "au prix d'une légère baisse de qualité intrinsèque (Ie = 11).",
            {"flow_updates": updates}, f"−{saving:.1f} Mbit/s de trafic voix", "traffic")

    buf = cfg["network"]["buffer_pkts"]
    if q_max_class > 50 and buf > 50:
        new_buf = max(32, int(buf / 2))
        add("reduce_buffer", f"Réduire le buffer à {new_buf} paquets (gestion de file)",
            "Un buffer trop grand garde les paquets en attente au lieu de signaler la congestion à TCP. "
            "Le réduire (ou activer une AQM type RED/CoDel) limite la latence.",
            {"network": {"buffer_pkts": new_buf}}, "Latence de file divisée", "queue")
    elif buffer_loss > 1 and q_max_class < 20 and not congested:
        new_buf = min(2000, buf * 2)
        add("increase_buffer", f"Augmenter le buffer à {new_buf} paquets",
            "Les rafales sont rejetées alors que la latence de file est faible : un buffer plus grand les absorberait.",
            {"network": {"buffer_pkts": new_buf}}, "Moins de pertes en rafale", "queue")

    if cfg["network"]["loss_pct"] >= 1:
        add("fix_link", "Fiabiliser le lien (FEC, PLC, diagnostic physique)",
            "Les pertes aléatoires viennent du lien (radio, câble, interférences). Corriger le lien ou ajouter "
            "une correction d'erreurs (FEC) côté vidéo et la dissimulation de pertes (PLC) côté voix.",
            {"network": {"loss_pct": round(cfg["network"]["loss_pct"] / 10, 2)}}, "Pertes du lien ÷ 10", "link")
    if cfg["network"]["base_latency_ms"] >= 100:
        add("edge_servers", "Rapprocher les serveurs (CDN / edge computing)",
            "Le délai de propagation ne dépend pas de la QoS : seul un chemin plus court le réduit.",
            {"network": {"base_latency_ms": round(cfg["network"]["base_latency_ms"] / 3)}}, "Délai de base ÷ 3", "link")

    if not findings:
        findings.append({"severity": "success", "title": "Réseau sain",
                         "detail": "Tous les indicateurs respectent les seuils ITU-T / Cisco pour la voix, la vidéo et la data."})
    if not recs:
        add("none", "Aucune action nécessaire",
            "La configuration actuelle respecte les objectifs de QoS. Vous pouvez tester un scénario plus chargé.")

    findings.sort(key=lambda f: SEVERITY_ORDER.get(f["severity"], 9))
    health = summary["health"]
    headline = {
        "good": "Le réseau fonctionne dans de bonnes conditions.",
        "warn": "Le réseau est dégradé : certaines applications sont affectées.",
        "critical": "Le réseau est fortement dégradé : action nécessaire.",
    }[health["status"]]
    return {"health": health, "headline": headline, "findings": findings, "recommendations": recs,
            "scenario": cfg.get("name")}


def apply_recommendations(cfg: dict, recommendations: list, ids=None) -> tuple[dict, list]:
    """Applique les patchs des recommandations sélectionnées à une copie de la configuration.

    ids=None : sélection par défaut = mesures de QoS et de gestion de file (sans ajout de capacité).
    """
    new = copy.deepcopy(cfg)
    applied = []
    for r in recommendations:
        if not r.get("applicable"):
            continue
        if ids is None and r["category"] not in ("qos", "queue"):
            continue
        if ids is not None and r["id"] not in ids:
            continue
        p = r["patch"]
        for key in ("network", "qos"):
            if key in p:
                new[key] = {**new[key], **p[key]}
        for fid, upd in (p.get("flow_updates") or {}).items():
            for f in new["flows"]:
                if f["id"] == fid:
                    f.update(upd)
        applied.append(r["id"])
    return new, applied
