from typing import Annotated, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class ScreeningRequest(BaseModel):
    job_description: str = Field(..., min_length=10)
    resume_text: str = Field(..., min_length=20)
    candidate_name: Optional[str] = None

    @field_validator("job_description", "resume_text", mode="before")
    @classmethod
    def strip_whitespace(cls, v: str) -> str:
        return v.strip()


class GitHubCheckResult(BaseModel):
    url: str = Field(..., pattern=r"^https?://(www\.)?github\.com/[A-Za-z0-9_.-]+/?$")
    exists: bool
    repo_count: Optional[Annotated[int, Field(ge=0)]] = None
    top_languages: Optional[List[str]] = None

    @field_validator("top_languages", mode="before")
    @classmethod
    def deduplicate_languages(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return v
        seen: set[str] = set()
        return [lang for lang in v if not (lang in seen or seen.add(lang))]  # type: ignore[func-returns-value]


class ScreeningResult(BaseModel):
    candidate_name: str = Field(..., min_length=1)
    score: Annotated[int, Field(ge=1, le=10)]
    strengths: List[str] = Field(..., min_length=1)
    gaps: List[str]
    experience_match: Literal["strong", "partial", "weak"]
    recommendation: Literal["hire", "maybe", "pass"]
    summary: str = Field(..., min_length=10)
    github_check: Optional[GitHubCheckResult] = None
    raw_json: dict

    @model_validator(mode="after")
    def recommendation_aligns_with_score(self) -> "ScreeningResult":
        if self.recommendation == "hire" and self.score < 7:
            raise ValueError("recommendation='hire' requires score >= 7")
        if self.recommendation == "pass" and self.score > 4:
            raise ValueError("recommendation='pass' requires score <= 4")
        return self


class _ResumeInput(BaseModel):
    name: str = Field(..., min_length=1)
    text: str = Field(..., min_length=20)


class BatchScreeningRequest(BaseModel):
    job_description: str = Field(..., min_length=10)
    resumes: List[_ResumeInput] = Field(..., min_length=1)

    @field_validator("job_description", mode="before")
    @classmethod
    def strip_whitespace(cls, v: str) -> str:
        return v.strip()

    @field_validator("resumes", mode="before")
    @classmethod
    def coerce_resume_dicts(cls, v: list) -> list:
        # Accept raw dicts and coerce to _ResumeInput
        return [_ResumeInput(**item) if isinstance(item, dict) else item for item in v]


class BatchScreeningResult(BaseModel):
    results: List[ScreeningResult] = Field(..., min_length=1)
    top_candidate: str
    total_screened: Annotated[int, Field(ge=1)]

    @model_validator(mode="after")
    def top_candidate_exists(self) -> "BatchScreeningResult":
        names = {r.candidate_name for r in self.results}
        if self.top_candidate not in names:
            raise ValueError(
                f"top_candidate '{self.top_candidate}' not found in results"
            )
        if self.total_screened != len(self.results):
            raise ValueError(
                f"total_screened ({self.total_screened}) must equal len(results) ({len(self.results)})"
            )
        return self


# ---------------------------------------------------------------------------
# Candidate comparison models
# ---------------------------------------------------------------------------

class CandidateRanking(BaseModel):
    rank: Annotated[int, Field(ge=1)]
    name: str = Field(..., min_length=1)
    one_line_verdict: str = Field(..., min_length=5)
    beats_next_because: Optional[str] = None  # None for last-place candidate

    @field_validator("one_line_verdict", "beats_next_because", mode="before")
    @classmethod
    def strip_text(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() if isinstance(v, str) else v


class ComparisonResult(BaseModel):
    recommended_hire: str = Field(..., min_length=1)
    ranking: List[CandidateRanking] = Field(..., min_length=1)
    panel_interview_shortlist: List[str] = Field(default_factory=list)
    red_flags: Dict[str, str] = Field(default_factory=dict)  # candidate_name → flag description
    hiring_memo: str = Field(..., min_length=20)
    job_description_summary: str = Field(..., min_length=5)
    total_candidates: Annotated[int, Field(ge=1)]

    @model_validator(mode="after")
    def validate_consistency(self) -> "ComparisonResult":
        candidate_names = {r.name for r in self.ranking}

        # recommended_hire must appear in the ranking
        if self.recommended_hire not in candidate_names:
            raise ValueError(
                f"recommended_hire '{self.recommended_hire}' is not present in ranking"
            )

        # shortlist members must all be ranked candidates
        unknown = set(self.panel_interview_shortlist) - candidate_names
        if unknown:
            raise ValueError(
                f"panel_interview_shortlist contains unknown candidates: {sorted(unknown)}"
            )

        # red_flag keys must all be ranked candidates
        unknown_flags = set(self.red_flags) - candidate_names
        if unknown_flags:
            raise ValueError(
                f"red_flags contains unknown candidates: {sorted(unknown_flags)}"
            )

        # ranks must be contiguous starting at 1 with no duplicates
        ranks = sorted(r.rank for r in self.ranking)
        expected = list(range(1, len(self.ranking) + 1))
        if ranks != expected:
            raise ValueError(
                f"ranking ranks must be contiguous integers starting at 1, got {ranks}"
            )

        # total_candidates must match the ranking list length
        if self.total_candidates != len(self.ranking):
            raise ValueError(
                f"total_candidates ({self.total_candidates}) must equal len(ranking) ({len(self.ranking)})"
            )

        # last-place candidate must have beats_next_because=None
        last = max(self.ranking, key=lambda r: r.rank)
        if last.beats_next_because is not None:
            raise ValueError(
                f"Last-place candidate '{last.name}' must have beats_next_because=None"
            )

        return self


class CompareResponse(BaseModel):
    individual_results: List[ScreeningResult] = Field(..., min_length=1)
    comparison: ComparisonResult
    screened_at: str = Field(..., description="ISO 8601 UTC timestamp")

    @field_validator("screened_at", mode="before")
    @classmethod
    def validate_iso_timestamp(cls, v: str) -> str:
        from datetime import datetime
        try:
            datetime.fromisoformat(v.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            raise ValueError(f"screened_at must be a valid ISO 8601 timestamp, got: {v!r}")
        return v

