"""
Services de haut niveau : simulation simple, comparaison QoS, balayage de
paramètres et optimisation automatique par le Smart Advisor.
"""

from __future__ import annotations

import copy

from ..config import SCHEDULERS, TRAFFIC_CLASSES, normalize_config, offered_load
from ..qos.advisor import analyze, apply_recommendations
from ..qos.metrics import calculate_improvement
from ..scenarios.presets import SWEEP_PARAMS, apply_sweep_value
from ..simulation.simulator import Simulation

SCHED_LABEL = {
    "fifo": "Sans QoS (FIFO)",
    "priority": "Priorité stricte (PQ)",
    "wfq": "WFQ pondéré",
    "llq": "Avec QoS (LLQ)",
}


def simulate(cfg: dict) -> dict:
    cfg = normalize_config(cfg)
    result = Simulation(cfg).run()
    result["advisor"] = analyze(result["config"], result["summary"])
    result["offered"] = offered_load(result["config"])
    return result


def _variant_config(cfg, scheduler):
    c = copy.deepcopy(cfg)
    if scheduler == "fifo":
        c["qos"]["enabled"] = False
    else:
        c["qos"]["enabled"] = True
        c["qos"]["scheduler"] = scheduler
    return normalize_config(c)


def _improvements(before: dict, after: dict) -> dict:
    out = {}
    for c in TRAFFIC_CLASSES:
        b, a = before["classes"][c], after["classes"][c]
        if not b["recv"] and not a["recv"]:
            continue
        row = {}
        for m in ("latency", "latency_p95", "jitter", "loss"):
            bv, av = b.get(m), a.get(m)
            row[m] = {"before": bv, "after": av,
                      "improvement": calculate_improvement(bv, av) if bv is not None and av is not None else None}
        row["throughput"] = {"before": b["throughput"], "after": a["throughput"],
                             "improvement": -calculate_improvement(b["throughput"], a["throughput"]) if b["throughput"] else None}
        out[c] = row
    vb, va = before.get("voice_quality"), after.get("voice_quality")
    if vb and va:
        out["mos"] = {"before": vb["mos"], "after": va["mos"], "delta": round(va["mos"] - vb["mos"], 2)}
    hb, ha = before["health"]["score"], after["health"]["score"]
    out["health"] = {"before": hb, "after": ha, "delta": round(ha - hb, 1)}
    return out


def compare(cfg: dict, schedulers=None) -> dict:
    """Exécute le même scénario (même graine aléatoire) avec plusieurs politiques de file."""
    cfg = normalize_config(cfg)
    if not schedulers:
        target = cfg["qos"]["scheduler"] if cfg["qos"]["scheduler"] in SCHEDULERS else "llq"
        schedulers = ["fifo", target]
    schedulers = [s for s in schedulers if s in SCHEDULERS][:4] or ["fifo", "llq"]
    runs = []
    for s in schedulers:
        vc = _variant_config(cfg, s)
        r = Simulation(vc).run()
        runs.append({"scheduler": s, "label": SCHED_LABEL[s], "config": vc,
                     "summary": r["summary"], "timeline": r["timeline"]})
    baseline, best = runs[0], runs[-1]
    return {
        "config": cfg,
        "offered": offered_load(cfg),
        "runs": runs,
        "improvement": _improvements(baseline["summary"], best["summary"]),
        "advisor": analyze(baseline["config"], baseline["summary"]),
        "advisor_after": analyze(best["config"], best["summary"]),
    }


def _compact(summary):
    out = {"health": summary["health"]["score"], "utilization": summary["network"]["utilization_avg"]}
    for c in TRAFFIC_CLASSES:
        g = summary["classes"][c]
        out[c] = {k: g.get(k) for k in ("latency", "latency_p95", "jitter", "loss", "throughput", "offered")}
    out["mos"] = summary["voice_quality"]["mos"] if summary.get("voice_quality") else None
    out["frame_integrity"] = summary["video_quality"]["frame_integrity"] if summary.get("video_quality") else None
    out["goodput"] = summary["data_quality"]["goodput_mbps"] if summary.get("data_quality") else None
    return out


def sweep(cfg: dict, param: str, values: list, with_qos_comparison: bool = True, duration=None) -> dict:
    if param not in SWEEP_PARAMS:
        raise ValueError(f"Paramètre inconnu : {param}")
    cfg = normalize_config(cfg)
    if duration:
        cfg["duration"] = duration
    else:
        cfg["duration"] = min(cfg["duration"], 12)
    values = [v for v in values][:8]
    modes = ["fifo", cfg["qos"]["scheduler"]] if with_qos_comparison else [
        cfg["qos"]["scheduler"] if cfg["qos"]["enabled"] else "fifo"]
    points = []
    for v in values:
        c = apply_sweep_value(cfg, param, v)
        entry = {"value": v, "offered_mbps": offered_load(c)["total_mbps"], "modes": {}}
        for m in modes:
            r = Simulation(_variant_config(c, m)).run()
            entry["modes"][m] = _compact(r["summary"])
        points.append(entry)
    return {"param": param, "label": SWEEP_PARAMS[param], "values": values, "modes": modes,
            "mode_labels": {m: SCHED_LABEL[m] for m in modes}, "points": points, "config": cfg}


OPTIMIZATION_STAGES = [
    ("Politique QoS & files", ("qos", "queue")),
    ("Adaptation du trafic", ("traffic",)),
    ("Capacité du lien", ("capacity",)),
    ("Qualité du lien", ("link",)),
]
TARGET_HEALTH = 85


def optimize(cfg: dict, ids=None) -> dict:
    """Simule, applique les recommandations du Smart Advisor puis re-simule.

    * ids fournis : applique exactement ces recommandations ;
    * sinon : plan progressif — on commence par les mesures « gratuites » (QoS, files),
      puis on n'ajoute l'adaptation du trafic, la capacité, etc. que si l'objectif
      de santé (85/100) n'est pas atteint. On retient la meilleure étape.
    """
    before = simulate(cfg)
    recs = before["advisor"]["recommendations"]
    stages = []
    if ids is not None:
        new_cfg, applied = apply_recommendations(before["config"], recs, list(ids))
        new_cfg["name"] = f"{before['config']['name']} — optimisé"
        after = simulate(new_cfg)
        stages.append({"label": "Sélection manuelle", "applied": applied,
                       "health": after["summary"]["health"]["score"],
                       "mos": (after["summary"].get("voice_quality") or {}).get("mos")})
    else:
        after, applied, chosen = before, [], set()
        best_score = before["summary"]["health"]["score"]
        for label, cats in OPTIMIZATION_STAGES:
            if best_score >= TARGET_HEALTH and stages:
                break
            if best_score >= 99:
                break
            stage_ids = [r["id"] for r in recs if r.get("applicable") and r["category"] in cats]
            if not stage_ids:
                continue
            trial_ids = list(chosen | set(stage_ids))
            trial_cfg, trial_applied = apply_recommendations(before["config"], recs, trial_ids)
            trial_cfg["name"] = f"{before['config']['name']} — optimisé"
            trial = simulate(trial_cfg)
            score = trial["summary"]["health"]["score"]
            stages.append({"label": label, "applied": stage_ids, "health": score,
                           "mos": (trial["summary"].get("voice_quality") or {}).get("mos"),
                           "kept": score >= best_score})
            if score >= best_score:  # on ne garde une étape que si elle améliore la santé
                best_score = score
                chosen = set(trial_ids)
                after, applied = trial, trial_applied
            if best_score >= TARGET_HEALTH:
                break
    return {
        "before": before,
        "after": after,
        "applied": [r for r in recs if r["id"] in applied],
        "stages": stages,
        "improvement": _improvements(before["summary"], after["summary"]),
        "optimized_config": after["config"],
    }
