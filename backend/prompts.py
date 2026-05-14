import json
import re

SYSTEM_PROMPT = (
    "You are a senior technical recruiter with 15 years of experience evaluating "
    "software engineering candidates across startups and large-scale engineering "
    "organisations. You are precise, fair, and concise. You never add commentary "
    "outside of the structured output you are asked to produce."
)

_SCREENING_TEMPLATE = """\
Evaluate the candidate below for the role described and return ONLY a single \
JSON object — no markdown fences, no explanation, no text before or after the JSON.

### Job Description
{job_description}

### Resume
{resume_text}

### Required Output Schema
Return exactly this JSON structure with no extra keys:
{{
  "candidate_name": "<full name extracted from the resume, or \\"Unknown\\" if not found>",
  "score": <integer 1–10 reflecting overall fit for this specific role>,
  "strengths": [
    "<strength 1>",
    "<strength 2>",
    "<strength 3>"
  ],
  "gaps": [
    "<gap 1>",
    "<gap 2>",
    "<gap 3>"
  ],
  "experience_match": "<exactly one of: strong | partial | weak>",
  "recommendation": "<exactly one of: hire | maybe | pass>",
  "summary": "<2–3 sentences in a professional tone summarising the candidate's fit>"
}}

### Scoring and Recommendation Rules
- score 7–10  → recommendation must be "hire"
- score 4–6   → recommendation must be "maybe"
- score 1–3   → recommendation must be "pass"
- experience_match reflects depth of *directly relevant* experience only
- strengths and gaps must each contain exactly 3 items, each a single concise sentence
- Do not invent information not present in the resume
"""

_VALID_EXPERIENCE_MATCH = {"strong", "partial", "weak"}
_VALID_RECOMMENDATION = {"hire", "maybe", "pass"}
_REQUIRED_KEYS = {
    "candidate_name", "score", "strengths", "gaps",
    "experience_match", "recommendation", "summary",
}


def build_screening_prompt(job_description: str, resume_text: str) -> str:
    """Return a fully-rendered user-turn prompt for resume screening."""
    if not job_description or not job_description.strip():
        raise ValueError("job_description must not be empty.")
    if not resume_text or not resume_text.strip():
        raise ValueError("resume_text must not be empty.")
    return _SCREENING_TEMPLATE.format(
        job_description=job_description.strip(),
        resume_text=resume_text.strip(),
    )


def parse_llm_response(raw: str) -> dict:
    """
    Parse and validate the LLM's JSON response.

    Attempts a clean parse first, then falls back to extracting the first
    JSON object from the string when the model adds surrounding text despite
    instructions.  Raises ValueError with a descriptive message if the
    response cannot be recovered.
    """
    if not raw or not raw.strip():
        raise ValueError("LLM returned an empty response.")

    data = _try_parse(raw)

    missing = _REQUIRED_KEYS - data.keys()
    if missing:
        raise ValueError(f"LLM response missing required keys: {sorted(missing)}")

    # --- score ---
    try:
        data["score"] = int(data["score"])
    except (TypeError, ValueError):
        raise ValueError(f"'score' must be an integer, got: {data['score']!r}")
    if not (1 <= data["score"] <= 10):
        raise ValueError(f"'score' must be 1–10, got: {data['score']}")

    # --- lists of exactly 3 ---
    for field in ("strengths", "gaps"):
        if not isinstance(data[field], list):
            raise ValueError(f"'{field}' must be a list, got: {type(data[field]).__name__}")
        if len(data[field]) != 3:
            raise ValueError(f"'{field}' must contain exactly 3 items, got {len(data[field])}")

    # --- literals ---
    exp = str(data["experience_match"]).lower()
    if exp not in _VALID_EXPERIENCE_MATCH:
        raise ValueError(
            f"'experience_match' must be one of {sorted(_VALID_EXPERIENCE_MATCH)}, got: {exp!r}"
        )
    data["experience_match"] = exp

    rec = str(data["recommendation"]).lower()
    if rec not in _VALID_RECOMMENDATION:
        raise ValueError(
            f"'recommendation' must be one of {sorted(_VALID_RECOMMENDATION)}, got: {rec!r}"
        )
    data["recommendation"] = rec

    # --- score / recommendation consistency ---
    score = data["score"]
    if rec == "hire" and score < 7:
        raise ValueError(f"recommendation='hire' requires score >= 7, got score={score}")
    if rec == "pass" and score > 3:
        raise ValueError(f"recommendation='pass' requires score <= 3, got score={score}")
    if rec == "maybe" and not (4 <= score <= 6):
        raise ValueError(f"recommendation='maybe' requires score 4–6, got score={score}")

    # --- summary is non-empty string ---
    if not isinstance(data["summary"], str) or not data["summary"].strip():
        raise ValueError("'summary' must be a non-empty string.")

    return data


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _try_parse(raw: str) -> dict:
    """Try a direct JSON parse, then fall back to extracting the first {...} block."""
    text = raw.strip()

    # Direct parse (ideal case)
    try:
        result = json.loads(text)
        if isinstance(result, dict):
            return result
    except json.JSONDecodeError:
        pass

    # Strip common markdown fences the model might add despite instructions
    fence_stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.DOTALL).strip()
    try:
        result = json.loads(fence_stripped)
        if isinstance(result, dict):
            return result
    except json.JSONDecodeError:
        pass

    # Last resort: find the first top-level {...} block via brace matching
    start = text.find("{")
    if start != -1:
        depth = 0
        for i, ch in enumerate(text[start:], start):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        result = json.loads(text[start : i + 1])
                        if isinstance(result, dict):
                            return result
                    except json.JSONDecodeError:
                        break

    raise ValueError(
        f"Could not extract valid JSON from LLM response. "
        f"First 200 chars: {raw[:200]!r}"
    )
