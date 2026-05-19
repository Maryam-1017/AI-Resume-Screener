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
# Comparison prompt
# ---------------------------------------------------------------------------

_COMPARISON_TEMPLATE = """\
You are a senior technical recruiter writing an executive hiring memo. \
You have already scored each candidate individually. Your task is to compare \
them against each other for the specific role below and produce a single \
JSON hiring recommendation — no markdown fences, no preamble, no text \
outside the JSON object.

### Job Description
{job_description}

### Candidate Summaries (individual AI scores already assigned)
{candidate_block}

### Required Output Schema
Return exactly this JSON object with no extra keys:
{{
  "recommended_hire": "<full name of the single best candidate>",
  "job_description_summary": "<one sentence capturing the core requirement of this role>",
  "ranking": [
    {{
      "rank": 1,
      "name": "<candidate name>",
      "one_line_verdict": "<one sentence on why this rank>",
      "beats_next_because": "<specific skill or experience from the JD that gives this candidate the edge over rank+1>"
    }},
    {{
      "rank": 2,
      "name": "...",
      "one_line_verdict": "...",
      "beats_next_because": "..."
    }}
    // ... one entry per candidate; last-place entry must have beats_next_because set to null
  ],
  "panel_interview_shortlist": ["<name>", "..."],
  "red_flags": {{
    "<candidate_name>": "<specific, evidence-based concern — not generic>"
  }},
  "hiring_memo": "<3–4 sentence executive summary written for a hiring manager, not an engineer — focus on business impact, team fit, and risk>"
}}

### Strict Rules
- ranking must include every candidate exactly once, numbered 1 to {n_candidates}
- ranks must reflect the individual scores already provided — do not contradict them
- beats_next_because must reference a specific skill, technology, or experience \
mentioned in the Job Description above, not a generic statement
- beats_next_because for the last-ranked candidate must be null (they have no one below them)
- panel_interview_shortlist should contain candidates worth interviewing despite \
not being the top pick (score ≥ 5); can be empty if no one qualifies
- red_flags must only call out concrete evidence visible in the candidate summaries; \
omit a candidate entirely if there is no specific concern
- hiring_memo is written for a VP or hiring manager: focus on business value, \
growth potential, and risk — avoid jargon and score numbers
- recommended_hire must be the rank-1 candidate
"""

_COMPARISON_REQUIRED_KEYS = {
    "recommended_hire", "job_description_summary", "ranking",
    "panel_interview_shortlist", "red_flags", "hiring_memo",
}


def build_comparison_prompt(job_desc: str, candidates: list[dict]) -> str:
    """
    Build the user-turn prompt for multi-candidate comparison.

    Each item in *candidates* must have at minimum:
        name (str), score (int), strengths (list[str]), gaps (list[str])
    Optional keys (summary, experience_match, recommendation) are included
    when present.

    Raises ValueError if job_desc is empty or candidates list is empty.
    """
    if not job_desc or not job_desc.strip():
        raise ValueError("job_desc must not be empty.")
    if not candidates:
        raise ValueError("candidates list must not be empty.")

    lines: list[str] = []
    for i, c in enumerate(candidates, 1):
        name   = c.get("name") or c.get("candidate_name") or f"Candidate {i}"
        score  = c.get("score", "N/A")
        strengths = c.get("strengths", [])
        gaps      = c.get("gaps", [])

        block = [f"{i}. {name}  (score: {score}/10)"]

        if rec := c.get("recommendation"):
            block.append(f"   Recommendation : {rec.upper()}")
        if exp := c.get("experience_match"):
            block.append(f"   Experience match: {exp}")
        if summary := c.get("summary"):
            block.append(f"   Summary         : {summary}")

        if strengths:
            block.append("   Strengths:")
            for s in strengths:
                block.append(f"     • {s}")
        if gaps:
            block.append("   Gaps:")
            for g in gaps:
                block.append(f"     • {g}")

        lines.append("\n".join(block))

    candidate_block = "\n\n".join(lines)

    return _COMPARISON_TEMPLATE.format(
        job_description=job_desc.strip(),
        candidate_block=candidate_block,
        n_candidates=len(candidates),
    )


def parse_comparison_response(raw: str) -> dict:
    """
    Parse and validate the LLM's comparison JSON using the same three-tier
    fallback strategy as parse_llm_response:

      Tier 1 — direct json.loads
      Tier 2 — strip markdown fences, then json.loads
      Tier 3 — brace-depth scan to extract the first {...} block

    Raises ValueError with a descriptive message if all three tiers fail or
    if the parsed object is missing required keys.
    """
    if not raw or not raw.strip():
        raise ValueError("LLM returned an empty comparison response.")

    data = _try_parse(raw)

    # ── Required keys ────────────────────────────────────────────────────────
    missing = _COMPARISON_REQUIRED_KEYS - data.keys()
    if missing:
        raise ValueError(
            f"Comparison response missing required keys: {sorted(missing)}"
        )

    # ── recommended_hire ─────────────────────────────────────────────────────
    if not isinstance(data["recommended_hire"], str) or not data["recommended_hire"].strip():
        raise ValueError("'recommended_hire' must be a non-empty string.")
    data["recommended_hire"] = data["recommended_hire"].strip()

    # ── job_description_summary ──────────────────────────────────────────────
    if not isinstance(data["job_description_summary"], str) or not data["job_description_summary"].strip():
        raise ValueError("'job_description_summary' must be a non-empty string.")

    # ── ranking ──────────────────────────────────────────────────────────────
    if not isinstance(data["ranking"], list) or not data["ranking"]:
        raise ValueError("'ranking' must be a non-empty list.")

    seen_ranks: set[int] = set()
    for entry in data["ranking"]:
        if not isinstance(entry, dict):
            raise ValueError(f"Each ranking entry must be a dict, got: {type(entry).__name__}")

        for key in ("rank", "name", "one_line_verdict"):
            if key not in entry:
                raise ValueError(f"Ranking entry missing required key: '{key}'")

        try:
            entry["rank"] = int(entry["rank"])
        except (TypeError, ValueError):
            raise ValueError(f"ranking[].rank must be an integer, got: {entry['rank']!r}")
        if entry["rank"] < 1:
            raise ValueError(f"ranking[].rank must be >= 1, got: {entry['rank']}")
        if entry["rank"] in seen_ranks:
            raise ValueError(f"Duplicate rank value: {entry['rank']}")
        seen_ranks.add(entry["rank"])

        if not isinstance(entry["name"], str) or not entry["name"].strip():
            raise ValueError("ranking[].name must be a non-empty string.")
        if not isinstance(entry["one_line_verdict"], str) or not entry["one_line_verdict"].strip():
            raise ValueError("ranking[].one_line_verdict must be a non-empty string.")

        # beats_next_because: must be str or null/None
        btn = entry.get("beats_next_because")
        if btn is not None and not isinstance(btn, str):
            raise ValueError(
                f"ranking[].beats_next_because must be a string or null, got: {type(btn).__name__}"
            )
        entry["beats_next_because"] = btn.strip() if isinstance(btn, str) else None

    # Ranks must be contiguous starting at 1
    expected = set(range(1, len(data["ranking"]) + 1))
    if seen_ranks != expected:
        raise ValueError(
            f"ranking ranks must be contiguous integers 1–{len(data['ranking'])}, got: {sorted(seen_ranks)}"
        )

    # Last-place candidate must have beats_next_because=None
    last = max(data["ranking"], key=lambda e: e["rank"])
    if last.get("beats_next_because") is not None:
        raise ValueError(
            f"Last-place candidate '{last['name']}' must have beats_next_because set to null."
        )

    # recommended_hire must be rank-1
    rank1 = min(data["ranking"], key=lambda e: e["rank"])
    if rank1["name"] != data["recommended_hire"]:
        raise ValueError(
            f"recommended_hire ('{data['recommended_hire']}') must be the rank-1 candidate "
            f"('{rank1['name']}')."
        )

    # ── panel_interview_shortlist ─────────────────────────────────────────────
    if not isinstance(data["panel_interview_shortlist"], list):
        raise ValueError("'panel_interview_shortlist' must be a list.")
    data["panel_interview_shortlist"] = [str(n).strip() for n in data["panel_interview_shortlist"]]

    # ── red_flags ─────────────────────────────────────────────────────────────
    if not isinstance(data["red_flags"], dict):
        raise ValueError("'red_flags' must be a JSON object (dict).")

    # ── hiring_memo ───────────────────────────────────────────────────────────
    if not isinstance(data["hiring_memo"], str) or not data["hiring_memo"].strip():
        raise ValueError("'hiring_memo' must be a non-empty string.")

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
