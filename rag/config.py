"""Central configuration, read from environment variables.

Only one secret is needed: GROQ_API_KEY. Values are read through functions (not at
import time) so `.env` loading, Vercel Environment Variables and tests all behave the same.
"""

import os


def env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip().strip("\"'").strip()


def _int(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(env(name, str(default))))
    except ValueError:
        return default


# ---- Groq (chat model) ------------------------------------------------------
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b"


def groq_api_key() -> str:
    return env("GROQ_API_KEY")


def groq_model() -> str:
    return env("GROQ_MODEL", DEFAULT_GROQ_MODEL)


DEFAULT_MODELS = "openai/gpt-oss-20b,openai/gpt-oss-120b"


def groq_models() -> list[str]:
    """Models the user may pick in the UI (comma separated GROQ_MODELS). The default model is always first."""
    listed = [m.strip().strip("\"'") for m in (os.environ.get("GROQ_MODELS") or DEFAULT_MODELS).split(",")]
    models = [groq_model()]
    for m in listed:
        if m and m not in models:
            models.append(m)
    return models


def system_prompt_override() -> str:
    return (os.environ.get("SYSTEM_PROMPT") or "").strip()


def max_answer_tokens() -> int:
    return _int("MAX_ANSWER_TOKENS", 1024, 100)


def on_vercel() -> bool:
    return bool(os.environ.get("VERCEL"))


# ---- Chunking ---------------------------------------------------------------
def chunk_size() -> int:
    return _int("CHUNK_SIZE", 800, 200)


def chunk_overlap() -> int:
    return min(_int("CHUNK_OVERLAP", 120, 0), chunk_size() // 2)


# ---- Upload limits ----------------------------------------------------------
# Vercel rejects request/response bodies above 4.5 MB, so stay well below that.
def max_upload_bytes() -> int:
    return _int("MAX_UPLOAD_MB", 3, 1) * 1024 * 1024


def max_pages() -> int:
    return _int("MAX_PDF_PAGES", 150, 1)


def max_chars() -> int:
    return _int("MAX_TEXT_CHARS", 1_500_000, 1000)


def max_chunks() -> int:
    return _int("MAX_CHUNKS_PER_DOC", 3000, 1)


def max_docs() -> int:
    return _int("MAX_DOCS", 10, 1)
