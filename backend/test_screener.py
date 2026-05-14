"""
Backend test suite.

Run from the project root:
    pytest backend/ -v

Or from inside backend/:
    pytest -v
"""

import io
import json

import pytest
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer
from reportlab.lib.units import cm

# conftest.py sets OPENAI_API_KEY / SERPER_API_KEY before these imports.
from parser import extract_resume_text
from prompts import parse_llm_response

# ---------------------------------------------------------------------------
# Shared fixtures / helpers
# ---------------------------------------------------------------------------

_VALID_PAYLOAD: dict = {
    "candidate_name": "Jane Doe",
    "score": 8,
    "strengths": [
        "Deep Python expertise with 6 years of production experience.",
        "Strong open-source contribution history on GitHub.",
        "Excellent system-design skills demonstrated across three roles.",
    ],
    "gaps": [
        "No formal team-lead or people-management experience.",
        "Limited exposure to frontend technologies.",
        "No cloud certifications (AWS / GCP).",
    ],
    "experience_match": "strong",
    "recommendation": "hire",
    "summary": (
        "Jane is a strong backend candidate who aligns well with the role. "
        "Her Python depth and open-source work stand out. "
        "A short ramp-up on cloud infrastructure is the only notable gap."
    ),
}


def _make_pdf(body: str) -> bytes:
    """Return raw PDF bytes with *body* rendered as plain paragraphs."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, topMargin=2 * cm, bottomMargin=2 * cm)
    styles = getSampleStyleSheet()
    story = [
        Paragraph(line, styles["Normal"])
        for line in body.splitlines()
        if line.strip()
    ]
    doc.build(story)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# parse_llm_response — happy paths
# ---------------------------------------------------------------------------

class TestParseLlmResponseValid:
    def test_clean_json_returns_dict(self):
        result = parse_llm_response(json.dumps(_VALID_PAYLOAD))
        assert result["candidate_name"] == "Jane Doe"
        assert result["score"] == 8
        assert result["recommendation"] == "hire"
        assert result["experience_match"] == "strong"
        assert len(result["strengths"]) == 3
        assert len(result["gaps"]) == 3
        assert isinstance(result["summary"], str)

    def test_strips_markdown_fences(self):
        wrapped = f"```json\n{json.dumps(_VALID_PAYLOAD)}\n```"
        result = parse_llm_response(wrapped)
        assert result["score"] == 8

    def test_extracts_json_from_prose_preamble(self):
        prose = (
            "Sure, here is the structured evaluation you requested:\n\n"
            + json.dumps(_VALID_PAYLOAD)
            + "\n\nI hope that helps!"
        )
        result = parse_llm_response(prose)
        assert result["recommendation"] == "hire"

    def test_normalises_literal_case(self):
        payload = {**_VALID_PAYLOAD, "experience_match": "STRONG", "recommendation": "HIRE"}
        result = parse_llm_response(json.dumps(payload))
        assert result["experience_match"] == "strong"
        assert result["recommendation"] == "hire"

    def test_score_cast_from_string(self):
        payload = {**_VALID_PAYLOAD, "score": "8"}
        result = parse_llm_response(json.dumps(payload))
        assert result["score"] == 8

    def test_maybe_recommendation_accepted(self):
        payload = {
            **_VALID_PAYLOAD,
            "score": 5,
            "recommendation": "maybe",
            "experience_match": "partial",
        }
        result = parse_llm_response(json.dumps(payload))
        assert result["recommendation"] == "maybe"

    def test_pass_recommendation_accepted(self):
        payload = {
            **_VALID_PAYLOAD,
            "score": 3,
            "recommendation": "pass",
            "experience_match": "weak",
        }
        result = parse_llm_response(json.dumps(payload))
        assert result["recommendation"] == "pass"


# ---------------------------------------------------------------------------
# parse_llm_response — error paths
# ---------------------------------------------------------------------------

class TestParseLlmResponseErrors:
    def test_empty_string_raises(self):
        with pytest.raises(ValueError, match="empty"):
            parse_llm_response("")

    def test_whitespace_only_raises(self):
        with pytest.raises(ValueError, match="empty"):
            parse_llm_response("   \n\t  ")

    def test_missing_score_key_raises(self):
        payload = {k: v for k, v in _VALID_PAYLOAD.items() if k != "score"}
        with pytest.raises(ValueError, match="score"):
            parse_llm_response(json.dumps(payload))

    def test_missing_strengths_key_raises(self):
        payload = {k: v for k, v in _VALID_PAYLOAD.items() if k != "strengths"}
        with pytest.raises(ValueError, match="strengths"):
            parse_llm_response(json.dumps(payload))

    def test_score_above_ten_raises(self):
        payload = {**_VALID_PAYLOAD, "score": 11}
        with pytest.raises(ValueError, match=r"1.10"):
            parse_llm_response(json.dumps(payload))

    def test_score_zero_raises(self):
        payload = {**_VALID_PAYLOAD, "score": 0}
        with pytest.raises(ValueError, match=r"1.10"):
            parse_llm_response(json.dumps(payload))

    def test_hire_with_low_score_raises(self):
        payload = {**_VALID_PAYLOAD, "score": 3, "recommendation": "hire"}
        with pytest.raises(ValueError, match="hire"):
            parse_llm_response(json.dumps(payload))

    def test_pass_with_high_score_raises(self):
        payload = {**_VALID_PAYLOAD, "score": 8, "recommendation": "pass"}
        with pytest.raises(ValueError, match="pass"):
            parse_llm_response(json.dumps(payload))

    def test_invalid_experience_match_raises(self):
        payload = {**_VALID_PAYLOAD, "experience_match": "excellent"}
        with pytest.raises(ValueError, match="experience_match"):
            parse_llm_response(json.dumps(payload))

    def test_invalid_recommendation_raises(self):
        payload = {**_VALID_PAYLOAD, "recommendation": "interview"}
        with pytest.raises(ValueError, match="recommendation"):
            parse_llm_response(json.dumps(payload))

    def test_strengths_too_short_raises(self):
        payload = {**_VALID_PAYLOAD, "strengths": ["only one item"]}
        with pytest.raises(ValueError, match="3"):
            parse_llm_response(json.dumps(payload))

    def test_gaps_too_long_raises(self):
        payload = {**_VALID_PAYLOAD, "gaps": ["a", "b", "c", "d"]}
        with pytest.raises(ValueError, match="3"):
            parse_llm_response(json.dumps(payload))

    def test_totally_malformed_raises(self):
        with pytest.raises(ValueError, match="JSON"):
            parse_llm_response("This is not JSON at all!!!")

    def test_empty_summary_raises(self):
        payload = {**_VALID_PAYLOAD, "summary": "   "}
        with pytest.raises(ValueError, match="summary"):
            parse_llm_response(json.dumps(payload))


# ---------------------------------------------------------------------------
# extract_resume_text
# ---------------------------------------------------------------------------

_RESUME_BODY = """
Jane Doe
jane.doe@example.com
https://github.com/janedoe

Senior Python Engineer with 6 years of backend experience.
Skilled in FastAPI, PostgreSQL, and distributed systems.
"""


class TestExtractResumeText:
    @pytest.fixture(scope="class")
    def parsed(self):
        pdf_bytes = _make_pdf(_RESUME_BODY)
        return extract_resume_text(pdf_bytes)

    def test_returns_nonempty_full_text(self, parsed):
        assert isinstance(parsed["full_text"], str)
        assert len(parsed["full_text"]) > 20

    def test_candidate_name_in_text(self, parsed):
        assert "Jane Doe" in parsed["full_text"]

    def test_page_count_is_one(self, parsed):
        assert parsed["page_count"] == 1

    def test_word_count_is_positive(self, parsed):
        assert parsed["word_count"] >= 10

    def test_email_extracted(self, parsed):
        assert parsed["email"] == "jane.doe@example.com"

    def test_github_url_extracted(self, parsed):
        assert any("github.com/janedoe" in u for u in parsed["github_urls"])

    def test_github_urls_deduplicated(self):
        body = (
            "https://github.com/janedoe\n"
            "GitHub: https://github.com/janedoe\n"
            "Some text.\n"
        )
        result = extract_resume_text(_make_pdf(body))
        urls = [u.lower() for u in result["github_urls"]]
        assert len(urls) == len(set(urls)), "Duplicate URLs were not removed"

    def test_empty_bytes_raises(self):
        with pytest.raises(ValueError, match="empty"):
            extract_resume_text(b"")

    def test_non_pdf_bytes_raises(self):
        with pytest.raises(ValueError):
            extract_resume_text(b"this is definitely not a PDF")

    def test_multipage_pdf_page_count(self):
        long_text = ("Python Engineer. " * 80 + "\n") * 60
        result = extract_resume_text(_make_pdf(long_text))
        assert result["page_count"] >= 2

    def test_no_email_returns_none(self):
        result = extract_resume_text(_make_pdf("John Smith\nSoftware Engineer\nNo email here."))
        assert result["email"] is None

    def test_no_github_returns_empty_list(self):
        result = extract_resume_text(_make_pdf("Jane Doe\njane@example.com\nNo GitHub link."))
        assert result["github_urls"] == []


# ---------------------------------------------------------------------------
# /health endpoint  (uses FastAPI TestClient — no external I/O)
# ---------------------------------------------------------------------------

from fastapi.testclient import TestClient
from main import app  # noqa: E402 — imported after env vars are set by conftest


class TestHealthEndpoint:
    @pytest.fixture(scope="class")
    def client(self):
        with TestClient(app) as c:
            yield c

    def test_returns_200(self, client):
        response = client.get("/health")
        assert response.status_code == 200

    def test_returns_ok_status(self, client):
        response = client.get("/health")
        assert response.json() == {"status": "ok"}

    def test_method_not_allowed_for_post(self, client):
        response = client.post("/health")
        assert response.status_code == 405
