"""
Assemblage d'une simulation complète à partir d'une configuration de scénario.

Utilisable en deux modes :
  * batch : `Simulation(cfg).run()` exécute toute la durée et retourne le résultat ;
  * live  : `advance(dt)` fait avancer le temps simulé par tranches, et
            `apply_patch()` modifie les paramètres pendant l'exécution.
"""

from __future__ import annotations

import copy
import random
import time

from ..config import (effective_scheduler, normalize_config, offered_load)
from ..qos.metrics import Collector
from .engine import Environment, Packet
from .network import LlqScheduler, Router, WanLink, make_scheduler
from .traffic import make_source

QUEUE_SAMPLE_PERIOD = 0.005


class Simulation:
    def __init__(self, cfg: dict):
        self.cfg = normalize_config(cfg)
        self.seed = self.cfg["seed"]
        self.env = Environment()
        net = self.cfg["network"]
        self.bandwidth = net["bandwidth_mbps"] * 1e6
        self.base_latency = net["base_latency_ms"] / 1000
        self.voice_codec = self._dominant_codec()
        self.collector = Collector(self)
        self.router = Router(self.env, self.bandwidth, self._make_scheduler(),
                             on_transmit=self._on_transmit, on_drop=self._on_drop)
        self.wan = WanLink(self.env, random.Random(self.seed + 1), self.base_latency,
                           net["jitter_ms"] / 1000, net["loss_pct"], net["loss_model"],
                           on_arrive=self._on_arrive, on_drop=self._on_drop)
        self.sources = {}
        self._pid = 0
        for flow in self.cfg["flows"]:
            self._add_source(flow)
        self.env.schedule(0.0, self._sample)
        self.compute_time = 0.0

    # ---------------------------------------------------------------- construction
    def _dominant_codec(self):
        calls = {}
        for f in self.cfg["flows"]:
            if f["type"] == "voice":
                calls[f["codec"]] = calls.get(f["codec"], 0) + f["calls"]
        return max(calls, key=calls.get) if calls else "G.711"

    def _make_scheduler(self):
        q = self.cfg["qos"]
        return make_scheduler(effective_scheduler(self.cfg), self.cfg["network"]["buffer_pkts"],
                              q["weights"], self.bandwidth, q["priority_cap_pct"])

    def _add_source(self, flow):
        src = make_source(self, copy.deepcopy(flow))
        self.sources[flow["id"]] = src
        src.start()

    # ---------------------------------------------------------------- chemin des paquets
    def send(self, src, size, stream, frame, seq):
        self._pid += 1
        pkt = Packet(self._pid, src.id, src.cls, stream, size, self.env.now, seq, frame, src.dscp)
        self.collector.on_sent(pkt)
        self.router.receive(pkt)

    def _on_transmit(self, pkt):
        self.collector.on_transmit(pkt)
        self.wan.send(pkt)

    def _on_drop(self, pkt, reason):
        self.collector.on_drop(pkt, reason, self.env.now)
        src = self.sources.get(pkt.flow)
        if src is not None:
            src.on_dropped(pkt)

    def _on_arrive(self, pkt):
        self.collector.on_arrive(pkt, self.env.now)
        src = self.sources.get(pkt.flow)
        if src is not None:
            src.on_delivered(pkt)

    def _sample(self):
        self.collector.sample_queue(self.env.now, self.router.queue_lengths())
        self.env.schedule(QUEUE_SAMPLE_PERIOD, self._sample)

    # ---------------------------------------------------------------- exécution
    @property
    def now(self):
        return self.env.now

    def advance(self, dt: float):
        t0 = time.perf_counter()
        self.env.run_until(self.env.now + dt)
        windows = self.collector.flush_windows(self.env.now)
        self.compute_time += time.perf_counter() - t0
        return windows

    def run(self):
        self.advance(self.cfg["duration"])
        return self.result()

    def summary(self):
        s = self.collector.summary(self.env.now, self.cfg, self.sources)
        s["scheduler"] = effective_scheduler(self.cfg)
        s["offered"] = offered_load(self.cfg)
        s["events"] = self.env.events_processed
        s["packets"] = self._pid
        s["compute_ms"] = round(self.compute_time * 1000, 1)
        return s

    def result(self):
        return {
            "config": self.cfg,
            "summary": self.summary(),
            "timeline": list(self.collector.timeline),
        }

    def state(self):
        """Instantané léger pour l'affichage temps réel (topologie, files)."""
        sched = self.router.scheduler
        tot = self.collector.total["all"]
        flows = []
        for f in self.cfg["flows"]:
            acc = self.collector.flows.get(f["id"])
            item = {"id": f["id"], "type": f["type"], "name": f["name"], "enabled": f.get("enabled", True),
                    "rate_mbps": f["rate_mbps"]}
            if acc:
                n = acc.recv + acc.drops
                item.update(sent=acc.sent, recv=acc.recv, drops=acc.drops,
                            latency=round(acc.lat_sum / acc.recv * 1000, 2) if acc.recv else None,
                            jitter=round(acc.jit_sum / acc.recv * 1000, 2) if acc.recv else None,
                            loss=round(acc.drops / n * 100, 2) if n else 0)
            src = self.sources.get(f["id"])
            if src is not None and hasattr(src, "cwnd"):
                item["cwnd"] = round(src.cwnd, 1)
            flows.append(item)
        return {
            "t": round(self.env.now, 3),
            "scheduler": effective_scheduler(self.cfg),
            "queue": sched.lengths(),
            "queue_limits": sched.limits(),
            "router_busy": self.router.busy,
            "packets": self._pid,
            "drops": {"buffer": tot.d_buffer, "link": tot.d_link, "policer": tot.d_policer},
            "flows": flows,
            "offered": offered_load(self.cfg),
        }

    # ---------------------------------------------------------------- modifications à chaud
    def apply_patch(self, patch: dict):
        """Applique des modifications de paramètres pendant la simulation."""
        old = self.cfg
        merged = copy.deepcopy(old)
        for key in ("network", "qos"):
            if key in patch and isinstance(patch[key], dict):
                merged[key].update(patch[key])
                if key == "qos" and "weights" in patch[key]:
                    merged["qos"]["weights"] = {**old["qos"]["weights"], **patch["qos"]["weights"]}
        if "flows" in patch and isinstance(patch["flows"], list):
            merged["flows"] = patch["flows"]
        for key in ("name", "duration"):
            if key in patch:
                merged[key] = patch[key]
        new = normalize_config(merged)
        self.cfg = new

        on, nn = old["network"], new["network"]
        if nn["bandwidth_mbps"] != on["bandwidth_mbps"]:
            self.bandwidth = nn["bandwidth_mbps"] * 1e6
            self.router.bandwidth = self.bandwidth
            if isinstance(self.router.scheduler, LlqScheduler):
                self.router.scheduler.set_policer(self.bandwidth, new["qos"]["priority_cap_pct"])
        if old["qos"] != new["qos"] or on["buffer_pkts"] != nn["buffer_pkts"]:
            self.router.replace_scheduler(self._make_scheduler())
        if any(on[k] != nn[k] for k in ("base_latency_ms", "jitter_ms", "loss_pct", "loss_model")):
            self.base_latency = nn["base_latency_ms"] / 1000
            self.wan.configure(self.base_latency, nn["jitter_ms"] / 1000, nn["loss_pct"], nn["loss_model"])

        old_flows = {f["id"]: f for f in old["flows"]}
        new_flows = {f["id"]: f for f in new["flows"]}
        for fid in old_flows.keys() - new_flows.keys():
            src = self.sources.pop(fid, None)
            if src:
                src.dead = True
        for fid, f in new_flows.items():
            if fid not in old_flows:
                self._add_source(f)
            elif f != old_flows[fid]:
                src = self.sources[fid]
                if f["type"] != old_flows[fid]["type"] or f.get("protocol") != old_flows[fid].get("protocol"):
                    src.dead = True
                    self._add_source(f)
                else:
                    src.update(copy.deepcopy(f))
        self.voice_codec = self._dominant_codec()
        return new


def run_simulation(cfg: dict) -> dict:
    return Simulation(cfg).run()
