from typing import Annotated, List, Literal, Optional

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
