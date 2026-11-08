"""Groq chatbot backend (Flask): a ChatGPT-style assistant that can also answer from your documents.
Needs ONE secret: GROQ_API_KEY.

The server is stateless, which is what Vercel needs:

  * /api/chat     the conversation. Plain LLM chat by default; when the browser sends
                  passages found in the user's documents it answers from them with
                  citations. Streams the answer token by token (Server-Sent Events).
  * /api/extract  reads an uploaded PDF/TXT, splits it into chunks and returns them.
                  The browser keeps the chunks (IndexedDB) and does the searching (BM25).
  * /api/rewrite  turns a follow-up question into a standalone search query (Groq).

Runs locally with `python run.py` and on Vercel as one Python Function.
"""

import json
import os

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context
from werkzeug.exceptions import HTTPException, NotFound

from rag import config, documents, llm
from rag.documents import DocumentError
from rag.llm import LLMError

# Read .env for local development (on Vercel real environment variables are used).
load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")

# On Vercel, public/ is served by the CDN, so Flask's own static handling is off.
app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = config.max_upload_bytes() + 512 * 1024  # file + multipart overhead

MAX_HISTORY_MESSAGES = 12
MAX_MESSAGE_CHARS = 4000
MAX_HISTORY_CHARS = 12000  # keeps requests inside Groq's free-tier token budget
MAX_PASSAGES = 8
MAX_PASSAGE_CHARS = 2000
SNIPPET_CHARS = 420


class RequestError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# ------------------------------------------------------------------ helpers
def clean_history(raw) -> list[dict]:
    if not isinstance(raw, list):
        raise RequestError("`messages` must be a list.")
    cleaned = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        role, content = item.get("role"), item.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str) or not content.strip():
            continue
        cleaned.append({"role": role, "content": content.strip()[:MAX_MESSAGE_CHARS]})
    cleaned = cleaned[-MAX_HISTORY_MESSAGES:]
    while len(cleaned) > 1 and sum(len(m["content"]) for m in cleaned) > MAX_HISTORY_CHARS:
        cleaned.pop(0)  # drop the oldest messages first
    while cleaned and cleaned[0]["role"] != "user":
        cleaned.pop(0)
    if not cleaned or cleaned[-1]["role"] != "user":
        raise RequestError("Please type a question first.")
    return cleaned


def _num(value, default=0.0) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else default


def clean_passages(raw) -> list[dict]:
    """Validate the passages the browser found. Never trust the client's shape or size."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise RequestError("`passages` must be a list.")
    out = []
    for item in raw[:MAX_PASSAGES]:
        if not isinstance(item, dict) or not isinstance(item.get("text"), str) or not item["text"].strip():
            continue
        out.append(
            {
                "text": item["text"].strip()[:MAX_PASSAGE_CHARS],
                "score": max(0.0, min(1.0, _num(item.get("score")))),
                "metadata": {
                    "doc_id": str(item.get("doc_id") or "")[:40],
                    "filename": documents.clean_filename(str(item.get("filename") or "document")) or "document",
                    "page": max(0, int(_num(item.get("page")))),
                    "chunk": max(0, int(_num(item.get("chunk")))),
                },
            }
        )
    return out


def public_source(n: int, hit: dict, cited: bool) -> dict:
    meta, text = hit["metadata"], hit["text"]
    return {
        "n": n,
        "doc_id": meta["doc_id"],
        "filename": meta["filename"],
        "page": meta["page"],
        "chunk": meta["chunk"],
        "score": round(hit["score"], 3),
        "snippet": text[:SNIPPET_CHARS] + ("…" if len(text) > SNIPPET_CHARS else ""),
        "cited": cited,
    }


def require_key():
    if not config.groq_api_key():
        raise LLMError("The server is missing GROQ_API_KEY. Add it to .env (local) or Vercel Environment Variables.", 500)


# ------------------------------------------------------------------- routes
@app.get("/api/health")
def health():
    return jsonify(
        status="ok",
        chat_model=config.groq_model(),
        models=config.groq_models(),
        groq_key_configured=bool(config.groq_api_key()),
        limits={
            "max_upload_mb": config.max_upload_bytes() // (1024 * 1024),
            "max_docs": config.max_docs(),
            "max_pdf_pages": config.max_pages(),
            "max_chunks": config.max_chunks(),
        },
    )


@app.post("/api/extract")
def extract():
    """Validate an upload, extract its text and return the chunks (nothing is stored on the server)."""
    file = request.files.get("file")
    if file is None:
        raise RequestError("No file was uploaded.")

    name, pages = documents.extract(file.filename, file.read())
    chunks = documents.chunk_pages(pages)
    if not chunks:
        raise DocumentError("No text could be extracted from this file.")
    if len(chunks) > config.max_chunks():
        raise DocumentError(
            f"This document is too long ({len(chunks)} sections; the limit is {config.max_chunks()}). "
            "Upload a shorter file or split it into parts.",
            413,
        )
    return jsonify(
        document={
            "name": name,
            "pages": max((c["page"] for c in chunks), default=0),
            "chars": sum(len(c["text"]) for c in chunks),
            "chunks": chunks,
        }
    )


@app.post("/api/rewrite")
def rewrite():
    """Make a follow-up question self-contained so the browser can search with it."""
    require_key()
    history = clean_history((request.get_json(silent=True) or {}).get("messages"))
    return jsonify(query=llm.condense_question(history, history[-1]["content"]))


def sse(event: dict) -> str:
    return "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"


def choose_model(requested) -> str:
    allowed = config.groq_models()
    return requested if isinstance(requested, str) and requested in allowed else allowed[0]


@app.post("/api/chat")
def chat():
    require_key()
    payload = request.get_json(silent=True) or {}
    history = clean_history(payload.get("messages"))
    passages = clean_passages(payload.get("passages"))
    model = choose_model(payload.get("model"))
    max_tokens = config.max_answer_tokens()
    temperature = 0.4 if passages else 0.7
    messages = llm.build_messages(history, passages)

    def build_sources(text: str) -> list[dict]:
        used = llm.cited_numbers(text)
        return [public_source(i, p, i in used) for i, p in enumerate(passages, start=1)]

    if payload.get("stream") is not True:
        reply = llm.chat_completion(messages, max_tokens, temperature, model)
        return jsonify(reply=reply, sources=build_sources(reply), model=model)

    # Streaming: connect to Groq first so errors (bad key, rate limit...) still return a normal JSON error.
    upstream = llm.open_stream(messages, max_tokens, temperature, model)

    def generate():
        parts: list[str] = []
        try:
            for piece in llm.stream_deltas(upstream):
                parts.append(piece)
                yield sse({"type": "delta", "text": piece})
        except LLMError as exc:
            yield sse({"type": "error", "message": exc.message, "status": exc.status})
            return
        except Exception:  # noqa: BLE001 - never leak internals to the browser
            app.logger.exception("Streaming failed")
            yield sse({"type": "error", "message": "The answer was interrupted. Please try again.", "status": 500})
            return
        text = "".join(parts).strip()
        if not text:
            yield sse({"type": "error", "message": "The model returned an empty reply. Please try again.", "status": 502})
            return
        yield sse({"type": "done", "sources": build_sources(text), "model": model})

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"},
    )


# ------------------------------------------------------------ local frontend
if not config.on_vercel():
    # Local development only: serve the front end from public/.
    @app.get("/")
    def local_index():
        return send_from_directory(PUBLIC_DIR, "index.html")

    @app.get("/<path:filename>")
    def local_static(filename):
        if filename.startswith("api/"):
            raise NotFound()
        return send_from_directory(PUBLIC_DIR, filename)


# ------------------------------------------------------------ error handling
@app.errorhandler(Exception)
def handle_error(exc):
    if not request.path.startswith("/api/"):
        if isinstance(exc, HTTPException):
            return exc
        raise exc
    if isinstance(exc, (RequestError, DocumentError, LLMError)):
        return jsonify(error=exc.message), exc.status
    if isinstance(exc, HTTPException):
        messages = {
            404: "Not found.",
            405: "Method not allowed.",
            413: f"File is too large. The maximum size is {config.max_upload_bytes() // (1024 * 1024)} MB.",
        }
        return jsonify(error=messages.get(exc.code, exc.description)), exc.code
    app.logger.exception("Unexpected error")
    return jsonify(error="Unexpected server error. Please try again."), 500


@app.after_request
def security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", 5000)))
