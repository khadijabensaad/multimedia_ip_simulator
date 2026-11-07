"""
Logique des endpoints, indépendante du framework web.

Utilisée à la fois par l'application FastAPI (backend/app.py) et par le
serveur léger sans dépendance (backend/lite_server.py).
"""

from __future__ import annotations

from .. import config as conf
from ..qos.advisor import analyze
from ..scenarios import presets as P
from ..services import history, reports
from ..services import simulation_service as svc
from ..services.live import sessions

VERSION = "2.0.0"


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _cfg(body):
    if not isinstance(body, dict):
        raise ApiError(400, "Corps JSON attendu")
    cfg = body.get("config", body)
    if "preset" in body and "config" not in body and isinstance(body["preset"], str) and not body.get("flows"):
        cfg = P.get_preset_config(body["preset"])
        if cfg is None:
            raise ApiError(404, "Scénario inconnu")
    try:
        return conf.normalize_config(cfg)
    except ValueError as e:
        raise ApiError(422, str(e))


def _save(body, kind, payload):
    if body.get("save", True):
        try:
            return history.save(kind, payload)
        except Exception:  # l'historique ne doit jamais bloquer une simulation
            return None
    return None


def _require_flows(cfg):
    if not any(f.get("enabled", True) for f in cfg["flows"]):
        raise ApiError(422, "Ajoutez au moins un flux actif (voix, vidéo ou data).")


# ------------------------------------------------------------------ lecture
def health():
    return {"status": "ok", "version": VERSION, "pdf": reports.pdf_available()}


def meta():
    m = conf.meta()
    m["sweep_params"] = P.SWEEP_PARAMS
    m["pdf"] = reports.pdf_available()
    m["version"] = VERSION
    return m


def presets():
    return {"presets": P.list_presets()}


def preset(preset_id):
    p = P.get_preset(preset_id)
    if not p:
        raise ApiError(404, "Scénario inconnu")
    return {**{k: v for k, v in p.items() if k != "config"}, "config": P.get_preset_config(preset_id)}


def preview(body):
    """Charge offerte / utilisation théorique d'une configuration (Scenario Builder)."""
    return conf.offered_load(_cfg(body))


# ------------------------------------------------------------------ simulations
def simulate(body):
    cfg = _cfg(body)
    _require_flows(cfg)
    result = svc.simulate(cfg)
    result["history_id"] = _save(body, "simulation", result)
    return result


def compare(body):
    cfg = _cfg(body)
    _require_flows(cfg)
    result = svc.compare(cfg, body.get("schedulers"))
    result["history_id"] = _save(body, "comparison", result)
    return result


def sweep(body):
    cfg = _cfg(body)
    _require_flows(cfg)
    param = body.get("param")
    values = body.get("values")
    if not values:
        p = P.get_preset(cfg.get("preset") or "")
        if p and p.get("sweep") and p["sweep"]["param"] == param:
            values = p["sweep"]["values"]
    if not param or not values:
        raise ApiError(422, "Paramètres « param » et « values » requis")
    try:
        values = [float(v) if param not in ("video_count", "voice_calls", "buffer_pkts") else int(float(v))
                  for v in values]
        result = svc.sweep(cfg, param, values, bool(body.get("compare_qos", True)), body.get("duration"))
    except ValueError as e:
        raise ApiError(422, str(e))
    result["history_id"] = _save(body, "sweep", result)
    return result


def optimize(body):
    cfg = _cfg(body)
    _require_flows(cfg)
    result = svc.optimize(cfg, body.get("recommendations"))
    result["history_id"] = _save(body, "optimization", result)
    return result


def advise(body):
    if "summary" not in body:
        raise ApiError(422, "« summary » requis")
    return analyze(_cfg(body), body["summary"])


# ------------------------------------------------------------------ historique & rapports
def history_list():
    return {"runs": history.list_runs()}


def history_get(rid):
    item = history.get(rid)
    if not item:
        raise ApiError(404, "Enregistrement introuvable")
    return item


def history_delete(rid):
    history.delete(rid)
    return {"deleted": rid}


def history_save(body):
    """Enregistre un résultat produit côté client (ex. fin d'une session live)."""
    kind = body.get("kind", "live")
    payload = body.get("payload")
    if not isinstance(payload, dict) or "config" not in payload:
        raise ApiError(422, "payload invalide")
    return {"id": history.save(kind, payload)}


def report_csv(rid):
    item = history_get(rid)
    return reports.to_csv(item), "text/csv; charset=utf-8", f"rapport-qos-{rid}.csv"


def report_pdf(rid):
    if not reports.pdf_available():
        raise ApiError(501, "ReportLab n'est pas installé : pip install reportlab")
    item = history_get(rid)
    return reports.to_pdf(item), "application/pdf", f"rapport-qos-{rid}.pdf"


# ------------------------------------------------------------------ live (REST, repli du WebSocket)
def live_create(body):
    cfg = _cfg(body)
    _require_flows(cfg)
    s = sessions.create(cfg, float(body.get("speed", 1.0)))
    return {"session": s.id, "config": s.sim.cfg, "state": s.sim.state()}


def _session(sid):
    s = sessions.get(sid)
    if not s:
        raise ApiError(404, "Session expirée")
    return s


def live_step(sid, body):
    s = _session(sid)
    return s.step(wall_dt=float(body.get("wall_dt", 0.2)) if body else 0.2,
                  sim_dt=float(body["sim_dt"]) if body and body.get("sim_dt") else None)


def live_patch(sid, body):
    return _session(sid).patch(body or {})


def live_finish(sid, body=None):
    s = _session(sid)
    out = s.finish()
    if (body or {}).get("save", True) and s.sim.now > 1:
        try:
            out["history_id"] = history.save("live", {k: out[k] for k in ("config", "summary", "advisor", "timeline")})
        except Exception:
            out["history_id"] = None
    sessions.delete(sid)
    return out
