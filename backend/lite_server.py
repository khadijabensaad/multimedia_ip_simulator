"""
Serveur de secours sans aucune dépendance (bibliothèque standard Python uniquement).

Il expose exactement la même API REST que FastAPI. Seul le WebSocket n'est pas
disponible : l'interface bascule alors automatiquement en mode « polling » REST.

    python -m backend.lite_server --port 8000
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import re
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .api import handlers as H
from .api.handlers import ApiError

FRONTEND_DIR = Path(__file__).resolve().parents[1] / "frontend"

ROUTES = [
    ("GET", r"/api/health", lambda m, b: H.health()),
    ("GET", r"/api/meta", lambda m, b: H.meta()),
    ("GET", r"/api/presets", lambda m, b: H.presets()),
    ("GET", r"/api/presets/(?P<id>[\w-]+)", lambda m, b: H.preset(m["id"])),
    ("POST", r"/api/preview", lambda m, b: H.preview(b)),
    ("POST", r"/api/simulate", lambda m, b: H.simulate(b)),
    ("POST", r"/api/compare", lambda m, b: H.compare(b)),
    ("POST", r"/api/sweep", lambda m, b: H.sweep(b)),
    ("POST", r"/api/optimize", lambda m, b: H.optimize(b)),
    ("POST", r"/api/advisor", lambda m, b: H.advise(b)),
    ("GET", r"/api/history", lambda m, b: H.history_list()),
    ("POST", r"/api/history", lambda m, b: H.history_save(b)),
    ("GET", r"/api/history/(?P<id>\w+)", lambda m, b: H.history_get(m["id"])),
    ("DELETE", r"/api/history/(?P<id>\w+)", lambda m, b: H.history_delete(m["id"])),
    ("GET", r"/api/reports/(?P<id>\w+)\.csv", lambda m, b: H.report_csv(m["id"])),
    ("GET", r"/api/reports/(?P<id>\w+)\.pdf", lambda m, b: H.report_pdf(m["id"])),
    ("POST", r"/api/live", lambda m, b: H.live_create(b)),
    ("POST", r"/api/live/(?P<id>\w+)/step", lambda m, b: H.live_step(m["id"], b)),
    ("PATCH", r"/api/live/(?P<id>\w+)", lambda m, b: H.live_patch(m["id"], b)),
    ("POST", r"/api/live/(?P<id>\w+)/finish", lambda m, b: H.live_finish(m["id"], b)),
]
COMPILED = [(meth, re.compile(f"^{pat}$"), fn) for meth, pat, fn in ROUTES]


class Handler(BaseHTTPRequestHandler):
    server_version = "QoSLab-lite/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/live"):
            super().log_message(fmt, *args)

    def _send(self, status, body: bytes, ctype="application/json; charset=utf-8", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _dispatch(self):
        path = urlparse(self.path).path
        if path.startswith("/ws/"):
            return self._json(426, {"detail": "WebSocket indisponible en mode lite"})
        if path.startswith("/api/"):
            body = {}
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                try:
                    body = json.loads(self.rfile.read(length) or b"{}")
                except json.JSONDecodeError:
                    return self._json(400, {"detail": "JSON invalide"})
            for meth, rx, fn in COMPILED:
                m = rx.match(path)
                if m and meth == self.command:
                    try:
                        out = fn(m.groupdict(), body)
                    except ApiError as e:
                        return self._json(e.status, {"detail": e.message})
                    except Exception as e:  # pragma: no cover
                        traceback.print_exc()
                        return self._json(500, {"detail": str(e)})
                    if isinstance(out, tuple):
                        content, ctype, filename = out
                        return self._send(200, content, ctype,
                                          {"Content-Disposition": f'attachment; filename="{filename}"'})
                    return self._json(200, out)
            return self._json(404, {"detail": "Route inconnue"})
        return self._static(path)

    def _static(self, path):
        rel = path.lstrip("/") or "index.html"
        target = (FRONTEND_DIR / rel).resolve()
        if FRONTEND_DIR.resolve() not in target.parents and target != FRONTEND_DIR.resolve():
            return self._json(403, {"detail": "Interdit"})
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            target = FRONTEND_DIR / "index.html"
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    do_GET = do_POST = do_PATCH = do_DELETE = do_HEAD = _dispatch


def serve(host="127.0.0.1", port=8000):
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"QoS Lab (mode lite, sans WebSocket) → http://{host}:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args()
    serve(a.host, a.port)
