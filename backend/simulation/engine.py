"""
Moteur de simulation à événements discrets.

Même principe que SimPy : une horloge virtuelle et un échéancier (tas binaire)
d'événements datés. Le temps simulé avance d'événement en événement, ce qui
permet de simuler des dizaines de milliers de paquets par seconde de réseau
en quelques millisecondes de calcul, sans matériel réseau réel.

Implémenté sans dépendance externe pour pouvoir avancer la simulation
« par tranches » (mode live) et modifier les paramètres en cours d'exécution.
"""

from __future__ import annotations

import heapq
import itertools
from typing import Callable


class Environment:
    __slots__ = ("now", "_queue", "_seq", "events_processed")

    def __init__(self) -> None:
        self.now = 0.0
        self._queue: list = []
        self._seq = itertools.count()
        self.events_processed = 0

    def schedule(self, delay: float, callback: Callable, *args) -> None:
        """Planifie `callback(*args)` dans `delay` secondes de temps simulé."""
        heapq.heappush(self._queue, (self.now + max(0.0, delay), next(self._seq), callback, args))

    def schedule_at(self, time: float, callback: Callable, *args) -> None:
        heapq.heappush(self._queue, (max(time, self.now), next(self._seq), callback, args))

    def run_until(self, t_end: float) -> None:
        """Exécute tous les événements dont la date est <= t_end."""
        queue = self._queue
        pop = heapq.heappop
        count = 0
        while queue and queue[0][0] <= t_end:
            t, _, callback, args = pop(queue)
            self.now = t
            callback(*args)
            count += 1
        self.events_processed += count
        if t_end > self.now:
            self.now = t_end

    @property
    def pending(self) -> int:
        return len(self._queue)


class Packet:
    """Paquet IP simulé."""

    __slots__ = ("pid", "flow", "cls", "stream", "size", "created", "seq",
                 "frame", "dscp", "enqueued", "dequeued", "txdone", "retransmit")

    def __init__(self, pid, flow, cls, stream, size, created, seq=0, frame=None, dscp=0):
        self.pid = pid
        self.flow = flow          # identifiant du flux
        self.cls = cls            # voice | video | data
        self.stream = stream      # sous-flux (appel, session) pour le calcul du jitter
        self.size = size          # octets, en-têtes inclus
        self.created = created    # horodatage d'émission (s)
        self.seq = seq
        self.frame = frame        # n° d'image (vidéo)
        self.dscp = dscp
        self.enqueued = 0.0       # entrée dans la file du routeur
        self.dequeued = 0.0       # début de sérialisation sur le lien
        self.txdone = 0.0         # fin de sérialisation
        self.retransmit = False
