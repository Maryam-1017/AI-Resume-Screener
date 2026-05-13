from pydantic import BaseModel
from typing import Optional


class ResumeScore(BaseModel):
    overall_score: float
    skills_score: float
    experience_score: float
    education_score: float
    feedback: str


class GitHubVerification(BaseModel):
    url: str
    is_valid: bool
    repo_count: Optional[int] = None
    has_activity: Optional[bool] = None
    error: Optional[str] = None


class ScreeningResult(BaseModel):
    candidate_name: str
    email: Optional[str] = None
    resume_text: str
    score: ResumeScore
    github: Optional[GitHubVerification] = None
    report_path: Optional[str] = None


class ScreeningRequest(BaseModel):
    job_description: str
    min_score: float = 0.0
