import asyncio
import logging
import os

from openai import AsyncOpenAI, APIError, APITimeoutError, RateLimitError

from models import BatchScreeningResult, ScreeningRequest, ScreeningResult
from prompts import SYSTEM_PROMPT, build_screening_prompt, parse_llm_response

logger = logging.getLogger(__name__)

_MODEL = "llama-3.3-70b-versatile"   # Groq model; swap to gpt-4o-mini if using OpenAI
_TEMPERATURE = 0.2

# Module-level client — reuses the same connection pool across all calls.
# OPENAI_BASE_URL switches the endpoint (e.g. https://api.groq.com/openai/v1 for Groq).
_client = AsyncOpenAI(
    api_key=os.getenv("OPENAI_API_KEY"),
    base_url=os.getenv("OPENAI_BASE_URL"),  # None → uses OpenAI's default
)


async def _call_llm(user_prompt: str) -> str:
    """Send a single chat completion request and return the raw content string."""
    try:
        response = await _client.chat.completions.create(
            model=_MODEL,
            temperature=_TEMPERATURE,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        )
    except RateLimitError as exc:
        raise RuntimeError("OpenAI rate limit reached — retry after a short delay.") from exc
    except APITimeoutError as exc:
        raise RuntimeError("OpenAI request timed out.") from exc
    except APIError as exc:
        raise RuntimeError(f"OpenAI API error: {exc}") from exc

    content = response.choices[0].message.content
    if not content:
        raise ValueError("OpenAI returned an empty response body.")
    return content


async def screen_candidate(request: ScreeningRequest) -> ScreeningResult:
    """
    Screen a single candidate against the job description.

    Raises:
        ValueError:  if the LLM response cannot be parsed or fails validation.
        RuntimeError: on OpenAI transport / rate-limit errors.
    """
    prompt = build_screening_prompt(
        job_description=request.job_description,
        resume_text=request.resume_text,
    )

    raw = await _call_llm(prompt)
    data = parse_llm_response(raw)

    # Prefer the name supplied by the caller; fall back to what the LLM found.
    candidate_name = (
        request.candidate_name.strip()
        if request.candidate_name and request.candidate_name.strip()
        else data.get("candidate_name", "Unknown")
    )

    result = ScreeningResult(
        candidate_name=candidate_name,
        score=data["score"],
        strengths=data["strengths"],
        gaps=data["gaps"],
        experience_match=data["experience_match"],
        recommendation=data["recommendation"],
        summary=data["summary"],
        raw_json=data,
    )

    if result.score >= 7:
        logger.info(
            "STRONG CANDIDATE — %s | score: %d/10 | recommendation: %s",
            result.candidate_name,
            result.score,
            result.recommendation,
        )

    return result


async def _screen_one(job_description: str, resume: dict) -> ScreeningResult:
    """Thin wrapper used by batch_screen to screen a single resume dict."""
    request = ScreeningRequest(
        job_description=job_description,
        resume_text=resume["text"],
        candidate_name=resume.get("name"),
    )
    try:
        return await screen_candidate(request)
    except Exception as exc:
        # Return a minimal failed result so one bad resume never aborts the batch.
        name = resume.get("name") or "Unknown"
        logger.warning("Screening failed for '%s': %s", name, exc)
        return ScreeningResult(
            candidate_name=name,
            score=1,
            strengths=["N/A", "N/A", "N/A"],
            gaps=["Could not be screened", "N/A", "N/A"],
            experience_match="weak",
            recommendation="pass",
            summary=f"Screening failed due to an error: {exc}",
            raw_json={"error": str(exc)},
        )


async def batch_screen(job_desc: str, resumes: list[dict]) -> BatchScreeningResult:
    """
    Screen all resumes concurrently and return a ranked BatchScreeningResult.

    Each item in `resumes` must have the keys: "name" (str) and "text" (str).
    Failed screenings are included as score-1 / pass results so the batch
    always completes.
    """
    if not resumes:
        raise ValueError("resumes list must not be empty.")

    results: list[ScreeningResult] = await asyncio.gather(
        *[_screen_one(job_desc, resume) for resume in resumes]
    )

    top = max(results, key=lambda r: r.score)

    logger.info(
        "Batch complete — %d screened | top candidate: %s (score %d/10)",
        len(results),
        top.candidate_name,
        top.score,
    )

    return BatchScreeningResult(
        results=results,
        top_candidate=top.candidate_name,
        total_screened=len(results),
    )
