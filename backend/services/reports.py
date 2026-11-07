"""Export des rapports de simulation : CSV (stdlib) et PDF (ReportLab)."""

from __future__ import annotations

import csv
import io
from datetime import datetime

from ..config import SCHEDULERS, THRESHOLDS, TRAFFIC_CLASSES

CLASS_FR = {"voice": "Voix", "video": "Vidéo", "data": "Data"}
CLASS_HEX = {"voice": "#0891b2", "video": "#7c3aed", "data": "#db2777"}
STATUS_FR = {"good": "OK", "warn": "Dégradé", "critical": "Critique", "idle": "—"}


def _runs(kind, payload):
    """Ramène tous les types d'entrées à une liste de runs {label, config, summary, timeline}."""
    if kind == "comparison":
        return [{"label": r["label"], "config": r["config"], "summary": r["summary"], "timeline": r["timeline"]}
                for r in payload["runs"]], payload.get("advisor")
    if kind == "optimization":
        b, a = payload["before"], payload["after"]
        return [{"label": "Avant optimisation", **{k: b[k] for k in ("config", "summary", "timeline")}},
                {"label": "Après optimisation", **{k: a[k] for k in ("config", "summary", "timeline")}}], b.get("advisor")
    if kind == "sweep":
        return [], None
    return [{"label": "Simulation", "config": payload["config"], "summary": payload["summary"],
             "timeline": payload.get("timeline", [])}], payload.get("advisor")


def _fmt(v, nd=2):
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


# ---------------------------------------------------------------------- CSV
def to_csv(entry: dict) -> bytes:
    kind, payload = entry["kind"], entry["payload"]
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Multimedia IP Network Simulator — QoS Lab"])
    w.writerow(["Rapport", entry["name"], "Type", kind, "Date", entry["created"]])
    w.writerow([])
    if kind == "sweep":
        w.writerow(["Balayage", payload["label"]])
        head = ["valeur", "mode", "santé", "utilisation"]
        for c in TRAFFIC_CLASSES:
            head += [f"{c}_latence_ms", f"{c}_jitter_ms", f"{c}_perte_pct", f"{c}_debit_mbps"]
        head += ["mos", "integrite_video_pct"]
        w.writerow(head)
        for p in payload["points"]:
            for m, d in p["modes"].items():
                row = [p["value"], m, d["health"], d["utilization"]]
                for c in TRAFFIC_CLASSES:
                    row += [_fmt(d[c]["latency"]), _fmt(d[c]["jitter"]), _fmt(d[c]["loss"]), _fmt(d[c]["throughput"])]
                row += [_fmt(d["mos"]), _fmt(d["frame_integrity"])]
                w.writerow(row)
        return ("﻿" + buf.getvalue()).encode("utf-8")

    runs, _ = _runs(kind, payload)
    w.writerow(["# Résumé par classe"])
    w.writerow(["run", "classe", "paquets_envoyes", "paquets_recus", "pertes", "perte_pct", "latence_moy_ms",
                "latence_p95_ms", "latence_max_ms", "jitter_ms", "debit_mbps", "offert_mbps", "statut"])
    for r in runs:
        for c in TRAFFIC_CLASSES:
            g = r["summary"]["classes"][c]
            w.writerow([r["label"], c, g["sent"], g["recv"], g["drops"], _fmt(g["loss"]), _fmt(g["latency"]),
                        _fmt(g["latency_p95"]), _fmt(g["latency_max"]), _fmt(g["jitter"]), _fmt(g["throughput"]),
                        _fmt(g["offered"]), g["overall"]])
        vq = r["summary"].get("voice_quality")
        if vq:
            w.writerow([r["label"], "MOS voix estimé", vq["mos"], "R", vq["r_factor"], vq["label"]])
        w.writerow([r["label"], "Score santé", r["summary"]["health"]["score"], r["summary"]["health"]["label"]])
    w.writerow([])
    w.writerow(["# Séries temporelles (fenêtres de 250 ms)"])
    head = ["run", "t_s", "utilisation", "file_moy_pkts"]
    for c in TRAFFIC_CLASSES:
        head += [f"{c}_debit_mbps", f"{c}_latence_ms", f"{c}_jitter_ms", f"{c}_perte_pct"]
    w.writerow(head)
    for r in runs:
        for t in r["timeline"]:
            row = [r["label"], t["t"], t["utilization"], t["queue"]["avg"]]
            for c in TRAFFIC_CLASSES:
                g = t["classes"][c]
                row += [g["throughput"], _fmt(g["latency"], 3), _fmt(g["jitter"], 3), g["loss"]]
            w.writerow(row)
    return ("﻿" + buf.getvalue()).encode("utf-8")


# ---------------------------------------------------------------------- PDF
def pdf_available() -> bool:
    try:
        import reportlab  # noqa: F401
        return True
    except ImportError:
        return False


def to_pdf(entry: dict) -> bytes:
    from reportlab.graphics.charts.barcharts import VerticalBarChart
    from reportlab.graphics.charts.legends import Legend
    from reportlab.graphics.charts.lineplots import LinePlot
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table,
                                    TableStyle)

    kind, payload = entry["kind"], entry["payload"]
    runs, advisor = _runs(kind, payload)

    navy = colors.HexColor("#0b1222")
    cyan = colors.HexColor("#0891b2")
    grey = colors.HexColor("#64748b")
    light = colors.HexColor("#eef2f7")
    st_col = {"good": colors.HexColor("#059669"), "warn": colors.HexColor("#ea580c"),
              "critical": colors.HexColor("#dc2626"), "idle": grey, "info": cyan, "success": colors.HexColor("#059669")}

    ss = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=ss["Heading1"], fontName="Helvetica-Bold", fontSize=18, textColor=navy, spaceAfter=4)
    h2 = ParagraphStyle("h2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=12.5, textColor=navy,
                        spaceBefore=10, spaceAfter=6)
    body = ParagraphStyle("b", parent=ss["BodyText"], fontName="Helvetica", fontSize=9.2, leading=12.5, alignment=TA_LEFT)
    small = ParagraphStyle("s", parent=body, fontSize=8, textColor=grey, leading=10.5)

    def table(data, widths, header=True, zebra=True):
        t = Table(data, colWidths=widths, hAlign="LEFT")
        style = [("FONT", (0, 0), (-1, -1), "Helvetica", 8.4),
                 ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                 ("TOPPADDING", (0, 0), (-1, -1), 3.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
                 ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#d7dde6"))]
        if header:
            style += [("BACKGROUND", (0, 0), (-1, 0), navy), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                      ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8.4)]
        if zebra:
            for i in range(1 if header else 0, len(data)):
                if i % 2 == 0:
                    style.append(("BACKGROUND", (0, i), (-1, i), light))
        t.setStyle(TableStyle(style))
        return t

    def line_chart(timeline_sets, key, title, unit, width=170 * mm, height=55 * mm):
        d = Drawing(width, height)
        lp = LinePlot()
        lp.x, lp.y, lp.width, lp.height = 32, 22, width - 50, height - 42
        data, cols = [], []
        for label, tl, cls_ in timeline_sets:
            pts = [(w["t"], w["classes"][cls_][key]) for w in tl if w["classes"][cls_][key] is not None]
            if len(pts) < 2:
                continue
            step = max(1, len(pts) // 160)
            data.append(pts[::step])
            cols.append((label, cls_))
        if not data:
            return None
        lp.data = data
        palette = [colors.HexColor("#0891b2"), colors.HexColor("#7c3aed"), colors.HexColor("#db2777"),
                   colors.HexColor("#ea580c"), colors.HexColor("#059669"), colors.HexColor("#64748b")]
        for i in range(len(data)):
            lp.lines[i].strokeColor = palette[i % len(palette)]
            lp.lines[i].strokeWidth = 1.2
        lp.xValueAxis.labels.fontSize = 7
        lp.yValueAxis.labels.fontSize = 7
        lp.xValueAxis.labelTextFormat = "%.0fs"
        lp.yValueAxis.valueMin = 0
        d.add(lp)
        d.add(String(32, height - 12, f"{title} ({unit})", fontName="Helvetica-Bold", fontSize=8.5, fillColor=navy))
        lg = Legend()
        lg.x, lg.y = width - 10, height - 8
        lg.alignment = "right"
        lg.fontSize = 7
        lg.columnMaximum = 1
        lg.dx, lg.dy, lg.deltax = 8, 6, 70
        lg.colorNamePairs = [(palette[i % len(palette)], f"{lab} · {CLASS_FR.get(c, c)}" if len(timeline_sets) > 3 else lab)
                             for i, (lab, c) in enumerate(cols)]
        lg.boxAnchor = "ne"
        d.add(lg)
        return d

    def bar_compare(metric, title, unit, width=82 * mm, height=55 * mm):
        d = Drawing(width, height)
        bc = VerticalBarChart()
        bc.x, bc.y, bc.width, bc.height = 28, 20, width - 36, height - 40
        bc.data = [[(r["summary"]["classes"][c][metric] or 0) for c in TRAFFIC_CLASSES] for r in runs]
        bc.categoryAxis.categoryNames = [CLASS_FR[c] for c in TRAFFIC_CLASSES]
        bc.categoryAxis.labels.fontSize = 7
        bc.valueAxis.labels.fontSize = 7
        bc.valueAxis.valueMin = 0
        bc.groupSpacing = 6
        pal = [colors.HexColor("#94a3b8"), cyan, colors.HexColor("#7c3aed"), colors.HexColor("#059669")]
        for i in range(len(runs)):
            bc.bars[i].fillColor = pal[i % len(pal)]
            bc.bars[i].strokeColor = None
        d.add(bc)
        d.add(String(28, height - 12, f"{title} ({unit})", fontName="Helvetica-Bold", fontSize=8.5, fillColor=navy))
        return d

    story = []
    story.append(Paragraph("Multimedia IP Network Simulator — QoS Lab", small))
    story.append(Paragraph(f"Rapport de simulation : {entry['name']}", h1))
    kind_fr = {"simulation": "Simulation", "comparison": "Comparaison QoS", "optimization": "Optimisation Smart Advisor",
               "sweep": "Balayage de paramètre", "live": "Session temps réel"}.get(kind, kind)
    story.append(Paragraph(f"{kind_fr} · généré le {datetime.now():%d/%m/%Y à %H:%M} · enregistrement {entry['id']}", small))
    story.append(Spacer(1, 8))

    if kind == "sweep":
        story.append(Paragraph(f"Balayage : {payload['label']}", h2))
        head = ["Valeur", "Mode", "Santé", "Lat. voix", "Jit. voix", "Perte voix", "MOS", "Lat. vidéo", "Perte vidéo", "Débit data"]
        rows = [head]
        for p in payload["points"]:
            for m, d in p["modes"].items():
                rows.append([str(p["value"]), m.upper(), _fmt(d["health"], 0), _fmt(d["voice"]["latency"], 1),
                             _fmt(d["voice"]["jitter"], 1), _fmt(d["voice"]["loss"]), _fmt(d["mos"]),
                             _fmt(d["video"]["latency"], 1), _fmt(d["video"]["loss"]), _fmt(d["data"]["throughput"])])
        story.append(table(rows, [16 * mm, 14 * mm, 14 * mm] + [18 * mm] * 7))
        return _build(story)

    cfg = runs[0]["config"]
    net = cfg["network"]
    story.append(Paragraph("1. Configuration du scénario", h2))
    if cfg.get("description"):
        story.append(Paragraph(cfg["description"], body))
        story.append(Spacer(1, 4))
    cfg_rows = [["Paramètre", "Valeur", "Paramètre", "Valeur"],
                ["Bande passante", f"{net['bandwidth_mbps']:g} Mbit/s", "Latence de base", f"{net['base_latency_ms']:g} ms"],
                ["Gigue du lien", f"{net['jitter_ms']:g} ms", "Pertes du lien", f"{net['loss_pct']:g} % ({net['loss_model']})"],
                ["Buffer routeur", f"{net['buffer_pkts']} paquets", "Durée simulée", f"{cfg['duration']:g} s"],
                ["Ordonnanceur", " / ".join(SCHEDULERS[r['summary']['scheduler']].split(' —')[0] for r in runs),
                 "Graine aléatoire", str(cfg["seed"])]]
    story.append(table(cfg_rows, [38 * mm, 47 * mm, 38 * mm, 47 * mm]))
    story.append(Spacer(1, 6))
    flow_rows = [["Flux", "Type", "Paramètres", "Débit offert"]]
    for f in cfg["flows"]:
        if f["type"] == "voice":
            p = f"{f['calls']} appels {f['codec']}"
        elif f["type"] == "video":
            p = f"{f['fps']} i/s, GOP 30, VBR"
        else:
            p = f"{f['protocol'].upper()}"
        flow_rows.append([f["name"], CLASS_FR[f["type"]], p, f"{f['rate_mbps']:.2f} Mbit/s"])
    story.append(table(flow_rows, [62 * mm, 22 * mm, 50 * mm, 36 * mm]))

    story.append(Paragraph("2. Résultats QoS", h2))
    for r in runs:
        s = r["summary"]
        hs = s["health"]
        head = Paragraph(f"<b>{r['label']}</b> — score de santé <font color='{st_col[hs['status']].hexval().replace('0x', '#')}'>"
                         f"<b>{hs['score']:.0f}/100</b></font> ({hs['label']}) · utilisation moyenne "
                         f"{s['network']['utilization_avg'] * 100:.0f} %", body)
        rows = [["Classe", "Latence moy.", "p95", "Jitter", "Pertes", "Débit reçu", "Statut"]]
        stat_cells = []
        for i, c in enumerate(TRAFFIC_CLASSES, start=1):
            g = s["classes"][c]
            rows.append([CLASS_FR[c], f"{_fmt(g['latency'], 1)} ms", f"{_fmt(g['latency_p95'], 1)} ms",
                         f"{_fmt(g['jitter'], 1)} ms", f"{_fmt(g['loss'])} %", f"{g['throughput']:.2f} Mbit/s",
                         STATUS_FR[g["overall"]]])
            stat_cells.append(("TEXTCOLOR", (6, i), (6, i), st_col[g["overall"]]))
        t = table(rows, [22 * mm, 26 * mm, 22 * mm, 22 * mm, 22 * mm, 30 * mm, 26 * mm])
        t.setStyle(TableStyle(stat_cells + [("FONT", (6, 1), (6, -1), "Helvetica-Bold", 8.4)]))
        extras = []
        if s.get("voice_quality"):
            v = s["voice_quality"]
            extras.append(f"MOS voix estimé (E-model) : <b>{v['mos']:.2f}</b> — {v['label']} (R = {v['r_factor']})")
        if s.get("video_quality"):
            extras.append(f"Images vidéo intactes : <b>{s['video_quality']['frame_integrity']:.1f} %</b>")
        if s.get("data_quality"):
            dq = s["data_quality"]
            extras.append(f"Goodput data : <b>{dq['goodput_mbps']:.2f} Mbit/s</b>, {dq['retransmissions']} retransmissions TCP")
        block = [head, Spacer(1, 3), t]
        if extras:
            block += [Spacer(1, 3), Paragraph(" · ".join(extras), small)]
        story.append(KeepTogether(block + [Spacer(1, 8)]))

    if len(runs) > 1:
        d1 = bar_compare("latency", "Latence moyenne", "ms")
        d2 = bar_compare("loss", "Taux de perte", "%")
        legend = " · ".join(f"<font color='{c}'>■</font> {r['label']}" for r, c in
                            zip(runs, ["#94a3b8", "#0891b2", "#7c3aed", "#059669"]))
        story.append(KeepTogether([Table([[d1, d2]], colWidths=[86 * mm, 86 * mm]), Paragraph(legend, small)]))

    story.append(Paragraph("3. Évolution temporelle", h2))
    if len(runs) == 1:
        sets = [(CLASS_FR[c], runs[0]["timeline"], c) for c in TRAFFIC_CLASSES if runs[0]["summary"]["classes"][c]["recv"]]
    else:
        sets = [(r["label"], r["timeline"], "voice") for r in runs]
    for key, title, unit in (("latency", "Latence" + ("" if len(runs) == 1 else " voix"), "ms"),
                             ("jitter", "Jitter" + ("" if len(runs) == 1 else " voix"), "ms"),
                             ("throughput", "Débit reçu" + ("" if len(runs) == 1 else " voix"), "Mbit/s")):
        ch = line_chart(sets, key, title, unit)
        if ch:
            story.append(ch)
            story.append(Spacer(1, 4))

    if advisor:
        story.append(PageBreak())
        story.append(Paragraph("4. QoS Smart Advisor — diagnostic et recommandations", h2))
        story.append(Paragraph(advisor["headline"], body))
        story.append(Spacer(1, 4))
        for f in advisor["findings"]:
            c = st_col.get(f["severity"], grey).hexval().replace("0x", "#")
            story.append(Paragraph(f"<font color='{c}'>●</font> <b>{f['title']}</b> — {f['detail']}", body))
        story.append(Spacer(1, 6))
        for i, r in enumerate(advisor["recommendations"], 1):
            story.append(Paragraph(f"<b>{i}. {r['title']}</b>", body))
            story.append(Paragraph(r["rationale"] + (f" <i>Impact attendu : {r['impact']}.</i>" if r.get("impact") else ""), small))
            story.append(Spacer(1, 3))

    story.append(Spacer(1, 10))
    th = THRESHOLDS
    story.append(Paragraph("Seuils de référence (ITU-T G.114 / Cisco) — voix : latence ≤ "
                           f"{th['voice']['latency'][0]:g} ms, jitter ≤ {th['voice']['jitter'][0]:g} ms, pertes ≤ "
                           f"{th['voice']['loss'][0]:g} %. Le MOS est une estimation calculée par l'E-model (ITU-T G.107) "
                           "à partir des paramètres réseau simulés.", small))
    return _build(story)


def _build(story):
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate

    buf = io.BytesIO()

    def deco(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(colors.HexColor("#0b1222"))
        canvas.rect(0, A4[1] - 9 * mm, A4[0], 9 * mm, stroke=0, fill=1)
        canvas.setFillColor(colors.HexColor("#22d3ee"))
        canvas.rect(0, A4[1] - 9.6 * mm, A4[0], 0.6 * mm, stroke=0, fill=1)
        canvas.setFont("Helvetica-Bold", 8)
        canvas.setFillColor(colors.white)
        canvas.drawString(18 * mm, A4[1] - 6 * mm, "QoS LAB · Network Control Center")
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.HexColor("#64748b"))
        canvas.drawRightString(A4[0] - 18 * mm, 10 * mm, f"Page {doc.page}")
        canvas.restoreState()

    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=18 * mm,
                            bottomMargin=16 * mm, title="Rapport QoS Lab", author="QoS Lab")
    doc.build(story, onFirstPage=deco, onLaterPages=deco)
    return buf.getvalue()
