"""Historique des simulations (SQLite, fichier data/history.db)."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

DB_PATH = Path(os.environ.get("QOSLAB_DB", Path(__file__).resolve().parents[2] / "data" / "history.db"))
MAX_ENTRIES = 300
_lock = threading.Lock()


@contextmanager
def _conn():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    try:
        _init(c)
        yield c
        c.commit()
    finally:
        c.close()


def _init(c):
    c.execute("""CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, created TEXT, name TEXT, kind TEXT, scheduler TEXT,
        health REAL, status TEXT, preset TEXT, payload TEXT)""")


def save(kind: str, payload: dict) -> str:
    """kind : simulation | comparison | sweep | optimization | live"""
    rid = uuid.uuid4().hex[:10]
    if kind == "comparison":
        cfg, summary = payload["config"], payload["runs"][-1]["summary"]
        sched = " vs ".join(r["scheduler"].upper() for r in payload["runs"])
    elif kind == "optimization":
        cfg, summary = payload["before"]["config"], payload["after"]["summary"]
        sched = f"{payload['before']['summary']['scheduler'].upper()} → {payload['after']['summary']['scheduler'].upper()}"
    elif kind == "sweep":
        cfg, summary, sched = payload["config"], None, payload["param"]
    else:
        cfg, summary = payload["config"], payload["summary"]
        sched = summary["scheduler"].upper()
    health = summary["health"]["score"] if summary else None
    status = summary["health"]["status"] if summary else None
    with _lock, _conn() as c:
        c.execute("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)",
                  (rid, datetime.now().isoformat(timespec="seconds"), cfg.get("name", "Simulation"), kind,
                   sched, health, status, cfg.get("preset"), json.dumps(payload, separators=(",", ":"))))
        c.execute("DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY created DESC LIMIT ?)",
                  (MAX_ENTRIES,))
    return rid


def list_runs(limit=100):
    with _lock, _conn() as c:
        rows = c.execute("SELECT id, created, name, kind, scheduler, health, status, preset FROM runs "
                         "ORDER BY created DESC, rowid DESC LIMIT ?", (limit,)).fetchall()
    keys = ("id", "created", "name", "kind", "scheduler", "health", "status", "preset")
    return [dict(zip(keys, r)) for r in rows]


def get(rid):
    with _lock, _conn() as c:
        row = c.execute("SELECT id, created, name, kind, scheduler, health, status, preset, payload FROM runs WHERE id=?",
                        (rid,)).fetchone()
    if not row:
        return None
    keys = ("id", "created", "name", "kind", "scheduler", "health", "status", "preset")
    item = dict(zip(keys, row[:8]))
    item["payload"] = json.loads(row[8])
    return item


def delete(rid):
    with _lock, _conn() as c:
        c.execute("DELETE FROM runs WHERE id=?", (rid,))


def clear():
    with _lock, _conn() as c:
        c.execute("DELETE FROM runs")
