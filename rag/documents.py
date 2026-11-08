"""Upload validation, text extraction (PDF / TXT) and chunking."""

import io
import os
import re

from pypdf import PdfReader

from . import config

ALLOWED_EXTENSIONS = {".pdf", ".txt"}


class DocumentError(Exception):
    """A problem with an uploaded document that is safe to show to the user."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# ---------------------------------------------------------------- validation
def clean_filename(filename: str) -> str:
    name = os.path.basename((filename or "").replace("\\", "/"))
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    return name[:120]


def validate_upload(filename: str, data: bytes) -> tuple[str, str]:
    """Return (safe_name, extension) or raise DocumentError."""
    name = clean_filename(filename)
    if not name:
        raise DocumentError("No file selected.")
    ext = os.path.splitext(name)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise DocumentError("Unsupported file type. Please upload a PDF or TXT file.", 415)
    if not data:
        raise DocumentError("The file is empty.")
    limit = config.max_upload_bytes()
    if len(data) > limit:
        raise DocumentError(f"File is too large. The maximum size is {limit // (1024 * 1024)} MB.", 413)
    if ext == ".pdf" and not data.lstrip()[:1024].startswith(b"%PDF"):
        raise DocumentError("This file is not a valid PDF (it does not start with a PDF header).", 415)
    return name, ext


# ---------------------------------------------------------------- extraction
def normalize_text(text: str) -> str:
    text = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_pdf(data: bytes) -> list[tuple[int, str]]:
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            try:
                ok = reader.decrypt("")
            except Exception:
                ok = 0
            if not ok:
                raise DocumentError("This PDF is password-protected. Remove the password and try again.")
        total_pages = len(reader.pages)
        if total_pages > config.max_pages():
            raise DocumentError(f"This PDF has {total_pages} pages. The limit is {config.max_pages()} pages.", 413)
        pages = []
        for number, page in enumerate(reader.pages, start=1):
            text = normalize_text(page.extract_text() or "")
            if text:
                pages.append((number, text))
    except DocumentError:
        raise
    except Exception:
        raise DocumentError("Could not read this PDF. The file may be corrupted.") from None

    if sum(len(t) for _, t in pages) > config.max_chars():
        raise DocumentError("This PDF contains too much text. Upload a shorter file or split it into parts.", 413)
    if sum(len(t) for _, t in pages) < 20:
        raise DocumentError(
            "No readable text was found in this PDF. Scanned or image-only PDFs are not supported (no OCR)."
        )
    return pages


def decode_text(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", errors="replace")
    if b"\x00" in data[:4096]:
        raise DocumentError("This file looks like a binary file, not plain text.", 415)
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("cp1252", errors="replace")


def extract_text(data: bytes) -> list[tuple[int, str]]:
    text = normalize_text(decode_text(data))
    if len(text) < 20:
        raise DocumentError("The text file has too little content to index.")
    if len(text) > config.max_chars():
        raise DocumentError("This text file is too long. Upload a shorter file or split it into parts.", 413)
    return [(0, text)]  # page 0 means "no page numbers" (plain text)


def extract(filename: str, data: bytes) -> tuple[str, list[tuple[int, str]]]:
    """Validate and extract. Returns (safe_filename, [(page_number, text), ...])."""
    name, ext = validate_upload(filename, data)
    pages = extract_pdf(data) if ext == ".pdf" else extract_text(data)
    return name, pages


# ------------------------------------------------------------------ chunking
_SEPARATORS = ("\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ")


def split_text(text: str, size: int, overlap: int) -> list[str]:
    """Split text into overlapping chunks of at most `size` characters,
    preferring paragraph, line and sentence boundaries."""
    text = text.strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]

    overlap = max(0, min(overlap, size // 2))
    chunks: list[str] = []
    start, n = 0, len(text)
    while start < n:
        end = min(start + size, n)
        if end < n:
            window_start = start + size // 2
            for sep in _SEPARATORS:
                idx = text.rfind(sep, window_start, end)
                if idx != -1:
                    end = idx + len(sep)
                    break
        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= n:
            break
        nxt = max(end - overlap, start + 1)
        while nxt < end and not text[nxt - 1].isspace():  # never start mid-word
            nxt += 1
        start = nxt
    return chunks


def chunk_pages(pages: list[tuple[int, str]]) -> list[dict]:
    """Chunk every page. Returns [{"text", "page", "chunk"}]; chunks never span pages."""
    size, overlap = config.chunk_size(), config.chunk_overlap()
    out: list[dict] = []
    for page, text in pages:
        for piece in split_text(text, size, overlap):
            out.append({"text": piece, "page": page, "chunk": len(out)})
    return out
