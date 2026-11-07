"""Tests du simulateur — exécution : python -m unittest discover -s tests -v"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("QOSLAB_DB", str(Path(tempfile.mkdtemp()) / "test.db"))

from backend.config import codec_ip_bps, normalize_config, offered_load  # noqa: E402
from backend.qos.advisor import analyze  # noqa: E402
from backend.qos.metrics import (calculate_bandwidth, calculate_improvement, calculate_jitter,  # noqa: E402
                                 calculate_packet_loss, calculate_rfc3550_jitter)
from backend.qos.mos import estimate_mos  # noqa: E402
from backend.scenarios.presets import PRESETS, apply_sweep_value, get_preset_config  # noqa: E402
from backend.services import simulation_service as svc  # noqa: E402
from backend.simulation.engine import Environment  # noqa: E402
from backend.simulation.simulator import Simulation  # noqa: E402

CONGESTION = {
    "duration": 10, "seed": 7,
    "network": {"bandwidth_mbps": 10, "base_latency_ms": 10, "buffer_pkts": 100},
    "flows": [{"type": "voice", "calls": 25}, {"type": "video", "rate_mbps": 8},
              {"type": "data", "rate_mbps": 5, "protocol": "udp"}],
}


def with_qos(cfg, enabled, scheduler="llq"):
    c = normalize_config(cfg)
    c["qos"]["enabled"] = enabled
    c["qos"]["scheduler"] = scheduler
    return c


class TestUnitFormulas(unittest.TestCase):
    def test_basic_formulas(self):
        self.assertEqual(calculate_bandwidth(10, 8), 10.0)          # 10 Mo en 8 s = 10 Mbit/s
        self.assertEqual(calculate_packet_loss(1000, 950), 5.0)
        self.assertEqual(calculate_jitter([20, 25, 70, 30]), 30.0)  # (5+45+40)/3
        self.assertEqual(calculate_improvement(100, 25), 75.0)
        self.assertGreater(calculate_rfc3550_jitter([20, 25, 70, 30]), 0)

    def test_codec_rates(self):
        self.assertAlmostEqual(codec_ip_bps("G.711"), 80_000)       # (160 + 40) octets / 20 ms
        self.assertAlmostEqual(codec_ip_bps("G.729"), 24_000)

    def test_emodel(self):
        good, _ = estimate_mos(20, 2, 0, "G.711")
        bad, _ = estimate_mos(300, 40, 10, "G.711")
        self.assertGreater(good, 4.3)
        self.assertLess(bad, 2.6)
        self.assertLess(estimate_mos(20, 2, 0, "G.729")[0], good)  # codec compressé : Ie > 0

    def test_engine_order(self):
        env, seen = Environment(), []
        env.schedule(0.3, seen.append, "c")
        env.schedule(0.1, seen.append, "a")
        env.schedule(0.2, seen.append, "b")
        env.run_until(1)
        self.assertEqual(seen, ["a", "b", "c"])
        self.assertEqual(env.now, 1)


class TestSimulation(unittest.TestCase):
    def test_normal_network_is_clean(self):
        cfg = get_preset_config("normal")
        cfg["duration"] = 8
        s = Simulation(cfg).run()["summary"]
        self.assertEqual(s["network"]["drops"]["buffer"], 0)
        self.assertLess(s["classes"]["voice"]["latency"], 30)
        self.assertEqual(s["health"]["status"], "good")

    def test_packet_conservation(self):
        sim = Simulation(normalize_config(CONGESTION))
        sim.run()
        tot = sim.collector.total["all"]
        self.assertLessEqual(tot.recv + tot.drops, tot.sent)
        self.assertGreater(tot.drops, 0)
        # le débit reçu ne peut pas dépasser la capacité du lien
        self.assertLessEqual(sim.summary()["all"]["throughput"], 10.0 * 1.01)

    def test_qos_protects_voice(self):
        fifo = Simulation(with_qos(CONGESTION, False)).run()["summary"]["classes"]["voice"]
        llq = Simulation(with_qos(CONGESTION, True)).run()["summary"]["classes"]["voice"]
        self.assertGreater(fifo["loss"], 1.0)
        self.assertEqual(llq["loss"], 0.0)
        self.assertLess(llq["latency"], fifo["latency"] / 2)

    def test_all_schedulers_work_conserving(self):
        for sched in ("priority", "wfq", "llq"):
            s = Simulation(with_qos(CONGESTION, True, sched)).run()["summary"]
            self.assertGreater(s["network"]["utilization_avg"], 0.97, sched)

    def test_determinism(self):
        a = Simulation(normalize_config(CONGESTION)).run()["summary"]
        b = Simulation(normalize_config(CONGESTION)).run()["summary"]
        self.assertEqual(a["all"]["sent"], b["all"]["sent"])
        self.assertEqual(a["classes"]["voice"]["latency"], b["classes"]["voice"]["latency"])

    def test_tcp_adapts_to_capacity(self):
        cfg = normalize_config({"duration": 10, "network": {"bandwidth_mbps": 10},
                                "flows": [{"type": "data", "rate_mbps": 50, "protocol": "tcp"}]})
        s = Simulation(cfg).run()["summary"]
        self.assertGreater(s["classes"]["data"]["throughput"], 8.5)   # TCP remplit le lien…
        self.assertLess(s["classes"]["data"]["loss"], 5)              # …sans s'effondrer

    def test_link_loss(self):
        cfg = normalize_config({"duration": 10, "network": {"bandwidth_mbps": 50, "loss_pct": 5},
                                "flows": [{"type": "voice", "calls": 10}]})
        s = Simulation(cfg).run()["summary"]
        self.assertAlmostEqual(s["classes"]["voice"]["loss"], 5, delta=1.0)

    def test_live_patch(self):
        sim = Simulation(normalize_config(CONGESTION))
        sim.advance(4)
        sim.apply_patch({"qos": {"enabled": True, "scheduler": "llq"}})
        wins = sim.advance(4)
        tail = [w["classes"]["voice"]["loss"] for w in wins[-8:]]
        self.assertEqual(max(tail), 0.0)
        flows = sim.cfg["flows"] + [{"type": "video", "rate_mbps": 2, "id": "extra"}]
        sim.apply_patch({"flows": flows})
        sim.advance(1)
        self.assertGreater(sim.collector.flows["extra"].sent, 0)

    def test_all_presets_run(self):
        for p in PRESETS:
            cfg = get_preset_config(p["id"])
            cfg["duration"] = 3
            r = svc.simulate(cfg)
            self.assertIn("advisor", r, p["id"])
            self.assertTrue(r["timeline"], p["id"])

    def test_sweep_value(self):
        cfg = apply_sweep_value(get_preset_config("video_overload"), "video_count", 20)
        self.assertEqual(sum(f["type"] == "video" for f in cfg["flows"]), 20)
        self.assertGreater(offered_load(cfg)["utilization"], 1)


class TestAdvisorAndServices(unittest.TestCase):
    def test_advisor_recommends_llq(self):
        cfg = normalize_config(CONGESTION)
        s = Simulation(cfg).run()["summary"]
        ids = [r["id"] for r in analyze(cfg, s)["recommendations"]]
        self.assertIn("enable_llq", ids)
        self.assertIn("increase_bandwidth", ids)

    def test_optimize_improves_health(self):
        o = svc.optimize(get_preset_config("voip_stress"))
        self.assertGreater(o["after"]["summary"]["health"]["score"], o["before"]["summary"]["health"]["score"])

    def test_reports(self):
        from backend.api import handlers as H
        r = H.compare({"config": CONGESTION})
        csv_bytes, _, _ = H.report_csv(r["history_id"])
        self.assertIn(b"latence", csv_bytes.lower())
        try:
            import reportlab  # noqa: F401
        except ImportError:
            return
        pdf, _, _ = H.report_pdf(r["history_id"])
        self.assertTrue(pdf.startswith(b"%PDF"))


if __name__ == "__main__":
    unittest.main()
