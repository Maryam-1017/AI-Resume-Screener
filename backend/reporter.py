import io
from datetime import date
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm, mm
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.flowables import Flowable

from models import CompareResponse, ScreeningResult

# ---------------------------------------------------------------------------
# Palette
# ---------------------------------------------------------------------------
_INDIGO = colors.HexColor("#4F46E5")
_INDIGO_LIGHT = colors.HexColor("#EEF2FF")
_GREEN = colors.HexColor("#16a34a")
_GREEN_LIGHT = colors.HexColor("#dcfce7")
_AMBER = colors.HexColor("#d97706")
_AMBER_LIGHT = colors.HexColor("#fef9c3")
_RED = colors.HexColor("#dc2626")
_RED_LIGHT = colors.HexColor("#fee2e2")
_GREY_BG = colors.HexColor("#f9fafb")
_GREY_BORDER = colors.HexColor("#e5e7eb")
_TEXT_DARK = colors.HexColor("#111827")
_TEXT_MID = colors.HexColor("#374151")

_REC_COLORS = {
    "hire":  (_GREEN,  _GREEN_LIGHT),
    "maybe": (_AMBER,  _AMBER_LIGHT),
    "pass":  (_RED,    _RED_LIGHT),
}
_SCORE_COLOR = {
    range(1, 5):  _RED,
    range(5, 7):  _AMBER,
    range(7, 11): _GREEN,
}

PAGE_W, PAGE_H = A4
MARGIN = 2 * cm
CONTENT_W = PAGE_W - 2 * MARGIN


# ---------------------------------------------------------------------------
# Custom flowables
# ---------------------------------------------------------------------------

class _ScoreBar(Flowable):
    """Horizontal bar that fills proportionally to score/10."""

    HEIGHT = 10 * mm
    RADIUS = 4

    def __init__(self, score: int, width: float = CONTENT_W):
        super().__init__()
        self.score = score
        self.width = width
        self.height = self.HEIGHT

    def _score_color(self) -> colors.Color:
        for r, c in _SCORE_COLOR.items():
            if self.score in r:
                return c
        return _GREY_BORDER

    def draw(self):
        c = self.canv
        bar_color = self._score_color()
        fill_w = self.width * (self.score / 10)

        # Track (background)
        c.setFillColor(_GREY_BORDER)
        c.roundRect(0, 0, self.width, self.HEIGHT, self.RADIUS, fill=1, stroke=0)

        # Fill
        c.setFillColor(bar_color)
        c.roundRect(0, 0, fill_w, self.HEIGHT, self.RADIUS, fill=1, stroke=0)

        # Score label centred on the bar
        c.setFillColor(colors.white)
        c.setFont("Helvetica-Bold", 9)
        label = f"{self.score}/10"
        c.drawCentredString(fill_w / 2, (self.HEIGHT - 9) / 2 + 1, label)


class _RecommendationBadge(Flowable):
    """A pill-shaped coloured badge for HIRE / MAYBE / PASS."""

    PAD_H = 6 * mm
    PAD_V = 3 * mm
    RADIUS = 5

    def __init__(self, recommendation: str):
        super().__init__()
        self.label = recommendation.upper()
        fg, bg = _REC_COLORS.get(recommendation, (colors.grey, _GREY_BG))
        self.fg = fg
        self.bg = bg
        # Fixed size — centred in content width
        self.width = CONTENT_W
        self.height = 14 * mm

    def draw(self):
        c = self.canv
        badge_w = 6 * cm
        badge_h = 12 * mm
        x = (CONTENT_W - badge_w) / 2
        y = (self.height - badge_h) / 2

        c.setFillColor(self.bg)
        c.roundRect(x, y, badge_w, badge_h, self.RADIUS, fill=1, stroke=0)

        c.setStrokeColor(self.fg)
        c.setLineWidth(1.5)
        c.roundRect(x, y, badge_w, badge_h, self.RADIUS, fill=0, stroke=1)

        c.setFillColor(self.fg)
        c.setFont("Helvetica-Bold", 16)
        c.drawCentredString(CONTENT_W / 2, y + (badge_h - 16) / 2 + 1, self.label)


class _HireBox(Flowable):
    """Full-width green box: '✓ RECOMMENDED HIRE' label + large candidate name."""

    RADIUS = 8

    def __init__(self, name: str, width: float = CONTENT_W):
        super().__init__()
        self.name = name
        self.width = width
        self.height = 38 * mm

    def draw(self):
        c = self.canv
        h = self.height

        # Background + border
        c.setFillColor(_GREEN_LIGHT)
        c.setStrokeColor(_GREEN)
        c.setLineWidth(1.5)
        c.roundRect(0, 0, self.width, h, self.RADIUS, fill=1, stroke=1)

        # Top label
        c.setFillColor(_GREEN)
        c.setFont("Helvetica-Bold", 10)
        c.drawCentredString(self.width / 2, h - 15, "✓  RECOMMENDED HIRE")

        # Thin divider below label
        c.setStrokeColor(colors.HexColor("#86efac"))
        c.setLineWidth(0.75)
        c.line(MARGIN, h - 20, self.width - MARGIN, h - 20)

        # Candidate name — scale font down for long names
        font_size = min(22, max(13, int(300 / max(len(self.name), 1))))
        c.setFillColor(_TEXT_DARK)
        c.setFont("Helvetica-Bold", font_size)
        c.drawCentredString(self.width / 2, h / 2 - font_size / 2 - 2, self.name)


class _PillRow(Flowable):
    """Horizontally-wrapping row of indigo pill badges (for shortlist names)."""

    PILL_H   = 8 * mm
    PILL_PAD = 10        # horizontal text padding inside each pill
    GAP      = 6         # gap between pills

    def __init__(self, names: list[str], width: float = CONTENT_W):
        super().__init__()
        self.names   = names
        self.width   = width
        self.height  = self._compute_height()

    def _pill_w(self, name: str) -> float:
        # Helvetica 9pt ≈ 5.5pt per char; add padding on both sides
        return max(2.5 * cm, len(name) * 5.5 + 2 * self.PILL_PAD)

    def _rows(self) -> list[list[str]]:
        rows: list[list[str]] = [[]]
        x = 0.0
        for name in self.names:
            pw = self._pill_w(name)
            if x + pw > self.width and rows[-1]:
                rows.append([])
                x = 0.0
            rows[-1].append(name)
            x += pw + self.GAP
        return rows

    def _compute_height(self) -> float:
        r = self._rows()
        return len(r) * (self.PILL_H + self.GAP) + 2

    def draw(self):
        c = self.canv
        rows = self._rows()
        y = self.height - self.PILL_H - 1
        for row in rows:
            x = 0.0
            for name in row:
                pw = self._pill_w(name)
                c.setFillColor(_INDIGO_LIGHT)
                c.setStrokeColor(_INDIGO)
                c.setLineWidth(1)
                c.roundRect(x, y, pw, self.PILL_H, 4, fill=1, stroke=1)
                c.setFillColor(_INDIGO)
                c.setFont("Helvetica-Bold", 9)
                c.drawCentredString(
                    x + pw / 2,
                    y + (self.PILL_H - 9) / 2 + 1,
                    name,
                )
                x += pw + self.GAP
            y -= self.PILL_H + self.GAP


class _WarningHeader(Flowable):
    """Amber warning banner used as the red-flags page title."""

    RADIUS = 6

    def __init__(self, text: str, width: float = CONTENT_W):
        super().__init__()
        self.text  = text
        self.width = width
        self.height = 14 * mm

    def draw(self):
        c = self.canv
        c.setFillColor(_AMBER_LIGHT)
        c.setStrokeColor(_AMBER)
        c.setLineWidth(1.5)
        c.roundRect(0, 0, self.width, self.height, self.RADIUS, fill=1, stroke=1)
        c.setFillColor(_AMBER)
        c.setFont("Helvetica-Bold", 11)
        c.drawCentredString(
            self.width / 2,
            (self.height - 11) / 2 + 1,
            f"⚠  {self.text}",
        )


# ---------------------------------------------------------------------------
# Page template with header rule and footer
# ---------------------------------------------------------------------------

def _make_doc(buffer: io.BytesIO) -> BaseDocTemplate:
    def _add_chrome(canvas, doc):
        canvas.saveState()

        # Top rule
        canvas.setStrokeColor(_INDIGO)
        canvas.setLineWidth(3)
        canvas.line(MARGIN, PAGE_H - MARGIN + 4 * mm, PAGE_W - MARGIN, PAGE_H - MARGIN + 4 * mm)

        # Footer
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#9ca3af"))
        canvas.drawCentredString(PAGE_W / 2, MARGIN - 8 * mm, "Generated by AI Resume Screener")
        canvas.drawRightString(
            PAGE_W - MARGIN,
            MARGIN - 8 * mm,
            f"Page {doc.page}",
        )

        canvas.restoreState()

    doc = BaseDocTemplate(
        buffer,
        pagesize=A4,
        topMargin=MARGIN,
        bottomMargin=MARGIN,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
    )
    frame = Frame(MARGIN, MARGIN, CONTENT_W, PAGE_H - 2 * MARGIN, id="main")
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=_add_chrome)])
    return doc


# ---------------------------------------------------------------------------
# Style registry
# ---------------------------------------------------------------------------

def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "report_title": ParagraphStyle(
            "ReportTitle",
            fontName="Helvetica-Bold",
            fontSize=22,
            textColor=_INDIGO,
            spaceAfter=2,
            alignment=TA_LEFT,
        ),
        "subtitle": ParagraphStyle(
            "Subtitle",
            fontName="Helvetica",
            fontSize=11,
            textColor=_TEXT_MID,
            spaceAfter=0,
            alignment=TA_LEFT,
        ),
        "section_heading": ParagraphStyle(
            "SectionHeading",
            fontName="Helvetica-Bold",
            fontSize=11,
            textColor=_INDIGO,
            spaceBefore=10,
            spaceAfter=4,
            borderPad=(0, 0, 2, 0),
        ),
        "body": ParagraphStyle(
            "Body",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=10,
            textColor=_TEXT_DARK,
            leading=15,
        ),
        "bullet": ParagraphStyle(
            "Bullet",
            fontName="Helvetica",
            fontSize=10,
            textColor=_TEXT_DARK,
            leading=15,
            leftIndent=6,
            firstLineIndent=0,
            bulletIndent=0,
        ),
        "score_label": ParagraphStyle(
            "ScoreLabel",
            fontName="Helvetica-Bold",
            fontSize=28,
            textColor=_TEXT_DARK,
            alignment=TA_CENTER,
            spaceAfter=4,
        ),
        "col_header": ParagraphStyle(
            "ColHeader",
            fontName="Helvetica-Bold",
            fontSize=10,
            textColor=colors.white,
            alignment=TA_CENTER,
        ),
        "meta_label": ParagraphStyle(
            "MetaLabel",
            fontName="Helvetica-Bold",
            fontSize=9,
            textColor=_TEXT_MID,
        ),
        "meta_value": ParagraphStyle(
            "MetaValue",
            fontName="Helvetica",
            fontSize=9,
            textColor=_TEXT_DARK,
        ),
    }


# ---------------------------------------------------------------------------
# Section builders
# ---------------------------------------------------------------------------

def _header_section(result: ScreeningResult, st: dict) -> list:
    today = date.today().strftime("%B %d, %Y")
    return [
        Paragraph("Hiring Recommendation Report", st["report_title"]),
        Paragraph(f"{result.candidate_name}  ·  {today}", st["subtitle"]),
        Spacer(1, 3 * mm),
        _hr(),
        Spacer(1, 4 * mm),
    ]


def _score_section(result: ScreeningResult, st: dict) -> list:
    score_color = _RED
    for r, c in _SCORE_COLOR.items():
        if result.score in r:
            score_color = c

    story = [
        Paragraph("Score", st["section_heading"]),
        Paragraph(
            f'<font color="#{_hex(score_color)}">{result.score}</font>'
            f'<font color="#9ca3af">/10</font>',
            st["score_label"],
        ),
        _ScoreBar(result.score),
        Spacer(1, 4 * mm),
    ]
    return story


def _badge_section(result: ScreeningResult) -> list:
    return [
        _RecommendationBadge(result.recommendation),
        Spacer(1, 4 * mm),
    ]


def _meta_row(label: str, value: str, st: dict) -> Table:
    t = Table(
        [[Paragraph(label, st["meta_label"]), Paragraph(value, st["meta_value"])]],
        colWidths=[4 * cm, CONTENT_W - 4 * cm],
    )
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("PADDING", (0, 0), (-1, -1), 3),
    ]))
    return t


def _meta_section(result: ScreeningResult, st: dict) -> list:
    match_label = {"strong": "Strong ✓", "partial": "Partial ~", "weak": "Weak ✗"}.get(
        result.experience_match, result.experience_match
    )
    rows = [
        Paragraph("Details", st["section_heading"]),
        _meta_row("Experience Match", match_label, st),
    ]

    if result.github_check:
        gh = result.github_check
        status = "Verified" if gh.exists else "Not found"
        rows.append(_meta_row("GitHub Profile", f"{gh.url}  ({status})", st))
        if gh.repo_count is not None:
            rows.append(_meta_row("Public Repos", str(gh.repo_count), st))
        if gh.top_languages:
            rows.append(_meta_row("Top Languages", ",  ".join(gh.top_languages), st))

    rows.append(Spacer(1, 3 * mm))
    return rows


def _strengths_gaps_section(result: ScreeningResult, st: dict) -> list:
    col_w = (CONTENT_W - 3 * mm) / 2

    def _bullet_cells(items: list[str]) -> list[Paragraph]:
        return [Paragraph(f"• {item}", st["bullet"]) for item in items]

    header_row = [
        Paragraph("Strengths", st["col_header"]),
        Paragraph("Gaps", st["col_header"]),
    ]
    content_rows = list(zip(_bullet_cells(result.strengths), _bullet_cells(result.gaps)))

    table = Table([header_row, *content_rows], colWidths=[col_w, col_w], spaceBefore=2)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _INDIGO),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [_GREY_BG, colors.white]),
        ("BOX", (0, 0), (-1, -1), 0.5, _GREY_BORDER),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, _GREY_BORDER),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("PADDING", (0, 0), (-1, -1), 7),
        ("LINEAFTER", (0, 0), (0, -1), 0.5, _GREY_BORDER),
    ]))

    return [
        Paragraph("Strengths &amp; Gaps", st["section_heading"]),
        table,
        Spacer(1, 4 * mm),
    ]


def _summary_section(result: ScreeningResult, st: dict) -> list:
    return [
        Paragraph("Summary", st["section_heading"]),
        Paragraph(result.summary, st["body"]),
        Spacer(1, 3 * mm),
    ]


# ---------------------------------------------------------------------------
# Comparison helpers
# ---------------------------------------------------------------------------

def _score_color_for(score: int) -> colors.Color:
    for r, c in _SCORE_COLOR.items():
        if score in r:
            return c
    return _GREY_BORDER


def _callout_box(rank_a: int, name_a: str, rank_b: int, name_b: str, reason: str) -> Table:
    """
    Indented callout box: '#{rank_a} beats #{rank_b}' with the reason text.
    Returns a two-column Table whose left cell provides the 2cm left indent.
    """
    title_st = ParagraphStyle(
        "CBTitle", fontName="Helvetica-Bold", fontSize=9,
        textColor=_INDIGO, spaceAfter=2,
    )
    body_st = ParagraphStyle(
        "CBBody", fontName="Helvetica", fontSize=9,
        textColor=_TEXT_DARK, leading=13,
    )
    inner_w = CONTENT_W - 2 * cm
    inner = Table(
        [
            [Paragraph(f"Why #{rank_a} beats #{rank_b}", title_st)],
            [Paragraph(
                f"<b>{name_a}</b> edges out <b>{name_b}</b>: {reason}",
                body_st,
            )],
        ],
        colWidths=[inner_w],
    )
    inner.setStyle(TableStyle([
        ("BACKGROUND",   (0, 0), (-1, -1), _INDIGO_LIGHT),
        ("LINEBEFORE",   (0, 0), (0, -1),  3, _INDIGO),
        ("LEFTPADDING",  (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING",   (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 6),
        ("VALIGN",       (0, 0), (-1, -1), "TOP"),
    ]))
    # Outer table adds the left indent
    outer = Table([["", inner]], colWidths=[2 * cm, inner_w])
    outer.setStyle(TableStyle([
        ("PADDING",  (0, 0), (-1, -1), 0),
        ("VALIGN",   (0, 0), (-1, -1), "TOP"),
    ]))
    return outer


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _hr() -> Table:
    """Full-width horizontal rule."""
    t = Table([[""]], colWidths=[CONTENT_W])
    t.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, _GREY_BORDER),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return t


def _hex(color: colors.Color) -> str:
    """Return 6-char hex string (without #) for a ReportLab Color."""
    return "{:02x}{:02x}{:02x}".format(
        int(color.red * 255),
        int(color.green * 255),
        int(color.blue * 255),
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def generate_comparison_report(response: CompareResponse) -> bytes:
    """
    Render a CompareResponse to a multi-page PDF and return raw bytes.

    Page 1 — Executive Summary: recommended hire box, shortlist pills, memo.
    Page 2 — Candidate Rankings: scored table + "Why #N beats #N+1" callouts.
    Page 3 — Red Flags (omitted when red_flags is empty).
    """
    buffer = io.BytesIO()
    doc    = _make_doc(buffer)
    st     = _styles()
    cmp    = response.comparison
    today  = date.today().strftime("%B %d, %Y")

    # Build case-insensitive name → (score, first_gap) lookup from individual results.
    # Names may differ between the two LLM passes, so best-effort matching is intentional.
    _score_lookup: dict[str, int] = {}
    _gap_lookup:   dict[str, str] = {}
    for r in response.individual_results:
        key = r.candidate_name.lower()
        _score_lookup[key] = r.score
        _gap_lookup[key]   = r.gaps[0] if r.gaps else "—"

    def _lookup_score(name: str) -> int | None:
        return _score_lookup.get(name.lower())

    def _lookup_gap(name: str) -> str:
        return _gap_lookup.get(name.lower(), "—")

    sorted_ranking = sorted(cmp.ranking, key=lambda e: e.rank)
    story: list = []

    # ═══════════════════════════════════════════════════════════════════════
    # PAGE 1 — Executive Summary
    # ═══════════════════════════════════════════════════════════════════════

    story.append(Paragraph("Hiring Decision Report", st["report_title"]))
    story.append(Paragraph(
        f"{today}  ·  {cmp.total_candidates} candidates  ·  {cmp.job_description_summary}",
        st["subtitle"],
    ))
    story.append(Spacer(1, 3 * mm))
    story.append(_hr())
    story.append(Spacer(1, 6 * mm))

    # Recommended hire — large green box
    story.append(_HireBox(cmp.recommended_hire))
    story.append(Spacer(1, 6 * mm))

    # Shortlist pill badges
    if cmp.panel_interview_shortlist:
        story.append(Paragraph("Panel Interview Shortlist", st["section_heading"]))
        story.append(Spacer(1, 2 * mm))
        story.append(_PillRow(cmp.panel_interview_shortlist))
        story.append(Spacer(1, 6 * mm))

    # Hiring memo
    story.append(Paragraph("Hiring Memo", st["section_heading"]))
    story.append(Paragraph(cmp.hiring_memo, st["body"]))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════════════════════
    # PAGE 2 — Candidate Rankings
    # ═══════════════════════════════════════════════════════════════════════

    story.append(Paragraph("Candidate Rankings", st["report_title"]))
    story.append(Spacer(1, 3 * mm))
    story.append(_hr())
    story.append(Spacer(1, 6 * mm))

    # Column widths: Rank | Candidate | Score | Verdict | Key Gap = CONTENT_W
    _CW = [1.2 * cm, 4.2 * cm, 2.2 * cm, 5.2 * cm, 4.2 * cm]

    score_col_st = ParagraphStyle(
        "ScoreCell", fontName="Helvetica-Bold", fontSize=10,
        alignment=TA_CENTER, textColor=_TEXT_DARK,
    )

    header_row = [
        Paragraph("Rank",      st["col_header"]),
        Paragraph("Candidate", st["col_header"]),
        Paragraph("Score",     st["col_header"]),
        Paragraph("Verdict",   st["col_header"]),
        Paragraph("Key Gap",   st["col_header"]),
    ]
    rank_rows = [header_row]
    for entry in sorted_ranking:
        score = _lookup_score(entry.name)
        if score is not None:
            sc = _score_color_for(score)
            score_cell = Paragraph(
                f'<font color="#{_hex(sc)}"><b>{score}/10</b></font>',
                score_col_st,
            )
        else:
            score_cell = Paragraph("—", score_col_st)

        rank_rows.append([
            Paragraph(str(entry.rank),          st["body"]),
            Paragraph(entry.name,               st["body"]),
            score_cell,
            Paragraph(entry.one_line_verdict,   st["body"]),
            Paragraph(_lookup_gap(entry.name),  st["body"]),
        ])

    rank_table = Table(rank_rows, colWidths=_CW)
    ts = TableStyle([
        # Header row
        ("BACKGROUND",    (0, 0), (-1, 0),  _INDIGO),
        ("TEXTCOLOR",     (0, 0), (-1, 0),  colors.white),
        # Rank-1 row gets a green tint
        ("BACKGROUND",    (0, 1), (-1, 1),  _GREEN_LIGHT),
        # Remaining rows alternate
        ("ROWBACKGROUNDS",(0, 2), (-1, -1), [colors.white, _GREY_BG]),
        # Borders
        ("BOX",           (0, 0), (-1, -1), 0.5, _GREY_BORDER),
        ("INNERGRID",     (0, 0), (-1, -1), 0.25, _GREY_BORDER),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("ALIGN",         (0, 0), (0, -1),  "CENTER"),   # rank col centred
        ("ALIGN",         (2, 0), (2, -1),  "CENTER"),   # score col centred
        ("PADDING",       (0, 0), (-1, -1), 6),
    ])
    rank_table.setStyle(ts)
    story.append(rank_table)
    story.append(Spacer(1, 6 * mm))

    # "Why #N beats #N+1" callout boxes for each consecutive pair
    callouts: list = []
    for i in range(len(sorted_ranking) - 1):
        a = sorted_ranking[i]
        b = sorted_ranking[i + 1]
        if a.beats_next_because:
            callouts.append(
                KeepTogether([
                    _callout_box(a.rank, a.name, b.rank, b.name, a.beats_next_because),
                    Spacer(1, 3 * mm),
                ])
            )
    story.extend(callouts)

    # ═══════════════════════════════════════════════════════════════════════
    # PAGE 3 — Red Flags  (only when non-empty)
    # ═══════════════════════════════════════════════════════════════════════

    if cmp.red_flags:
        story.append(PageBreak())

        story.append(_WarningHeader("Red Flags — Review Carefully Before Proceeding"))
        story.append(Spacer(1, 6 * mm))

        flag_st = ParagraphStyle(
            "FlagBody", fontName="Helvetica", fontSize=10,
            textColor=_TEXT_DARK, leading=15, spaceAfter=4,
        )
        name_st = ParagraphStyle(
            "FlagName", fontName="Helvetica-Bold", fontSize=10,
            textColor=colors.HexColor("#92400e"),   # amber-900
        )

        for candidate, flag in cmp.red_flags.items():
            flag_rows = [
                [
                    Paragraph(candidate, name_st),
                    Paragraph(flag,      flag_st),
                ]
            ]
            flag_table = Table(flag_rows, colWidths=[4.5 * cm, CONTENT_W - 4.5 * cm])
            flag_table.setStyle(TableStyle([
                ("BACKGROUND",    (0, 0), (-1, -1), _AMBER_LIGHT),
                ("BOX",           (0, 0), (-1, -1), 0.75, _AMBER),
                ("LINEBEFORE",    (0, 0), (0, -1),  4, _AMBER),
                ("LEFTPADDING",   (0, 0), (-1, -1), 10),
                ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
                ("TOPPADDING",    (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("VALIGN",        (0, 0), (-1, -1), "TOP"),
            ]))
            story.append(flag_table)
            story.append(Spacer(1, 3 * mm))

        story.append(Spacer(1, 8 * mm))
        story.append(_hr())
        story.append(Spacer(1, 3 * mm))
        story.append(Paragraph(
            "Red flags are generated by an AI language model and reflect information "
            "present in the résumé text. They should be independently verified by a "
            "human recruiter before being used in any hiring decision.",
            ParagraphStyle(
                "Disclaimer", fontName="Helvetica-Oblique", fontSize=8,
                textColor=colors.HexColor("#6b7280"), leading=12,
            ),
        ))

    doc.build(story)
    return buffer.getvalue()


def generate_pdf_report(result: ScreeningResult) -> bytes:
    """
    Render a ScreeningResult to a PDF and return the raw bytes.

    Uses an in-memory buffer — no temp files are left on disk.
    The caller (main.py) is responsible for writing or streaming the bytes.
    """
    buffer = io.BytesIO()
    doc = _make_doc(buffer)
    st = _styles()

    story: list = []
    story += _header_section(result, st)
    story += _score_section(result, st)
    story += _badge_section(result)
    story += _strengths_gaps_section(result, st)
    story += _meta_section(result, st)
    story += _summary_section(result, st)

    doc.build(story)
    return buffer.getvalue()
