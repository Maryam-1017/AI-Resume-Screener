import fitz  # PyMuPDF
from pathlib import Path


def extract_text(pdf_path: str | Path) -> str:
    doc = fitz.open(str(pdf_path))
    text = "\n".join(page.get_text() for page in doc)
    doc.close()
    return text.strip()
