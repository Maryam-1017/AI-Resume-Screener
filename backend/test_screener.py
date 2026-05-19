"""
Backend test suite.

Run from the project root:
    pytest backend/ -v

Or from inside backend/:
    pytest -v
"""

import io
import json
from unittest.mock import AsyncMock, patch

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


# ---------------------------------------------------------------------------
# Comparison — prompt builder and response parser
# ---------------------------------------------------------------------------

from prompts import build_comparison_prompt, parse_comparison_response  # noqa: E402

_MOCK_CANDIDATES = [
    {
        "name": "Alice Johnson",
        "score": 9,
        "strengths": ["FastAPI expertise", "System design", "Open-source work"],
        "gaps": ["No ML", "Limited frontend", "No cloud certs"],
        "recommendation": "hire",
        "experience_match": "strong",
        "summary": "Alice is a strong fit.",
    },
    {
        "name": "Bob Smith",
        "score": 6,
        "strengths": ["Django experience", "SQL skills", "REST APIs"],
        "gaps": ["No k8s", "No Docker", "No CI/CD"],
        "recommendation": "maybe",
        "experience_match": "partial",
        "summary": "Bob is a partial fit.",
    },
    {
        "name": "Carol Lee",
        "score": 3,
        "strengths": ["Communication", "Documentation", "Testing"],
        "gaps": ["No backend", "No Python", "No databases"],
        "recommendation": "pass",
        "experience_match": "weak",
        "summary": "Carol is not a fit for this role.",
    },
]

_VALID_COMPARISON_PAYLOAD: dict = {
    "recommended_hire": "Alice Johnson",
    "job_description_summary": "Senior Python backend engineer for a fintech startup.",
    "ranking": [
        {
            "rank": 1,
            "name": "Alice Johnson",
            "one_line_verdict": "Top candidate — strong FastAPI and system design.",
            "beats_next_because": "Three years of FastAPI in production versus Bob's general Django.",
        },
        {
            "rank": 2,
            "name": "Bob Smith",
            "one_line_verdict": "Solid fundamentals but limited cloud experience.",
            "beats_next_because": "Bob has a working REST portfolio; Carol has none.",
        },
        {
            "rank": 3,
            "name": "Carol Lee",
            "one_line_verdict": "Junior-level; not ready for a senior role.",
            "beats_next_because": None,
        },
    ],
    "panel_interview_shortlist": ["Bob Smith"],
    "red_flags": {
        "Carol Lee": "No backend deployments mentioned despite 4 years claimed experience."
    },
    "hiring_memo": (
        "Alice Johnson is the clear hire. Her FastAPI background directly matches the JD. "
        "Bob Smith is a reasonable backup if Alice declines. "
        "Carol Lee requires significant upskilling before being considered."
    ),
}


class TestComparison:
    # ── Prompt builder ────────────────────────────────────────────────────────

    def test_build_comparison_prompt_includes_all_candidates(self):
        prompt = build_comparison_prompt(
            "Senior Python engineer role.", _MOCK_CANDIDATES
        )
        assert "Alice Johnson" in prompt
        assert "Bob Smith" in prompt
        assert "Carol Lee" in prompt

    def test_build_comparison_prompt_includes_scores(self):
        prompt = build_comparison_prompt(
            "Senior Python engineer role.", _MOCK_CANDIDATES
        )
        # Each score should appear somewhere in the block
        assert "9/10" in prompt or "score: 9" in prompt
        assert "6/10" in prompt or "score: 6" in prompt

    def test_build_comparison_prompt_includes_job_description(self):
        jd = "We need a senior Rust developer with 5+ years experience."
        prompt = build_comparison_prompt(jd, _MOCK_CANDIDATES)
        assert jd in prompt

    def test_build_comparison_prompt_empty_job_raises(self):
        with pytest.raises(ValueError, match="job_desc"):
            build_comparison_prompt("", _MOCK_CANDIDATES)

    def test_build_comparison_prompt_empty_candidates_raises(self):
        with pytest.raises(ValueError, match="candidates"):
            build_comparison_prompt("Senior engineer.", [])

    # ── Response parser — happy paths ─────────────────────────────────────────

    def test_parse_comparison_response_happy_path(self):
        raw = json.dumps(_VALID_COMPARISON_PAYLOAD)
        result = parse_comparison_response(raw)

        assert result["recommended_hire"] == "Alice Johnson"
        assert result["job_description_summary"] == _VALID_COMPARISON_PAYLOAD["job_description_summary"]
        assert len(result["ranking"]) == 3
        assert result["ranking"][0]["rank"] == 1
        assert result["ranking"][0]["name"] == "Alice Johnson"
        assert result["ranking"][2]["beats_next_because"] is None
        assert result["panel_interview_shortlist"] == ["Bob Smith"]
        assert "Carol Lee" in result["red_flags"]
        assert isinstance(result["hiring_memo"], str)

    def test_parse_comparison_response_markdown_fences(self):
        wrapped = f"```json\n{json.dumps(_VALID_COMPARISON_PAYLOAD)}\n```"
        result = parse_comparison_response(wrapped)
        assert result["recommended_hire"] == "Alice Johnson"
        assert len(result["ranking"]) == 3

    def test_parse_comparison_response_prose_preamble(self):
        prose = (
            "Here is my analysis of the candidates:\n\n"
            + json.dumps(_VALID_COMPARISON_PAYLOAD)
            + "\n\nLet me know if you need anything else."
        )
        result = parse_comparison_response(prose)
        assert result["recommended_hire"] == "Alice Johnson"

    # ── Response parser — error paths ─────────────────────────────────────────

    def test_parse_comparison_response_invalid_raises(self):
        with pytest.raises(ValueError, match="JSON"):
            parse_comparison_response("not json at all !!! garbage text")

    def test_parse_comparison_response_empty_raises(self):
        with pytest.raises(ValueError, match="empty"):
            parse_comparison_response("")

    def test_parse_comparison_response_missing_key_raises(self):
        payload = {k: v for k, v in _VALID_COMPARISON_PAYLOAD.items() if k != "ranking"}
        with pytest.raises(ValueError, match="ranking"):
            parse_comparison_response(json.dumps(payload))

    def test_parse_comparison_response_duplicate_ranks_raises(self):
        payload = {
            **_VALID_COMPARISON_PAYLOAD,
            "ranking": [
                {**_VALID_COMPARISON_PAYLOAD["ranking"][0], "rank": 1},
                {**_VALID_COMPARISON_PAYLOAD["ranking"][1], "rank": 1},  # duplicate
                {**_VALID_COMPARISON_PAYLOAD["ranking"][2], "rank": 3},
            ],
        }
        with pytest.raises(ValueError, match="rank"):
            parse_comparison_response(json.dumps(payload))

    def test_parse_comparison_response_last_place_not_null_raises(self):
        payload = {
            **_VALID_COMPARISON_PAYLOAD,
            "ranking": [
                {**_VALID_COMPARISON_PAYLOAD["ranking"][0]},
                {**_VALID_COMPARISON_PAYLOAD["ranking"][1]},
                # last place has beats_next_because set — should fail
                {**_VALID_COMPARISON_PAYLOAD["ranking"][2], "beats_next_because": "Something"},
            ],
        }
        with pytest.raises(ValueError, match="null"):
            parse_comparison_response(json.dumps(payload))

    def test_parse_comparison_response_recommended_hire_not_rank1_raises(self):
        payload = {
            **_VALID_COMPARISON_PAYLOAD,
            "recommended_hire": "Bob Smith",  # rank-2 candidate
        }
        with pytest.raises(ValueError, match="rank-1"):
            parse_comparison_response(json.dumps(payload))

    # ── /compare endpoint — file-count validation ──────────────────────────────

    @pytest.fixture(scope="class")
    def client(self):
        with TestClient(app) as c:
            yield c

    def test_compare_endpoint_requires_minimum_two_files(self, client):
        """Sending a single PDF must return HTTP 422 before any LLM call."""
        pdf_bytes = _make_pdf("Alice Johnson\nalice@example.com\nPython engineer.")
        response = client.post(
            "/compare",
            data={"job_description": "Senior Python engineer with 5 years experience."},
            files=[("pdf_files", ("alice.pdf", pdf_bytes, "application/pdf"))],
        )
        assert response.status_code == 422
        assert "2" in response.json()["detail"]

    def test_compare_endpoint_rejects_more_than_ten(self, client):
        """Sending 11 PDFs must return HTTP 422 before parsing any file."""
        pdf_bytes = _make_pdf("Candidate\ncandidate@example.com\nEngineer.")
        eleven_files = [
            ("pdf_files", (f"resume_{i}.pdf", pdf_bytes, "application/pdf"))
            for i in range(11)
        ]
        response = client.post(
            "/compare",
            data={"job_description": "Senior Python engineer with 5 years experience."},
            files=eleven_files,
        )
        assert response.status_code == 422
        assert "10" in response.json()["detail"]

    @patch("main.batch_screen", new_callable=AsyncMock)
    @patch("main.run_comparison", new_callable=AsyncMock)
    def test_compare_endpoint_success_with_mocks(
        self, mock_run_comparison, mock_batch_screen, client
    ):
        """
        Two valid PDFs + mocked backend calls → 200 with individual_results.
        Verifies the endpoint wires up batch_screen and run_comparison correctly
        without hitting any real API.
        """
        from models import ScreeningResult, BatchScreeningResult

        alice = ScreeningResult(
            candidate_name="Alice Johnson", score=9, recommendation="hire",
            experience_match="strong",
            strengths=["Python", "FastAPI", "Docker"],
            gaps=["No ML", "Limited frontend", "No certs"],
            summary="Alice is a strong fit.", raw_json={},
        )
        bob = ScreeningResult(
            candidate_name="Bob Smith", score=5, recommendation="maybe",
            experience_match="partial",
            strengths=["Django", "SQL", "REST"],
            gaps=["No k8s", "No Docker", "No CI/CD"],
            summary="Bob is a partial fit.", raw_json={},
        )
        mock_batch_screen.return_value = BatchScreeningResult(
            results=[alice, bob],
            top_candidate="Alice Johnson",
            total_screened=2,
        )
        mock_run_comparison.return_value = {
            "recommended_hire": "Alice Johnson",
            "job_description_summary": "Senior Python engineer.",
            "ranking": [
                {"rank": 1, "name": "Alice Johnson",
                 "one_line_verdict": "Top candidate.", "beats_next_because": "FastAPI expertise"},
                {"rank": 2, "name": "Bob Smith",
                 "one_line_verdict": "Decent but gaps.", "beats_next_because": None},
            ],
            "panel_interview_shortlist": [],
            "red_flags": {},
            "hiring_memo": "Alice is the clear hire. Bob is a backup.",
            "total_candidates": 2,
        }

        alice_pdf = _make_pdf("Alice Johnson\nalice@example.com\nPython FastAPI engineer.")
        bob_pdf   = _make_pdf("Bob Smith\nbob@example.com\nDjango SQL developer.")

        response = client.post(
            "/compare",
            data={"job_description": "Senior Python engineer with 5 years experience."},
            files=[
                ("pdf_files", ("alice.pdf", alice_pdf, "application/pdf")),
                ("pdf_files", ("bob.pdf",   bob_pdf,   "application/pdf")),
            ],
        )

        assert response.status_code == 200
        body = response.json()
        assert len(body["individual_results"]) == 2
        assert body["comparison"]["recommended_hire"] == "Alice Johnson"
        assert mock_batch_screen.called
        assert mock_run_comparison.called
