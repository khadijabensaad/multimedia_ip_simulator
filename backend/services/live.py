"""
Sessions de simulation en temps réel.

Le temps simulé avance par petites tranches (ex. 0,2 s × vitesse) à chaque
« tick » ; chaque tick renvoie les nouvelles fenêtres de mesure, l'état du
routeur et les alertes déclenchées. Les paramètres (QoS, bande passante,
flux…) peuvent être modifiés à chaud pendant la simulation.
"""

from __future__ import annotations

import threading
import time
import uuid

from ..config import THRESHOLDS, TRAFFIC_CLASSES
from ..qos.advisor import analyze
from ..qos.mos import metric_status
from ..simulation.simulator import Simulation

MAX_SESSIONS = 20
SESSION_TTL = 600  # s sans activité

CLASS_FR = {"voice": "Voix", "video": "Vidéo", "data": "Data"}
METRIC_FR = {"latency": "latence", "jitter": "jitter", "loss": "pertes"}
UNIT = {"latency": "ms", "jitter": "ms", "loss": "%"}


class LiveSession:
    def __init__(self, cfg: dict, speed: float = 1.0):
        self.id = uuid.uuid4().hex[:12]
        self.sim = Simulation(cfg)
        self.speed = speed
        self.created = time.time()
        self.touched = time.time()
        self.lock = threading.Lock()
        self.status = {(c, m): "good" for c in TRAFFIC_CLASSES for m in THRESHOLDS[c]}
        self.congested = False
        self.alert_seq = 0
        self.recent = []  # fenêtres récentes pour lisser les alertes

    def _alert(self, severity, title, detail, cls=None):
        self.alert_seq += 1
        return {"id": self.alert_seq, "t": round(self.sim.now, 2), "severity": severity,
                "title": title, "detail": detail, "class": cls}

    def _alerts_for(self, windows):
        alerts = []
        self.recent.extend(windows)
        self.recent = self.recent[-4:]  # ≈ 1 s glissante
        if not self.recent:
            return alerts
        for c in TRAFFIC_CLASSES:
            groups = [w["classes"][c] for w in self.recent if w["classes"][c]["recv"]]
            if not groups:
                continue
            n = sum(g["recv"] for g in groups)
            vals = {
                "latency": sum(g["latency"] * g["recv"] for g in groups) / n,
                "jitter": sum(g["jitter"] * g["recv"] for g in groups) / n,
                "loss": sum(w["classes"][c]["drops"] for w in self.recent) * 100 /
                        max(1, sum(w["classes"][c]["drops"] + w["classes"][c]["recv"] for w in self.recent)),
            }
            for m, v in vals.items():
                st = metric_status(c, m, v)
                prev = self.status[(c, m)]
                if st != prev:
                    self.status[(c, m)] = st
                    good, crit = THRESHOLDS[c][m]
                    if st == "good":
                        alerts.append(self._alert("success", f"{CLASS_FR[c]} — {METRIC_FR[m]} : retour à la normale",
                                                  f"{v:.1f} {UNIT[m]} (≤ {good:g} {UNIT[m]})", c))
                    elif st == "warn" and prev == "good":
                        alerts.append(self._alert("warn", f"{CLASS_FR[c]} — {METRIC_FR[m]} : seuil dépassé",
                                                  f"{v:.1f} {UNIT[m]} — seuil {good:g} {UNIT[m]} dépassé", c))
                    elif st == "critical":
                        alerts.append(self._alert("critical", f"{CLASS_FR[c]} — {METRIC_FR[m]} : niveau critique",
                                                  f"{v:.1f} {UNIT[m]} — au-delà de {crit:g} {UNIT[m]}", c))
        util = sum(w["utilization"] for w in self.recent) / len(self.recent)
        drops = sum(w["classes"]["all"]["drops"] for w in self.recent)
        congested = util > 0.97 and drops > 0
        if congested != self.congested:
            self.congested = congested
            if congested:
                alerts.append(self._alert("critical", "Congestion du lien",
                                          f"Utilisation {util * 100:.0f} %, {drops} paquets rejetés en 1 s"))
            else:
                alerts.append(self._alert("success", "Congestion résorbée", f"Utilisation {util * 100:.0f} %"))
        return alerts

    def step(self, wall_dt: float | None = None, sim_dt: float | None = None) -> dict:
        with self.lock:
            self.touched = time.time()
            dt = sim_dt if sim_dt is not None else (wall_dt or 0.2) * self.speed
            dt = max(0.01, min(dt, 5.0))
            windows = self.sim.advance(dt)
            return {"type": "tick", "session": self.id, "t": round(self.sim.now, 3),
                    "windows": windows, "state": self.sim.state(), "alerts": self._alerts_for(windows)}

    def patch(self, patch: dict) -> dict:
        with self.lock:
            self.touched = time.time()
            if "speed" in patch:
                self.speed = max(0.25, min(float(patch["speed"]), 20.0))
            cfg_patch = {k: v for k, v in patch.items() if k in ("network", "qos", "flows", "name")}
            if cfg_patch:
                self.sim.apply_patch(cfg_patch)
            return {"type": "patched", "config": self.sim.cfg, "state": self.sim.state(), "speed": self.speed}

    def finish(self) -> dict:
        with self.lock:
            summary = self.sim.summary()
            return {"type": "summary", "config": self.sim.cfg, "summary": summary,
                    "advisor": analyze(self.sim.cfg, summary), "timeline": list(self.sim.collector.timeline)}


class SessionManager:
    def __init__(self):
        self.sessions: dict[str, LiveSession] = {}
        self.lock = threading.Lock()

    def _gc(self):
        now = time.time()
        for sid in [s for s, sess in self.sessions.items() if now - sess.touched > SESSION_TTL]:
            self.sessions.pop(sid, None)
        while len(self.sessions) >= MAX_SESSIONS:
            oldest = min(self.sessions.values(), key=lambda s: s.touched)
            self.sessions.pop(oldest.id, None)

    def create(self, cfg, speed=1.0) -> LiveSession:
        with self.lock:
            self._gc()
            s = LiveSession(cfg, speed)
            self.sessions[s.id] = s
            return s

    def get(self, sid) -> LiveSession | None:
        return self.sessions.get(sid)

    def delete(self, sid):
        self.sessions.pop(sid, None)


sessions = SessionManager()


# ----------------------------------------------------------------------------
# Boucle WebSocket (indépendante du framework : `ws` doit fournir
# receive_json / send_json asynchrones, comme starlette.websockets.WebSocket)
# ----------------------------------------------------------------------------
TICK = 0.2  # s réelles entre deux mises à jour


async def live_ws_loop(ws, on_finish=None):
    """Protocole :
        client → {"type": "start", "config": {...}, "speed": 1}
                 {"type": "patch", "qos": {...}, "network": {...}, "flows": [...], "speed": 2}
                 {"type": "pause"} | {"type": "resume"} | {"type": "stop"}
        serveur → started | tick | patched | paused | resumed | summary | error
    """
    import asyncio

    inbox: asyncio.Queue = asyncio.Queue()

    async def reader():
        try:
            while True:
                inbox.put_nowait(await ws.receive_json())
        except Exception:
            inbox.put_nowait({"type": "_closed"})

    reader_task = asyncio.create_task(reader())
    session = None
    running = False
    last = time.perf_counter()
    try:
        while True:
            timeout = max(0.0, TICK - (time.perf_counter() - last)) if running else None
            try:
                msg = await asyncio.wait_for(inbox.get(), timeout=timeout)
            except asyncio.TimeoutError:
                msg = None
            if msg is not None:
                kind = msg.get("type")
                if kind == "_closed":
                    break
                try:
                    if kind == "start":
                        if session:
                            sessions.delete(session.id)
                        session = sessions.create(msg.get("config") or {}, float(msg.get("speed", 1)))
                        running = True
                        last = time.perf_counter()
                        await ws.send_json({"type": "started", "session": session.id,
                                            "config": session.sim.cfg, "state": session.sim.state()})
                    elif kind == "patch" and session:
                        await ws.send_json(session.patch({k: v for k, v in msg.items() if k != "type"}))
                    elif kind == "pause" and session:
                        running = False
                        await ws.send_json({"type": "paused", "t": session.sim.now})
                    elif kind == "resume" and session:
                        running = True
                        last = time.perf_counter()
                        await ws.send_json({"type": "resumed", "t": session.sim.now})
                    elif kind == "stop" and session:
                        running = False
                        out = await asyncio.to_thread(session.finish)
                        if on_finish and session.sim.now > 1:
                            out["history_id"] = on_finish(out)
                        sessions.delete(session.id)
                        session = None
                        await ws.send_json(out)
                    elif kind == "ping":
                        await ws.send_json({"type": "pong"})
                except Exception as e:  # erreur de configuration : on la signale sans fermer la socket
                    await ws.send_json({"type": "error", "message": str(e)})
            now = time.perf_counter()
            if session and running and now - last >= TICK - 1e-3:
                wall = min(now - last, 0.5)
                last = now
                tick = await asyncio.to_thread(session.step, wall)
                await ws.send_json(tick)
    finally:
        reader_task.cancel()
        if session:
            sessions.delete(session.id)
