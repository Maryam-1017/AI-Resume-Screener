import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from fastapi.middleware.cors import CORSMiddleware



load_dotenv()

_REQUIRED_ENV = ("OPENAI_API_KEY",)


def _check_required_env() -> None:
    missing = sorted(k for k in _REQUIRED_ENV if not os.getenv(k))
    if missing:
        raise RuntimeError(
            f"Missing required environment variable(s): {', '.join(missing)}. "
            "Copy .env.example → .env and fill in the values before starting the server."
        )

from models import BatchScreeningResult, ScreeningRequest, ScreeningResult
from parser import extract_resume_text
from reporter import generate_pdf_report
from screener import batch_screen, screen_candidate
from verifier import verify_github

logger = logging.getLogger(__name__)

# In-memory store: candidate_name → ScreeningResult.
# Populated by /screen and /screen/text; consumed by GET /report/{candidate_name}.
_report_cache: dict[str, ScreeningResult] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    _check_required_env()
    Path("reports").mkdir(exist_ok=True)
    yield


app = FastAPI(
    title="Resume Screener API",
    version="1.0.0",
    lifespan=lifespan,
)

_ALLOWED_ORIGINS = [o.strip() for o in os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:3000",
).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_origin_regex=r"https://.*\.vercel\.app",   # all Vercel preview deployments
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_ALLOWED_EXTENSIONS = {".pdf", ".docx"}


async def _parse_resume(upload: UploadFile) -> dict:
    """Read an UploadFile, validate it is a PDF or Word doc, and extract text."""
    filename = (upload.filename or "").strip()
    ext = Path(filename).suffix.lower()
    if ext not in _ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"'{filename}' is not supported. Upload a PDF (.pdf) or Word (.docx) file.",
        )
    file_bytes = await upload.read()
    try:
        return extract_resume_text(file_bytes, filename=filename)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))


async def _attach_github(result: ScreeningResult, github_urls: list[str]) -> ScreeningResult:
    """Verify the first GitHub URL found and attach the result. Never raises."""
    if not github_urls:
        return result
    try:
        github_check = await verify_github(github_urls[0])
        return result.model_copy(update={"github_check": github_check})
    except Exception as exc:
        logger.warning("GitHub verification failed, continuing without it: %s", exc)
        return result


def _cache_and_return(result: ScreeningResult) -> ScreeningResult:
    _report_cache[result.candidate_name] = result
    return result


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health", tags=["Meta"])
async def health():
    """Liveness check. Returns 200 when the service is running."""
    return {"status": "ok"}


@app.post("/screen", response_model=ScreeningResult, tags=["Screening"])
async def screen_pdf(
    pdf_file: UploadFile = File(..., description="Candidate résumé as a PDF."),
    job_description: str = Form(..., min_length=10, description="Full text of the job posting."),
):
    """
    Screen a single candidate from a PDF résumé.

    Extracts text from the uploaded PDF, scores the candidate with GPT-4o-mini,
    and — if a GitHub URL is present in the résumé — enriches the result with
    public profile data. The result is cached so GET /report/{candidate_name}
    can generate a PDF without requiring the file to be re-uploaded.
    """
    parsed = await _parse_resume(pdf_file)

    request = ScreeningRequest(
        job_description=job_description,
        resume_text=parsed["full_text"],
    )
    try:
        result = await screen_candidate(request)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))

    result = await _attach_github(result, parsed["github_urls"])
    return _cache_and_return(result)


@app.post("/screen/text", response_model=ScreeningResult, tags=["Screening"])
async def screen_text(
    resume_text: str = Form(..., min_length=20, description="Plain-text content of the résumé."),
    job_description: str = Form(..., min_length=10, description="Full text of the job posting."),
    candidate_name: str = Form(default="", description="Optional — pre-fills the candidate name."),
):
    """
    Screen a candidate from plain résumé text (no PDF upload required).

    Useful for testing, API integrations, or when text has already been
    extracted upstream. GitHub URLs are detected via regex and verified
    automatically if present.
    """
    from parser import _GITHUB_RE  # reuse the compiled regex from parser

    request = ScreeningRequest(
        job_description=job_description,
        resume_text=resume_text,
        candidate_name=candidate_name or None,
    )
    try:
        result = await screen_candidate(request)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))

    github_urls = _GITHUB_RE.findall(resume_text)
    result = await _attach_github(result, github_urls)
    return _cache_and_return(result)


@app.post("/batch", response_model=BatchScreeningResult, tags=["Screening"])
async def batch_screen_pdfs(
    job_description: str = Form(..., min_length=10, description="Full text of the job posting."),
    pdf_files: list[UploadFile] = File(..., description="One or more candidate résumé PDFs."),
):
    """
    Screen multiple candidates concurrently from a list of PDF résumés.

    All PDFs are parsed first; any unreadable file is skipped with a warning
    rather than aborting the entire batch. Screening runs in parallel via
    asyncio.gather. The response includes every result ranked by score and
    identifies the top candidate.
    """
    if not pdf_files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one PDF file is required.",
        )

    resumes: list[dict] = []
    for upload in pdf_files:
        try:
            parsed = await _parse_resume(upload)
            resumes.append({
                "name": Path(upload.filename or "Unknown").stem,
                "text": parsed["full_text"],
            })
        except HTTPException as exc:
            logger.warning("Skipping '%s': %s", upload.filename, exc.detail)

    if not resumes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No PDFs could be parsed. Check that the uploaded files contain extractable text.",
        )

    try:
        batch_result = await batch_screen(job_description, resumes)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))

    for result in batch_result.results:
        _report_cache[result.candidate_name] = result

    return batch_result


@app.get("/report/{candidate_name}", tags=["Reports"])
async def download_report(candidate_name: str):
    """
    Generate and download a PDF screening report for a previously screened candidate.

    The candidate must have been screened in the current server session via
    POST /screen, /screen/text, or /batch — their result is held in memory and
    used to render the PDF. Returns a downloadable application/pdf response.
    """
    result = _report_cache.get(candidate_name)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"No screening result found for '{candidate_name}'. "
                "Screen the candidate first via POST /screen or /screen/text."
            ),
        )

    try:
        pdf_bytes = generate_pdf_report(result)
    except Exception as exc:
        logger.error("PDF generation failed for '%s': %s", candidate_name, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate PDF report.",
        )

    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in candidate_name)
    filename = f"{safe_name}_report.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
    app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # replace later with Vercel domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)




   
