# API — QoS Lab

Base : `http://127.0.0.1:8000` — documentation interactive (Swagger) : `/docs`.

## Format d'un scénario (`config`)

```json
{
  "name": "Congestion réseau",
  "duration": 20,
  "seed": 42,
  "network": { "bandwidth_mbps": 10, "base_latency_ms": 10, "jitter_ms": 1,
               "loss_pct": 0, "loss_model": "random", "buffer_pkts": 100 },
  "qos": { "enabled": true, "scheduler": "llq",
           "weights": { "voice": 30, "video": 60, "data": 15 }, "priority_cap_pct": 33 },
  "flows": [
    { "id": "voice-1", "type": "voice", "name": "Appels", "codec": "G.711", "calls": 25 },
    { "id": "video-1", "type": "video", "name": "Streaming", "rate_mbps": 8, "fps": 30 },
    { "id": "data-1",  "type": "data",  "name": "Backup", "rate_mbps": 5, "protocol": "udp" }
  ]
}
```
`scheduler` ∈ `priority | wfq | llq` (FIFO = `enabled: false`). `loss_model` ∈ `random | burst`. Valeurs manquantes complétées et bornées par `normalize_config()`.

## Endpoints REST

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/health` | état du serveur |
| GET | `/api/meta` | codecs, profils vidéo, ordonnanceurs, DSCP, seuils |
| GET | `/api/presets` · `/api/presets/{id}` | les 8 scénarios |
| POST | `/api/preview` | charge offerte / utilisation théorique |
| POST | `/api/simulate` | `{config}` → `{config, summary, timeline, advisor, history_id}` |
| POST | `/api/compare` | `{config, schedulers: ["fifo","llq"]}` → `{runs[], improvement, advisor}` |
| POST | `/api/sweep` | `{config, param, values}` — `param` ∈ `loss_pct, base_latency_ms, video_count, bandwidth_mbps, buffer_pkts, voice_calls` |
| POST | `/api/optimize` | `{config, recommendations?}` → `{before, after, stages, applied, improvement}` |
| POST | `/api/advisor` | `{config, summary}` → diagnostic |
| GET/DELETE | `/api/history[/{id}]` | historique SQLite |
| GET | `/api/reports/{id}.pdf` · `.csv` | exports |
| POST | `/api/live` · `/api/live/{sid}/step` · PATCH `/api/live/{sid}` · POST `/api/live/{sid}/finish` | temps réel par REST (repli) |

## WebSocket `/ws/live`

Client → serveur
```json
{"type": "start", "config": {...}, "speed": 2}
{"type": "patch", "qos": {"enabled": true}, "network": {"bandwidth_mbps": 20}, "flows": [...], "speed": 4}
{"type": "pause"} | {"type": "resume"} | {"type": "stop"}
```
Serveur → client : `started`, puis un `tick` toutes les 200 ms :
```json
{"type": "tick", "t": 12.4,
 "windows": [{"t": 12.25, "utilization": 0.99, "capacity": 10, "queue": {"avg": 92, "voice": 40, ...},
              "classes": {"voice": {"throughput": 1.8, "latency": 61.2, "jitter": 8.1, "loss": 9.4, "mos": 3.4, ...}, "video": {...}, "data": {...}, "all": {...}}}],
 "state": {"scheduler": "fifo", "queue": {...}, "queue_limits": {...}, "drops": {...}, "flows": [...]},
 "alerts": [{"severity": "critical", "title": "Voix — pertes : niveau critique", "detail": "9.4 % — au-delà de 3 %", "t": 12.4}]}
```
`stop` renvoie un message `summary` (résumé complet + Smart Advisor), enregistré dans l'historique.
