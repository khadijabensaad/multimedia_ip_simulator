"""
Lanceur du Multimedia IP Network Simulator — QoS Lab.

    python run.py              → FastAPI + WebSocket (si installés), sinon mode lite
    python run.py --lite       → serveur sans dépendance (REST uniquement)
    python run.py --port 8080 --no-browser
"""

import argparse
import threading
import webbrowser


def main():
    ap = argparse.ArgumentParser(description="QoS Lab — simulateur de trafic multimédia IP")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--lite", action="store_true", help="serveur sans dépendance (pas de WebSocket)")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--reload", action="store_true", help="rechargement auto (développement)")
    args = ap.parse_args()

    url = f"http://{args.host}:{args.port}"
    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

    if not args.lite:
        try:
            import fastapi  # noqa: F401
            import uvicorn
            try:
                import websockets  # noqa: F401
            except ImportError:
                try:
                    import wsproto  # noqa: F401
                except ImportError:
                    print("⚠  Ni 'websockets' ni 'wsproto' installés : le temps réel passera par REST.\n"
                          "   pip install \"uvicorn[standard]\" pour activer le WebSocket.")
            print(f"QoS Lab (FastAPI) → {url}   ·   API : {url}/docs")
            uvicorn.run("backend.app:app", host=args.host, port=args.port, reload=args.reload, log_level="warning")
            return
        except ImportError:
            print("FastAPI/uvicorn introuvables → démarrage en mode lite (pip install -r requirements.txt)")
    from backend.lite_server import serve
    serve(args.host, args.port)


if __name__ == "__main__":
    main()
