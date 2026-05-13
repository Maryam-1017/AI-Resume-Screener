from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from models import ScreeningResult


def generate_report(result: ScreeningResult, output_dir: str = "reports") -> str:
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    safe_name = result.candidate_name.replace(" ", "_")
    output_path = str(Path(output_dir) / f"{safe_name}_report.pdf")

    doc = SimpleDocTemplate(output_path, pagesize=A4, topMargin=2 * cm, bottomMargin=2 * cm)
    styles = getSampleStyleSheet()
    story = []

    title_style = ParagraphStyle("Title", parent=styles["Title"], fontSize=20, spaceAfter=12)
    story.append(Paragraph("Resume Screening Report", title_style))
    story.append(Spacer(1, 0.5 * cm))

    info_data = [
        ["Candidate", result.candidate_name],
        ["Email", result.email or "N/A"],
        ["Overall Score", f"{result.score.overall_score:.1f} / 10"],
    ]
    if result.github:
        info_data.append(["GitHub", result.github.url])
        info_data.append(["Repos", str(result.github.repo_count or "N/A")])
        info_data.append(["Recent Activity", "Yes" if result.github.has_activity else "No"])

    table = Table(info_data, colWidths=[5 * cm, 12 * cm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), colors.lightgrey),
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.whitesmoke, colors.white]),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.grey),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.grey),
        ("PADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(table)
    story.append(Spacer(1, 0.8 * cm))

    story.append(Paragraph("Score Breakdown", styles["Heading2"]))
    score_data = [
        ["Category", "Score"],
        ["Skills", f"{result.score.skills_score:.1f}"],
        ["Experience", f"{result.score.experience_score:.1f}"],
        ["Education", f"{result.score.education_score:.1f}"],
    ]
    score_table = Table(score_data, colWidths=[8 * cm, 4 * cm])
    score_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#4F46E5")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("ALIGN", (1, 0), (1, -1), "CENTER"),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.grey),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.grey),
        ("PADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(score_table)
    story.append(Spacer(1, 0.8 * cm))

    story.append(Paragraph("Feedback", styles["Heading2"]))
    story.append(Paragraph(result.score.feedback, styles["BodyText"]))

    doc.build(story)
    return output_path
