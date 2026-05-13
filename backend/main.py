import os
import tempfile
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

load_dotenv()

from parser import extract_text
from screener import screen
from reporter import generate_report

app = FastAPI(title="Resume Screener API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/screen")
async def screen_resume(
    file: UploadFile = File(...),
    job_description: str = Form(...),
):
    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        resume_text = extract_text(tmp_path)
        if not resume_text:
            raise HTTPException(status_code=422, detail="Could not extract text from PDF.")

        result = await screen(resume_text, job_description)
        report_path = generate_report(result)
        result.report_path = report_path
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    return result


@app.get("/report/{filename}")
async def download_report(filename: str):
    path = Path("reports") / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Report not found.")
    return FileResponse(str(path), media_type="application/pdf", filename=filename)


@app.get("/health")
async def health():
    return {"status": "ok"}
