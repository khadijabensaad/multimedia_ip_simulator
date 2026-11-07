"""
Modèle du réseau : routeur goulot d'étranglement (files d'attente + ordonnanceur)
suivi d'un lien WAN (propagation, gigue, pertes aléatoires).

    Sources ──► Switch ──► [ Routeur R1 : file(s) + ordonnanceur ] ══ lien goulot ══► WAN ──► R2 ──► Récepteurs

Ordonnanceurs :
  * fifo     : une seule file, tous les paquets égaux (pas de QoS) ;
  * priority : priorité stricte voix > vidéo > data (PQ) ;
  * wfq      : files pondérées, implémentées en Deficit Round Robin ;
  * llq      : Low Latency Queuing (Cisco) = file prioritaire voix bornée
               par un policer + CBWFQ (DRR pondéré) pour vidéo et data.
"""

from __future__ import annotations

from collections import deque

from ..config import CLASS_BUFFER_SHARE, MTU, TRAFFIC_CLASSES

PRIORITY_ORDER = ("voice", "video", "data")


# --------------------------------------------------------------------------
# Ordonnanceurs
# --------------------------------------------------------------------------
class FifoScheduler:
    name = "fifo"

    def __init__(self, buffer_pkts: int, **_):
        self.evicted = []
        self.limit = buffer_pkts
        self.q: deque = deque()
        self.counts = {c: 0 for c in TRAFFIC_CLASSES}

    def push(self, pkt, now):
        """Retourne None si accepté, sinon la cause du rejet."""
        if len(self.q) >= self.limit:
            return "buffer"
        self.q.append(pkt)
        self.counts[pkt.cls] += 1
        return None

    def pop(self):
        if not self.q:
            return None
        pkt = self.q.popleft()
        self.counts[pkt.cls] -= 1
        return pkt

    def __len__(self):
        return len(self.q)

    def lengths(self):
        return dict(self.counts)

    def limits(self):
        return {"total": self.limit}

    def drain(self):
        pkts = list(self.q)
        self.q.clear()
        self.counts = {c: 0 for c in TRAFFIC_CLASSES}
        return pkts


class _ClassQueues:
    """Une file par classe de trafic dans un buffer partagé de `buffer_pkts` paquets.

    * chaque classe a un plafond (la voix ne peut pas monopoliser le buffer…) ;
    * quand le buffer est plein, un paquet prioritaire évince le dernier paquet
      d'une classe moins prioritaire (« push-out » selon la précédence DSCP).
    """

    def __init__(self, buffer_pkts: int, **_):
        self.queues = {c: deque() for c in TRAFFIC_CLASSES}
        self.capacity = buffer_pkts
        self.limit = {c: max(8, int(round(buffer_pkts * CLASS_BUFFER_SHARE[c]))) for c in TRAFFIC_CLASSES}
        self.total = 0
        self.evicted = []

    def push(self, pkt, now):
        q = self.queues[pkt.cls]
        if len(q) >= self.limit[pkt.cls]:
            return "buffer"
        if self.total >= self.capacity:
            rank = PRIORITY_ORDER.index(pkt.cls)
            victim_cls = next((c for c in reversed(PRIORITY_ORDER[rank + 1:]) if self.queues[c]), None)
            if victim_cls is None:
                return "buffer"
            self.evicted.append(self.queues[victim_cls].pop())
            self.total -= 1
        q.append(pkt)
        self.total += 1
        return None

    def __len__(self):
        return self.total

    def lengths(self):
        return {c: len(q) for c, q in self.queues.items()}

    def limits(self):
        return {"total": self.capacity, **self.limit}

    def drain(self):
        pkts = [p for q in self.queues.values() for p in q]
        pkts.sort(key=lambda p: p.enqueued)
        for q in self.queues.values():
            q.clear()
        self.total = 0
        return pkts

    def _take(self, cls):
        self.total -= 1
        return self.queues[cls].popleft()


class PriorityScheduler(_ClassQueues):
    name = "priority"

    def pop(self):
        for c in PRIORITY_ORDER:
            if self.queues[c]:
                return self._take(c)
        return None


class _Drr:
    """Deficit Round Robin : partage pondéré de la bande passante entre classes."""

    def __init__(self, queues, classes, weights):
        self.queues = queues
        self.classes = list(classes)
        wmin = min(max(1.0, weights[c]) for c in self.classes)
        self.quantum = {c: MTU * max(1.0, weights[c]) / wmin for c in self.classes}
        self.deficit = {c: 0.0 for c in self.classes}
        self.ptr = 0
        self.fresh = True

    def pop(self):
        if not any(self.queues[c] for c in self.classes):
            return None
        n = len(self.classes)
        while True:
            c = self.classes[self.ptr]
            q = self.queues[c]
            if q:
                if self.fresh:
                    self.deficit[c] += self.quantum[c]
                    self.fresh = False
                if q[0].size <= self.deficit[c]:
                    self.deficit[c] -= q[0].size
                    if len(q) == 1:
                        self.deficit[c] = 0.0
                        self.ptr = (self.ptr + 1) % n
                        self.fresh = True
                    return c
            else:
                self.deficit[c] = 0.0
            self.ptr = (self.ptr + 1) % n
            self.fresh = True


class WfqScheduler(_ClassQueues):
    name = "wfq"

    def __init__(self, buffer_pkts, weights=None, **kw):
        super().__init__(buffer_pkts)
        self.drr = _Drr(self.queues, TRAFFIC_CLASSES, weights or {c: 1 for c in TRAFFIC_CLASSES})

    def pop(self):
        c = self.drr.pop()
        return self._take(c) if c else None


class LlqScheduler(_ClassQueues):
    """File prioritaire stricte pour la voix (limitée par un policer token-bucket)
    puis CBWFQ entre vidéo et data."""

    name = "llq"

    def __init__(self, buffer_pkts, weights=None, bandwidth_bps=10e6, priority_cap_pct=33, **kw):
        super().__init__(buffer_pkts)
        weights = weights or {c: 1 for c in TRAFFIC_CLASSES}
        self.drr = _Drr(self.queues, ("video", "data"), weights)
        self.set_policer(bandwidth_bps, priority_cap_pct)

    def set_policer(self, bandwidth_bps, cap_pct):
        self.rate = bandwidth_bps * cap_pct / 100 / 8           # octets/s
        self.burst = max(3 * MTU, self.rate * 0.05)            # rafale tolérée : 50 ms
        self.tokens = self.burst
        self.last = None

    def push(self, pkt, now):
        if pkt.cls == "voice":
            if self.last is not None:
                self.tokens = min(self.burst, self.tokens + (now - self.last) * self.rate)
            self.last = now
            if pkt.size > self.tokens:
                return "policer"
            self.tokens -= pkt.size
        return super().push(pkt, now)

    def pop(self):
        if self.queues["voice"]:
            return self._take("voice")
        c = self.drr.pop()
        return self._take(c) if c else None


SCHEDULER_CLASSES = {
    "fifo": FifoScheduler,
    "priority": PriorityScheduler,
    "wfq": WfqScheduler,
    "llq": LlqScheduler,
}


def make_scheduler(name, buffer_pkts, weights, bandwidth_bps, priority_cap_pct):
    cls = SCHEDULER_CLASSES.get(name, FifoScheduler)
    return cls(buffer_pkts=buffer_pkts, weights=weights, bandwidth_bps=bandwidth_bps,
               priority_cap_pct=priority_cap_pct)


# --------------------------------------------------------------------------
# Routeur goulot d'étranglement
# --------------------------------------------------------------------------
class Router:
    def __init__(self, env, bandwidth_bps, scheduler, on_transmit, on_drop):
        self.env = env
        self.bandwidth = bandwidth_bps
        self.scheduler = scheduler
        self.on_transmit = on_transmit
        self.on_drop = on_drop
        self.busy = False
        self.current = None

    def replace_scheduler(self, scheduler):
        """Change d'ordonnanceur à chaud (activation/désactivation QoS en live)."""
        pending = self.scheduler.drain()
        self.scheduler = scheduler
        for pkt in pending:
            reason = scheduler.push(pkt, self.env.now)
            if reason:
                self.on_drop(pkt, reason)
            self._flush_evicted()

    def _flush_evicted(self):
        ev = self.scheduler.evicted
        if ev:
            self.scheduler.evicted = []
            for victim in ev:
                self.on_drop(victim, "buffer")

    def receive(self, pkt):
        now = self.env.now
        pkt.enqueued = now
        reason = self.scheduler.push(pkt, now)
        self._flush_evicted()
        if reason:
            self.on_drop(pkt, reason)
            return
        if not self.busy:
            self._start()

    def _start(self):
        pkt = self.scheduler.pop()
        if pkt is None:
            self.busy = False
            self.current = None
            return
        self.busy = True
        self.current = pkt
        pkt.dequeued = self.env.now
        self.env.schedule(pkt.size * 8 / self.bandwidth, self._done, pkt)

    def _done(self, pkt):
        pkt.txdone = self.env.now
        self.on_transmit(pkt)
        self._start()

    def queue_lengths(self):
        return self.scheduler.lengths()


# --------------------------------------------------------------------------
# Lien WAN : propagation + gigue + pertes
# --------------------------------------------------------------------------
class WanLink:
    BURST_LEN = 3.0  # longueur moyenne d'une rafale de pertes (modèle de Gilbert-Elliott)

    def __init__(self, env, rng, delay_s, jitter_s, loss_pct, loss_model, on_arrive, on_drop):
        self.env = env
        self.rng = rng
        self.on_arrive = on_arrive
        self.on_drop = on_drop
        self.last_arrival = 0.0
        self.bad_state = False
        self.configure(delay_s, jitter_s, loss_pct, loss_model)

    def configure(self, delay_s, jitter_s, loss_pct, loss_model):
        self.delay = delay_s
        self.jitter = jitter_s
        self.loss = loss_pct / 100.0
        self.model = loss_model
        # Gilbert-Elliott : proba bonne->mauvaise telle que la perte moyenne = loss
        p_bg = 1.0 / self.BURST_LEN
        self.p_bg = p_bg
        self.p_gb = (self.loss * p_bg / (1 - self.loss)) if self.loss < 1 else 1.0

    def _lost(self):
        if self.loss <= 0:
            return False
        if self.model == "burst":
            if self.bad_state:
                if self.rng.random() < self.p_bg:
                    self.bad_state = False
            elif self.rng.random() < self.p_gb:
                self.bad_state = True
            return self.bad_state
        return self.rng.random() < self.loss

    def send(self, pkt):
        if self._lost():
            self.on_drop(pkt, "link")
            return
        d = self.delay
        if self.jitter > 0:
            d += self.rng.expovariate(1.0 / self.jitter)
        arrival = max(self.env.now + d, self.last_arrival)  # pas de déséquencement sur un même lien
        self.last_arrival = arrival
        self.env.schedule_at(arrival, self.on_arrive, pkt)
