import json
import os
from openai import AsyncOpenAI
from models import ResumeScore, GitHubVerification, ScreeningResult
from prompts import SCREENING_PROMPT, EXTRACTION_PROMPT
from verifier import verify_github

client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))


async def _chat(prompt: str) -> str:
    response = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
    )
    return response.choices[0].message.content


async def extract_metadata(resume_text: str) -> dict:
    raw = await _chat(EXTRACTION_PROMPT.format(resume_text=resume_text))
    return json.loads(raw)


async def score_resume(resume_text: str, job_description: str) -> ResumeScore:
    raw = await _chat(SCREENING_PROMPT.format(
        job_description=job_description,
        resume_text=resume_text,
    ))
    data = json.loads(raw)
    return ResumeScore(**data)


async def screen(resume_text: str, job_description: str) -> ScreeningResult:
    metadata, score = await _gather(
        extract_metadata(resume_text),
        score_resume(resume_text, job_description),
    )

    github: GitHubVerification | None = None
    if metadata.get("github_url"):
        github = await verify_github(metadata["github_url"])

    return ScreeningResult(
        candidate_name=metadata.get("candidate_name", "Unknown"),
        email=metadata.get("email"),
        resume_text=resume_text,
        score=score,
        github=github,
    )


async def _gather(*coros):
    import asyncio
    return await asyncio.gather(*coros)
