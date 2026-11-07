"""
Générateurs de trafic : Voix (RTP/UDP), Vidéo (RTP/UDP, VBR à GOP) et Data (TCP ou UDP).

Chaque générateur reproduit la « signature » réelle de son trafic :
  * Voix  : petits paquets réguliers (ex. G.711 : 200 octets toutes les 20 ms par appel) ;
  * Vidéo : images à fps constant, images I ~4x plus grosses que les P,
            chaque image fragmentée en paquets de 1356 octets émis en rafale ;
  * Data  : TCP Reno simplifié (slow start, AIMD, réaction aux pertes) qui
            remplit les buffers — ou UDP de Poisson non réactif.
"""

from __future__ import annotations

import math
import random

from ..config import CODECS, DSCP, MTU, RTP_OVERHEAD, TCP_OVERHEAD

VIDEO_PAYLOAD = 1316          # 7 cellules MPEG-TS de 188 octets
VIDEO_GOP = 30                # une image I par seconde à 30 fps
I_FRAME_FACTOR = 4.0
VBR_SIGMA = 0.25


class TrafficSource:
    def __init__(self, sim, flow: dict):
        self.sim = sim
        self.env = sim.env
        self.flow = flow
        self.id = flow["id"]
        self.cls = flow["type"]
        self.dscp = DSCP[self.cls]["value"]
        self.rng = random.Random(f"{sim.seed}-{self.id}")
        self.generation = 0
        self.seq = 0
        self.dead = False

    @property
    def active(self):
        return not self.dead and self.flow.get("enabled", True)

    def emit(self, size, stream=None, frame=None):
        self.seq += 1
        self.sim.send(self, size, stream if stream is not None else self.id, frame, self.seq)

    def start(self):
        raise NotImplementedError

    def update(self, flow: dict):
        """Mise à jour à chaud des paramètres (mode live)."""
        self.flow = flow
        self.generation += 1
        self.start()

    # Notifications du réseau (utilisées par TCP)
    def on_delivered(self, pkt):
        pass

    def on_dropped(self, pkt):
        pass


class VoiceSource(TrafficSource):
    def start(self):
        gen = self.generation
        codec = CODECS[self.flow["codec"]]
        self.ptime = codec["ptime"]
        self.size = codec["payload"] + RTP_OVERHEAD
        for call in range(self.flow["calls"]):
            self.env.schedule(self.rng.uniform(0, self.ptime), self._tick, call, gen)

    def _tick(self, call, gen):
        if gen != self.generation or not self.active:
            return
        self.emit(self.size, stream=f"{self.id}#{call}")
        self.env.schedule(self.ptime, self._tick, call, gen)


class VideoSource(TrafficSource):
    def start(self):
        gen = self.generation
        self.frame_no = getattr(self, "frame_no", 0)
        self.env.schedule(self.rng.uniform(0, 1.0 / self.flow["fps"]), self._frame, gen)

    def _frame(self, gen):
        if gen != self.generation or not self.active:
            return
        fps = self.flow["fps"]
        rate_bps = self.flow["rate_mbps"] * 1e6
        # taille moyenne d'une image P telle que le débit moyen sur un GOP = rate
        p_size = rate_bps * VIDEO_GOP / (8 * fps * (VIDEO_GOP - 1 + I_FRAME_FACTOR))
        is_i = self.frame_no % VIDEO_GOP == 0
        noise = self.rng.lognormvariate(0, VBR_SIGMA) / math.exp(VBR_SIGMA ** 2 / 2)
        frame_bytes = max(200.0, p_size * (I_FRAME_FACTOR if is_i else 1.0) * noise)
        n_full, rest = divmod(int(frame_bytes), VIDEO_PAYLOAD)
        sizes = [VIDEO_PAYLOAD + RTP_OVERHEAD] * n_full
        if rest > 0:
            sizes.append(rest + RTP_OVERHEAD)
        frame_key = (self.id, self.frame_no)
        self.sim.collector.register_frame(frame_key, len(sizes), is_i)
        for s in sizes:
            self.emit(s, frame=frame_key)
        self.frame_no += 1
        self.env.schedule(1.0 / fps, self._frame, gen)


class UdpDataSource(TrafficSource):
    """Trafic data non réactif : arrivées de Poisson de paquets MTU."""

    def start(self):
        gen = self.generation
        self.env.schedule(self.rng.expovariate(1.0 / self._interval()), self._tick, gen)

    def _interval(self):
        return MTU * 8 / (self.flow["rate_mbps"] * 1e6)

    def _tick(self, gen):
        if gen != self.generation or not self.active:
            return
        self.emit(MTU)
        self.env.schedule(self.rng.expovariate(1.0 / self._interval()), self._tick, gen)


class TcpDataSource(TrafficSource):
    """TCP Reno simplifié, limité par le débit applicatif (rate_mbps).

    * slow start puis évitement de congestion (cwnd += 1/cwnd par ACK) ;
    * une perte détectée ≈ 1 RTT plus tard divise cwnd par 2 (fast recovery) ;
    * les ACK reviennent par un chemin retour non congestionné.
    """

    RWND = 800          # fenêtre de réception maximale (paquets)
    INIT_CWND = 10

    def __init__(self, sim, flow):
        super().__init__(sim, flow)
        self.cwnd = float(self.INIT_CWND)
        self.ssthresh = 1e9
        self.inflight = 0
        self.srtt = None
        self.last_cut = -1.0
        self.next_ok = 0.0
        self.wake_pending = False
        self.retransmissions = 0
        self.cwnd_reductions = 0

    def start(self):
        self.env.schedule(self.rng.uniform(0, 0.01), self._try_send)

    def update(self, flow):
        self.flow = flow
        self._try_send()

    def _try_send(self):
        if not self.active:
            return
        rate = self.flow["rate_mbps"] * 1e6
        gap = MTU * 8 / rate
        while self.inflight < min(self.cwnd, self.RWND):
            now = self.env.now
            if now + 1e-12 < self.next_ok:
                if not self.wake_pending:
                    self.wake_pending = True
                    self.env.schedule_at(self.next_ok, self._wake)
                return
            self.inflight += 1
            self.emit(MTU)
            self.next_ok = max(now, self.next_ok) + gap

    def _wake(self):
        self.wake_pending = False
        self._try_send()

    def _reverse_delay(self):
        return self.sim.base_latency + 0.0005

    def on_delivered(self, pkt):
        self.env.schedule(self._reverse_delay(), self._on_ack, pkt)

    def _on_ack(self, pkt):
        self.inflight = max(0, self.inflight - 1)
        rtt = self.env.now - pkt.created
        self.srtt = rtt if self.srtt is None else 0.875 * self.srtt + 0.125 * rtt
        if self.cwnd < self.ssthresh:
            self.cwnd += 1.0
        else:
            self.cwnd += 1.0 / self.cwnd
        self.cwnd = min(self.cwnd, float(self.RWND))
        self._try_send()

    def on_dropped(self, pkt):
        detect = self.srtt if self.srtt else 2 * self.sim.base_latency + 0.01
        self.env.schedule(detect, self._on_loss)

    def _on_loss(self):
        self.inflight = max(0, self.inflight - 1)
        self.retransmissions += 1
        rtt = self.srtt or 0.05
        if self.env.now - self.last_cut > rtt:
            self.ssthresh = max(self.cwnd / 2.0, 2.0)
            self.cwnd = self.ssthresh
            self.last_cut = self.env.now
            self.cwnd_reductions += 1
        self._try_send()


def make_source(sim, flow):
    if flow["type"] == "voice":
        return VoiceSource(sim, flow)
    if flow["type"] == "video":
        return VideoSource(sim, flow)
    if flow.get("protocol") == "udp":
        return UdpDataSource(sim, flow)
    return TcpDataSource(sim, flow)
