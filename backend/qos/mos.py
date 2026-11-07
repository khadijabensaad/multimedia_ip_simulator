"""
Estimation de la qualité perçue.

* Voix : MOS estimé par l'E-model (ITU-T G.107) simplifié.
  R = 93,2 − Id − Ie,eff     puis     MOS = 1 + 0,035·R + 7·10⁻⁶·R·(R−60)·(100−R)
  - Id : dégradation due au délai bouche-à-oreille (réseau + tampon de gigue + codec)
  - Ie,eff : dégradation due au codec et aux pertes (Ie, Bpl : ITU-T G.113)
  Le MOS affiché est une ESTIMATION calculée à partir des paramètres réseau simulés.
* Seuils et score de santé QoS par classe.
"""

from __future__ import annotations

from ..config import CODECS, THRESHOLDS


def r_factor(latency_ms: float, jitter_ms: float, loss_pct: float, codec: str = "G.711",
             burst_ratio: float = 1.0) -> float:
    c = CODECS.get(codec, CODECS["G.711"])
    jitter_buffer = max(20.0, 2.0 * jitter_ms)          # tampon de gigue adaptatif
    d = latency_ms + jitter_buffer + c["ptime"] * 1000 + c["codec_delay"] * 1000
    i_d = 0.024 * d + (0.11 * (d - 177.3) if d > 177.3 else 0.0)
    ppl = max(0.0, loss_pct)
    i_e_eff = c["ie"] + (95 - c["ie"]) * ppl / (ppl / burst_ratio + c["bpl"])
    return max(0.0, min(100.0, 93.2 - i_d - i_e_eff))


def mos_from_r(r: float) -> float:
    if r <= 0:
        return 1.0
    if r >= 100:
        return 4.5
    return 1 + 0.035 * r + r * (r - 60) * (100 - r) * 7e-6


def estimate_mos(latency_ms, jitter_ms, loss_pct, codec="G.711", burst_ratio=1.0):
    r = r_factor(latency_ms, jitter_ms, loss_pct, codec, burst_ratio)
    return round(mos_from_r(r), 2), round(r, 1)


def mos_label(mos: float) -> str:
    if mos >= 4.3:
        return "Excellente"
    if mos >= 4.0:
        return "Bonne"
    if mos >= 3.6:
        return "Correcte"
    if mos >= 3.1:
        return "Médiocre"
    return "Mauvaise"


def metric_status(cls: str, metric: str, value) -> str:
    if value is None:
        return "idle"
    good, crit = THRESHOLDS[cls][metric]
    if value <= good:
        return "good"
    if value <= crit:
        return "warn"
    return "critical"


def metric_score(cls: str, metric: str, value) -> float:
    """100 sous le seuil « bon », 50 au seuil critique, puis 25 à 2× le seuil critique, etc."""
    if value is None:
        return 100.0
    good, crit = THRESHOLDS[cls][metric]
    if value <= good:
        return 100.0
    if value <= crit:
        return 100 - 50 * (value - good) / (crit - good)
    return 50 * crit / value  # décroissance hyperbolique au-delà du seuil critique


CLASS_WEIGHT = {"voice": 0.4, "video": 0.35, "data": 0.25}


def class_score(cls, latency, jitter, loss):
    scores = [metric_score(cls, "latency", latency), metric_score(cls, "jitter", jitter),
              metric_score(cls, "loss", loss)]
    return min(scores) * 0.6 + sum(scores) / 3 * 0.4


def worst(statuses):
    order = ["idle", "good", "warn", "critical"]
    return max(statuses, key=order.index) if statuses else "idle"
