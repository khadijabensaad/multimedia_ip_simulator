"""
API FastAPI du Multimedia IP Network Simulator — QoS Lab.

    uvicorn backend.app:app --reload        (ou : python run.py)

Documentation interactive : http://localhost:8000/docs
"""

from __future__ import annotations

from pathlib import Path

from fastapi import Body, FastAPI, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .api import handlers as H
from .api.handlers import ApiError
from .services import history
from .services.live import live_ws_loop

FRONTEND_DIR = Path(__file__).resolve().parents[1] / "frontend"

app = FastAPI(
    title="Multimedia IP Network Simulator — QoS Lab",
    version=H.VERSION,
    description="Simulation de trafic voix / vidéo / data, mesure de la QoS (latence, jitter, débit, pertes, MOS) "
                "et comparaison des politiques de file d'attente (FIFO, PQ, WFQ, LLQ).",
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError):
    return JSONResponse({"detail": exc.message}, status_code=exc.status)


def _file(result):
    content, media_type, filename = result
    return Response(content, media_type=media_type,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ------------------------------------------------------------------ référentiel
@app.get("/api/health", tags=["système"])
def health():
    return H.health()


@app.get("/api/meta", tags=["système"])
def meta():
    """Codecs, profils vidéo, ordonnanceurs, DSCP et seuils QoS."""
    return H.meta()


@app.get("/api/presets", tags=["scénarios"])
def presets():
    return H.presets()


@app.get("/api/presets/{preset_id}", tags=["scénarios"])
def preset(preset_id: str):
    return H.preset(preset_id)


@app.post("/api/preview", tags=["scénarios"])
def preview(body: dict = Body(...)):
    return H.preview(body)


# ------------------------------------------------------------------ simulations
@app.post("/api/simulate", tags=["simulation"])
def simulate(body: dict = Body(...)):
    """Exécute une simulation complète et retourne résumé, séries temporelles et diagnostic."""
    return H.simulate(body)


@app.post("/api/compare", tags=["simulation"])
def compare(body: dict = Body(...)):
    """Même scénario, même graine, plusieurs ordonnanceurs (par défaut : FIFO vs LLQ)."""
    return H.compare(body)


@app.post("/api/sweep", tags=["simulation"])
def sweep(body: dict = Body(...)):
    """Fait varier un paramètre (pertes, latence, nombre de flux vidéo…)."""
    return H.sweep(body)


@app.post("/api/optimize", tags=["smart advisor"])
def optimize(body: dict = Body(...)):
    """Applique les recommandations du Smart Advisor et mesure le gain."""
    return H.optimize(body)


@app.post("/api/advisor", tags=["smart advisor"])
def advisor(body: dict = Body(...)):
    return H.advise(body)


# ------------------------------------------------------------------ historique & rapports
@app.get("/api/history", tags=["rapports"])
def history_list():
    return H.history_list()


@app.post("/api/history", tags=["rapports"])
def history_save(body: dict = Body(...)):
    return H.history_save(body)


@app.get("/api/history/{rid}", tags=["rapports"])
def history_get(rid: str):
    return H.history_get(rid)


@app.delete("/api/history/{rid}", tags=["rapports"])
def history_delete(rid: str):
    return H.history_delete(rid)


@app.get("/api/reports/{rid}.csv", tags=["rapports"])
def report_csv(rid: str):
    return _file(H.report_csv(rid))


@app.get("/api/reports/{rid}.pdf", tags=["rapports"])
def report_pdf(rid: str):
    return _file(H.report_pdf(rid))


# ------------------------------------------------------------------ temps réel
@app.post("/api/live", tags=["temps réel"])
def live_create(body: dict = Body(...)):
    return H.live_create(body)


@app.post("/api/live/{sid}/step", tags=["temps réel"])
def live_step(sid: str, body: dict = Body(default={})):
    return H.live_step(sid, body)


@app.patch("/api/live/{sid}", tags=["temps réel"])
def live_patch(sid: str, body: dict = Body(...)):
    return H.live_patch(sid, body)


@app.post("/api/live/{sid}/finish", tags=["temps réel"])
def live_finish(sid: str, body: dict = Body(default={})):
    return H.live_finish(sid, body)


def _save_live(out):
    try:
        return history.save("live", {k: out[k] for k in ("config", "summary", "advisor", "timeline")})
    except Exception:
        return None


@app.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    """Flux temps réel : ticks toutes les 200 ms, modifications de paramètres à chaud."""
    await ws.accept()
    await live_ws_loop(ws, on_finish=_save_live)


# ------------------------------------------------------------------ interface web
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
