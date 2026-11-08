"""Offline tests. Groq, Gemini and Upstash are all mocked, so no keys or internet are needed.

Run from the project root:   python -m unittest discover -s tests -v
"""

import io
import json
import os
import re
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests  # noqa: E402
from pypdf import PdfWriter  # noqa: E402
from reportlab.pdfgen import canvas  # noqa: E402

import app as app_module  # noqa: E402
from rag import config, documents, llm  # noqa: E402
from rag.documents import DocumentError  # noqa: E402
from rag.llm import LLMError  # noqa: E402

CONFIG_VARS = [
    "GROQ_API_KEY", "GROQ_MODEL", "VERCEL", "CHUNK_SIZE", "CHUNK_OVERLAP", "MAX_UPLOAD_MB", "MAX_PDF_PAGES",
    "MAX_TEXT_CHARS", "MAX_CHUNKS_PER_DOC", "MAX_DOCS", "MAX_ANSWER_TOKENS", "GROQ_MODELS", "SYSTEM_PROMPT",
]


def env_patch(**values):
    """Patch os.environ with a clean set of config variables plus `values`."""
    env = {k: v for k, v in os.environ.items() if k not in CONFIG_VARS}
    env.update(values)
    return patch.dict(os.environ, env, clear=True)


def make_pdf(pages: list[str]) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for text in pages:
        y = 800
        for line in text.split("\n"):
            c.drawString(60, y, line)
            y -= 16
        c.showPage()
    c.save()
    return buf.getvalue()


def fake_response(status=200, json_data=None, headers=None, text=""):
    resp = MagicMock()
    resp.status_code = status
    resp.headers = headers or {}
    resp.text = text
    resp.json.return_value = json_data if json_data is not None else {}
    return resp


def groq_ok(content):
    return fake_response(200, {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]})


# =================================================================== documents
class DocumentTests(unittest.TestCase):
    def setUp(self):
        self.env = env_patch()
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_split_text_respects_size_and_keeps_all_words(self):
        text = " ".join(f"word{i}" for i in range(600))
        chunks = documents.split_text(text, 200, 40)
        self.assertGreater(len(chunks), 5)
        self.assertTrue(all(len(c) <= 200 for c in chunks))
        joined = " ".join(chunks)
        for i in range(600):
            self.assertIn(f"word{i}", joined)

    def test_split_text_overlaps_neighbouring_chunks(self):
        text = " ".join(f"w{i}" for i in range(300))
        chunks = documents.split_text(text, 200, 50)
        shared = set(chunks[0].split()) & set(chunks[1].split())
        self.assertTrue(shared)

    def test_split_text_prefers_paragraph_boundaries(self):
        text = ("A" * 90 + " end.\n\n") + ("B" * 90 + " end.")
        chunks = documents.split_text(text, 120, 0)
        self.assertEqual(len(chunks), 2)
        self.assertTrue(chunks[0].startswith("AAA") and chunks[1].startswith("BBB"))

    def test_split_text_terminates_on_text_without_spaces(self):
        chunks = documents.split_text("x" * 5000, 300, 60)
        self.assertGreater(len(chunks), 10)
        self.assertEqual(documents.split_text("   ", 300, 60), [])
        self.assertEqual(documents.split_text("short", 300, 60), ["short"])

    def test_chunk_pages_tags_pages_and_numbers_chunks(self):
        pages = [(1, "alpha " * 100), (2, "beta " * 100)]
        with env_patch(CHUNK_SIZE="200", CHUNK_OVERLAP="20"):
            chunks = documents.chunk_pages(pages)
        self.assertEqual([c["chunk"] for c in chunks], list(range(len(chunks))))
        self.assertEqual({c["page"] for c in chunks}, {1, 2})
        self.assertTrue(all("beta" not in c["text"] for c in chunks if c["page"] == 1))

    def test_validate_rejects_bad_files(self):
        cases = [
            (("", b"x"), 400),
            (("notes.docx", b"hello"), 415),
            (("a.txt", b""), 400),
            (("a.pdf", b"not a pdf at all"), 415),
        ]
        for args, status in cases:
            with self.assertRaises(DocumentError) as ctx:
                documents.validate_upload(*args)
            self.assertEqual(ctx.exception.status, status, args)

    def test_validate_rejects_oversize(self):
        with env_patch(MAX_UPLOAD_MB="1"):
            with self.assertRaises(DocumentError) as ctx:
                documents.validate_upload("big.txt", b"a" * (1024 * 1024 + 1))
        self.assertEqual(ctx.exception.status, 413)

    def test_filename_is_sanitised(self):
        self.assertEqual(documents.clean_filename("../../etc/pass\x00wd.txt"), "passwd.txt")
        self.assertEqual(documents.clean_filename("C:\\docs\\report.pdf"), "report.pdf")

    def test_decode_text_variants(self):
        self.assertEqual(documents.decode_text("héllo".encode("utf-8")), "héllo")
        self.assertEqual(documents.decode_text(b"\xef\xbb\xbfhi"), "hi")
        self.assertEqual(documents.decode_text("hi".encode("utf-16")), "hi")
        self.assertIn("caf", documents.decode_text("café".encode("cp1252")))
        with self.assertRaises(DocumentError):
            documents.decode_text(b"\x00\x01\x02binary")

    def test_extract_text_too_short(self):
        with self.assertRaises(DocumentError):
            documents.extract("a.txt", b"hi")

    def test_extract_pdf_returns_page_numbers(self):
        data = make_pdf(["First page about apples and pears.", "Second page about shipping rules."])
        name, pages = documents.extract("fruit.pdf", data)
        self.assertEqual(name, "fruit.pdf")
        self.assertEqual([p for p, _ in pages], [1, 2])
        self.assertIn("apples", pages[0][1])
        self.assertIn("shipping", pages[1][1])

    def test_pdf_without_text_is_rejected(self):
        writer = PdfWriter()
        writer.add_blank_page(width=200, height=200)
        buf = io.BytesIO()
        writer.write(buf)
        with self.assertRaises(DocumentError) as ctx:
            documents.extract("blank.pdf", buf.getvalue())
        self.assertIn("No readable text", ctx.exception.message)

    def test_encrypted_pdf_is_rejected(self):
        writer = PdfWriter()
        writer.add_blank_page(width=200, height=200)
        writer.encrypt("secret")
        buf = io.BytesIO()
        writer.write(buf)
        with self.assertRaises(DocumentError) as ctx:
            documents.extract("locked.pdf", buf.getvalue())
        self.assertIn("password", ctx.exception.message)

    def test_corrupt_pdf_is_rejected(self):
        with self.assertRaises(DocumentError) as ctx:
            documents.extract("bad.pdf", b"%PDF-1.4 this is garbage")
        self.assertIn("Could not read", ctx.exception.message)

    def test_text_length_caps(self):
        with env_patch(MAX_TEXT_CHARS="1000"):
            with self.assertRaises(DocumentError) as ctx:
                documents.extract("long.txt", ("word " * 400).encode())
        self.assertEqual(ctx.exception.status, 413)
        with env_patch(MAX_TEXT_CHARS="1000"):
            with self.assertRaises(DocumentError):
                documents.extract("long.pdf", make_pdf(["lots of text here " * 100]))

    def test_pdf_page_limit(self):
        data = make_pdf([f"Page number {i} has some real text." for i in range(3)])
        with env_patch(MAX_PDF_PAGES="2"):
            with self.assertRaises(DocumentError) as ctx:
                documents.extract("long.pdf", data)
        self.assertEqual(ctx.exception.status, 413)


# ======================================================================== llm
class LLMTests(unittest.TestCase):
    def setUp(self):
        self.env = env_patch(GROQ_API_KEY="groq-key", GROQ_MODEL="openai/gpt-oss-20b")
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_citation_helpers(self):
        self.assertEqual(llm.cited_numbers("Yes [1][3] and also [2, 4]."), {1, 2, 3, 4})
        self.assertEqual(llm.strip_citations("Fact [1] and more [2, 3]."), "Fact and more .")

    def test_gpt_oss_params_and_auth_header(self):
        with patch("rag.llm.requests.post", return_value=groq_ok("hi")) as post:
            self.assertEqual(llm.chat_completion([{"role": "user", "content": "x"}], 100), "hi")
        body = post.call_args.kwargs["json"]
        self.assertEqual(body["model"], "openai/gpt-oss-20b")
        self.assertEqual(body["reasoning_effort"], "low")
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer groq-key")

    def test_retries_without_reasoning_params_on_400(self):
        with patch("rag.llm.requests.post", side_effect=[fake_response(400), groq_ok("ok")]) as post:
            self.assertEqual(llm.chat_completion([{"role": "user", "content": "x"}], 100), "ok")
        self.assertNotIn("reasoning_effort", post.call_args.kwargs["json"])

    def test_error_mapping(self):
        cases = [(401, "API key was rejected"), (403, "denied"), (404, "retired"), (429, "rate limit"), (503, "unavailable")]
        for status, expected in cases:
            with patch("rag.llm.requests.post", return_value=fake_response(status, headers={"retry-after": "9"})):
                with self.assertRaises(LLMError) as ctx:
                    llm.chat_completion([{"role": "user", "content": "x"}], 100)
            self.assertIn(expected, ctx.exception.message, status)

    def test_empty_reply_and_length_cutoff(self):
        cut = fake_response(200, {"choices": [{"message": {"content": ""}, "finish_reason": "length"}]})
        with patch("rag.llm.requests.post", return_value=cut):
            with self.assertRaises(LLMError) as ctx:
                llm.chat_completion([{"role": "user", "content": "x"}], 100)
        self.assertIn("ran out of tokens", ctx.exception.message)

    def test_missing_key(self):
        with env_patch():
            with self.assertRaises(LLMError):
                llm.chat_completion([{"role": "user", "content": "x"}], 100)

    def test_condense_skips_first_question_and_falls_back_on_error(self):
        with patch("rag.llm.requests.post") as post:
            self.assertEqual(llm.condense_question([{"role": "user", "content": "hi?"}], "hi?"), "hi?")
            post.assert_not_called()
        history = [{"role": "user", "content": "Refund?"}, {"role": "assistant", "content": "30 days [1]"}, {"role": "user", "content": "and for sale items?"}]
        with patch("rag.llm.requests.post", return_value=fake_response(500)):
            self.assertEqual(llm.condense_question(history, "and for sale items?"), "and for sale items?")
        with patch("rag.llm.requests.post", return_value=groq_ok('"What is the refund policy for sale items?"')) as post:
            self.assertEqual(llm.condense_question(history, "and for sale items?"), "What is the refund policy for sale items?")
        self.assertNotIn("[1]", post.call_args.kwargs["json"]["messages"][1]["content"])  # old citations removed

    def test_build_messages_plain_chat_has_no_document_rules(self):
        history = [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello [1]"}, {"role": "user", "content": "Explain DNS"}]
        messages = llm.build_messages(history, None)
        self.assertEqual([m["role"] for m in messages], ["system", "user", "assistant", "user"])
        self.assertNotIn("uploaded documents", messages[0]["content"])
        self.assertEqual(messages[-1]["content"], "Explain DNS")
        self.assertEqual(messages[2]["content"], "Hello [1]")  # plain chat keeps text untouched

    def test_build_messages_with_passages_numbers_excerpts_and_strips_old_citations(self):
        passages = [
            {"text": "Refunds within 30 days.", "metadata": {"filename": "policy.pdf", "page": 2}},
            {"text": "Shipping is free.", "metadata": {"filename": "faq.txt", "page": 0}},
        ]
        history = [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello [1]"}, {"role": "user", "content": "Refund?"}]
        messages = llm.build_messages(history, passages)
        self.assertIn("uploaded documents", messages[0]["content"])
        self.assertEqual(messages[2]["content"], "Hello")
        last = messages[-1]["content"]
        self.assertIn("[1] (policy.pdf, page 2)", last)
        self.assertIn("[2] (faq.txt)", last)
        self.assertTrue(last.endswith("User question: Refund?"))

    def test_system_prompt_override(self):
        with env_patch(SYSTEM_PROMPT="You are a pirate."):
            self.assertTrue(llm.system_prompt(False).startswith("You are a pirate."))

    def test_stream_deltas_parses_sse_lines(self):
        lines = [
            "", "data: " + '{"choices":[{"delta":{"role":"assistant"}}]}',
            "data: " + '{"choices":[{"delta":{"content":"Hel"}}]}',
            "data: not-json",
            "data: " + '{"choices":[{"delta":{"content":"lo"}}]}',
            "data: [DONE]", "data: " + '{"choices":[{"delta":{"content":"ignored"}}]}',
        ]
        resp = MagicMock()
        resp.iter_lines.return_value = iter(lines)
        self.assertEqual("".join(llm.stream_deltas(resp)), "Hello")
        resp.close.assert_called_once()

    def test_stream_deltas_connection_error(self):
        resp = MagicMock()
        resp.iter_lines.side_effect = requests.ConnectionError()
        with self.assertRaises(LLMError):
            list(llm.stream_deltas(resp))

    def test_open_stream_errors_before_streaming(self):
        with patch("rag.llm.requests.post", return_value=fake_response(429, headers={"retry-after": "5"})):
            with self.assertRaises(LLMError) as ctx:
                llm.open_stream([{"role": "user", "content": "x"}], 100)
        self.assertEqual(ctx.exception.status, 429)


# ================================================================== full API
POLICY_TEXT = (
    "Refund policy: customers may request a refund within thirty days of purchase. "
    "Refunds are issued to the original payment method within five business days.\n\n"
    "Shipping policy: standard shipping takes five to seven business days. "
    "Express shipping is available for an additional fee and arrives in two days.\n\n"
    "Warranty: every product includes a one year limited warranty covering manufacturing defects."
)


def passage(text, filename="policy.txt", page=0, chunk=0, score=1.0, doc_id="d1"):
    return {"text": text, "filename": filename, "page": page, "chunk": chunk, "score": score, "doc_id": doc_id}


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.env = env_patch(GROQ_API_KEY="g", CHUNK_SIZE="220", CHUNK_OVERLAP="20")
        self.env.start()
        app_module.app.testing = True
        self.client = app_module.app.test_client()

    def tearDown(self):
        self.env.stop()

    def extract(self, name="policy.txt", data=POLICY_TEXT.encode()):
        return self.client.post("/api/extract", data={"file": (io.BytesIO(data), name)}, content_type="multipart/form-data")

    def chat(self, messages, passages=None):
        body = {"messages": messages}
        if passages is not None:
            body["passages"] = passages
        return self.client.post("/api/chat", json=body)

    # ---- health
    def test_health_reports_config_without_secrets(self):
        res = self.client.get("/api/health")
        data = res.get_json()
        self.assertTrue(data["groq_key_configured"])
        self.assertEqual(data["chat_model"], "openai/gpt-oss-20b")
        self.assertEqual(data["models"], ["openai/gpt-oss-20b", "openai/gpt-oss-120b"])
        self.assertEqual(data["limits"]["max_upload_mb"], 3)
        self.assertNotIn('"g"', res.get_data(as_text=True))

    def test_health_without_key(self):
        with env_patch():
            self.assertFalse(self.client.get("/api/health").get_json()["groq_key_configured"])

    # ---- extract
    def test_extract_txt_returns_chunks(self):
        res = self.extract()
        self.assertEqual(res.status_code, 200, res.get_json())
        doc = res.get_json()["document"]
        self.assertEqual(doc["name"], "policy.txt")
        self.assertGreaterEqual(len(doc["chunks"]), 3)
        self.assertEqual([c["chunk"] for c in doc["chunks"]], list(range(len(doc["chunks"]))))
        self.assertTrue(all(len(c["text"]) <= 220 and c["page"] == 0 for c in doc["chunks"]))
        self.assertIn("Refund policy", doc["chunks"][0]["text"])

    def test_extract_pdf_keeps_page_numbers(self):
        pdf = make_pdf(["Warranty terms for all gadgets.", "Refund policy: refunds are accepted within thirty days."])
        doc = self.extract("terms.pdf", pdf).get_json()["document"]
        self.assertEqual(doc["pages"], 2)
        self.assertEqual({c["page"] for c in doc["chunks"]}, {1, 2})

    def test_extract_validation_errors_are_json(self):
        cases = [
            (self.extract("notes.docx", b"hello world"), 415),
            (self.extract("empty.txt", b""), 400),
            (self.extract("fake.pdf", b"this is not a pdf"), 415),
            (self.extract("bin.txt", b"\x00\x01\x02" * 50), 415),
            (self.client.post("/api/extract", data={}, content_type="multipart/form-data"), 400),
        ]
        for res, status in cases:
            self.assertEqual(res.status_code, status, res.get_json())
            self.assertIn("error", res.get_json())

    def test_oversize_upload_returns_json_413(self):
        res = self.extract("big.txt", b"a " * (3 * 1024 * 1024))  # ~6 MB: above the hard request cap
        self.assertEqual(res.status_code, 413)
        self.assertIn("too large", res.get_json()["error"])
        res = self.extract("mid.txt", b"word " * 650000)  # ~3.2 MB: passes the request cap, fails validation
        self.assertEqual(res.status_code, 413)

    def test_too_many_chunks_rejected(self):
        with env_patch(GROQ_API_KEY="g", CHUNK_SIZE="200", MAX_CHUNKS_PER_DOC="2"):
            res = self.extract()
        self.assertEqual(res.status_code, 413)
        self.assertIn("too long", res.get_json()["error"])

    def test_extract_needs_no_api_key(self):
        with env_patch():
            self.assertEqual(self.extract().status_code, 200)

    # ---- chat (plain LLM mode)
    def test_plain_chat_works_without_documents(self):
        history = [{"role": "user", "content": "Who wrote Hamlet?"}]
        with patch("rag.llm.requests.post", return_value=groq_ok("William Shakespeare wrote Hamlet.")) as post:
            res = self.chat(history)
        data = res.get_json()
        self.assertEqual(res.status_code, 200, data)
        self.assertEqual(data["reply"], "William Shakespeare wrote Hamlet.")
        self.assertEqual(data["sources"], [])
        messages = post.call_args.kwargs["json"]["messages"]
        self.assertNotIn("uploaded documents", messages[0]["content"])
        self.assertEqual(messages[-1], {"role": "user", "content": "Who wrote Hamlet?"})
        self.assertNotIn("stream", post.call_args.kwargs["json"])

    def test_plain_chat_remembers_history(self):
        history = [
            {"role": "user", "content": "My name is Mehak."},
            {"role": "assistant", "content": "Nice to meet you, Mehak!"},
            {"role": "user", "content": "What is my name?"},
        ]
        with patch("rag.llm.requests.post", return_value=groq_ok("Your name is Mehak.")) as post:
            self.chat(history)
        messages = post.call_args.kwargs["json"]["messages"]
        self.assertEqual([m["role"] for m in messages], ["system", "user", "assistant", "user"])
        self.assertEqual(messages[1]["content"], "My name is Mehak.")

    def test_history_is_trimmed_to_the_token_budget(self):
        history = []
        for i in range(8):
            history += [{"role": "user", "content": f"q{i} " + "x" * 3000}, {"role": "assistant", "content": "a" * 3000}]
        history.append({"role": "user", "content": "latest question"})
        with patch("rag.llm.requests.post", return_value=groq_ok("ok")) as post:
            self.chat(history)
        messages = post.call_args.kwargs["json"]["messages"]
        self.assertEqual(messages[-1]["content"], "latest question")
        self.assertLess(sum(len(m["content"]) for m in messages[1:]), app_module.MAX_HISTORY_CHARS + 100)

    def test_model_choice_is_validated(self):
        with env_patch(GROQ_API_KEY="g", GROQ_MODELS="openai/gpt-oss-20b,openai/gpt-oss-120b"):
            for requested, expected in (("openai/gpt-oss-120b", "openai/gpt-oss-120b"), ("evil/model", "openai/gpt-oss-20b"), (None, "openai/gpt-oss-20b"), (5, "openai/gpt-oss-20b")):
                with patch("rag.llm.requests.post", return_value=groq_ok("ok")) as post:
                    res = self.client.post("/api/chat", json={"messages": [{"role": "user", "content": "hi"}], "model": requested})
                self.assertEqual(post.call_args.kwargs["json"]["model"], expected)
                self.assertEqual(res.get_json()["model"], expected)

    # ---- chat (RAG mode)
    def test_rag_chat_answers_with_sources_and_citations(self):
        passages = [
            passage("Refund policy: customers may request a refund within thirty days.", chunk=0),
            passage("Shipping takes five days.", chunk=1, score=0.4),
        ]
        with patch("rag.llm.requests.post", return_value=groq_ok("You can get a refund within thirty days [1].")) as post:
            res = self.chat([{"role": "user", "content": "How long do I have to request a refund?"}], passages)
        data = res.get_json()
        self.assertEqual(res.status_code, 200, data)
        self.assertEqual(post.call_count, 1)
        self.assertEqual([s["cited"] for s in data["sources"]], [True, False])
        self.assertEqual(data["sources"][0]["filename"], "policy.txt")
        messages = post.call_args.kwargs["json"]["messages"]
        self.assertIn("uploaded documents", messages[0]["content"])
        self.assertIn("[1] (policy.txt)", messages[-1]["content"])
        self.assertIn("[2] (policy.txt)", messages[-1]["content"])

    def test_empty_or_junk_passages_fall_back_to_plain_chat(self):
        for passages in (None, [], [{"text": "   "}, "junk", 5]):
            with patch("rag.llm.requests.post", return_value=groq_ok("hi there")) as post:
                res = self.chat([{"role": "user", "content": "hello"}], passages)
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.get_json()["sources"], [])
            self.assertNotIn("uploaded documents", post.call_args.kwargs["json"]["messages"][0]["content"])

    def test_passages_are_validated_and_capped(self):
        many = [passage(f"text {i}", chunk=i) for i in range(20)]
        many[0]["text"] = "x" * 9000
        many[1]["filename"] = "../../etc/passwd"
        many[2]["page"] = "NaN"
        many[3]["score"] = 99
        with patch("rag.llm.requests.post", return_value=groq_ok("ok [1]")) as post:
            data = self.chat([{"role": "user", "content": "q"}], many).get_json()
        self.assertEqual(len(data["sources"]), app_module.MAX_PASSAGES)
        sent = post.call_args.kwargs["json"]["messages"][-1]["content"]
        self.assertLess(len(sent), 8 * 2300 + 500)
        self.assertEqual(data["sources"][1]["filename"], "passwd")
        self.assertEqual(data["sources"][2]["page"], 0)
        self.assertEqual(data["sources"][3]["score"], 1.0)

    # ---- streaming
    @staticmethod
    def stream_response(pieces, status=200):
        resp = MagicMock()
        resp.status_code = status
        resp.headers = {}
        lines = ["data: " + json.dumps({"choices": [{"delta": {"content": p}}]}) for p in pieces] + ["data: [DONE]"]
        resp.iter_lines.return_value = iter(lines)
        return resp

    @staticmethod
    def parse_sse(body: str):
        return [json.loads(chunk[6:]) for chunk in body.strip().split("\n\n") if chunk.startswith("data: ")]

    def test_streaming_sends_deltas_then_done_with_sources(self):
        upstream = self.stream_response(["Refunds ", "take thirty days ", "[1]."])
        with patch("rag.llm.requests.post", return_value=upstream) as post:
            res = self.client.post("/api/chat", json={
                "messages": [{"role": "user", "content": "refund?"}], "passages": [passage("Refund within thirty days.")], "stream": True})
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.mimetype.startswith("text/event-stream"))
        self.assertTrue(post.call_args.kwargs["json"]["stream"])
        events = self.parse_sse(res.get_data(as_text=True))
        self.assertEqual([e["type"] for e in events], ["delta", "delta", "delta", "done"])
        self.assertEqual("".join(e["text"] for e in events if e["type"] == "delta"), "Refunds take thirty days [1].")
        self.assertTrue(events[-1]["sources"][0]["cited"])
        self.assertEqual(events[-1]["model"], "openai/gpt-oss-20b")

    def test_streaming_plain_chat_has_no_sources(self):
        with patch("rag.llm.requests.post", return_value=self.stream_response(["Hi!"])):
            res = self.client.post("/api/chat", json={"messages": [{"role": "user", "content": "hello"}], "stream": True})
        events = self.parse_sse(res.get_data(as_text=True))
        self.assertEqual(events[-1], {"type": "done", "sources": [], "model": "openai/gpt-oss-20b"})

    def test_streaming_upstream_error_is_a_normal_json_error(self):
        with patch("rag.llm.requests.post", return_value=fake_response(429, headers={"retry-after": "9"})):
            res = self.client.post("/api/chat", json={"messages": [{"role": "user", "content": "hi"}], "stream": True})
        self.assertEqual(res.status_code, 429)
        self.assertIn("rate limit", res.get_json()["error"])

    def test_streaming_mid_stream_failure_sends_error_event(self):
        upstream = MagicMock()
        upstream.status_code = 200
        upstream.headers = {}
        def broken():
            yield "data: " + json.dumps({"choices": [{"delta": {"content": "Partial"}}]})
            raise requests.ConnectionError("boom")
        upstream.iter_lines.return_value = broken()
        with patch("rag.llm.requests.post", return_value=upstream):
            res = self.client.post("/api/chat", json={"messages": [{"role": "user", "content": "hi"}], "stream": True})
        events = self.parse_sse(res.get_data(as_text=True))
        self.assertEqual(events[0], {"type": "delta", "text": "Partial"})
        self.assertEqual(events[-1]["type"], "error")
        self.assertNotIn("boom", res.get_data(as_text=True))

    def test_streaming_empty_reply_is_an_error(self):
        with patch("rag.llm.requests.post", return_value=self.stream_response([])):
            res = self.client.post("/api/chat", json={"messages": [{"role": "user", "content": "hi"}], "stream": True})
        self.assertEqual(self.parse_sse(res.get_data(as_text=True))[-1]["type"], "error")

    # ---- validation and errors
    def test_chat_validation(self):
        for body in ({}, {"messages": "x"}, {"messages": []}, {"messages": [{"role": "assistant", "content": "x"}]}):
            res = self.client.post("/api/chat", json=body)
            self.assertEqual(res.status_code, 400, body)
        res = self.client.post("/api/chat", json={"messages": [{"role": "user", "content": "q"}], "passages": "nope"})
        self.assertEqual(res.status_code, 400)

    def test_missing_key_gives_clear_error(self):
        with env_patch():
            for path in ("/api/chat", "/api/rewrite"):
                res = self.client.post(path, json={"messages": [{"role": "user", "content": "hi"}]})
                self.assertEqual(res.status_code, 500)
                self.assertIn("GROQ_API_KEY", res.get_json()["error"])

    def test_groq_errors_are_mapped_and_never_leak_details(self):
        with patch("rag.llm.requests.post", return_value=fake_response(401, {"error": {"message": "secret detail"}})):
            res = self.chat([{"role": "user", "content": "q"}])
        self.assertEqual(res.status_code, 502)
        self.assertNotIn("secret detail", res.get_data(as_text=True))
        with patch("rag.llm.requests.post", return_value=fake_response(429, headers={"retry-after": "7"})):
            res = self.chat([{"role": "user", "content": "q"}], [passage("text")])
        self.assertEqual(res.status_code, 429)
        self.assertIn("7", res.get_json()["error"])

    # ---- rewrite
    def test_rewrite_first_question_is_unchanged_and_free(self):
        with patch("rag.llm.requests.post") as post:
            res = self.client.post("/api/rewrite", json={"messages": [{"role": "user", "content": "What is the refund policy?"}]})
        self.assertEqual(res.get_json(), {"query": "What is the refund policy?"})
        post.assert_not_called()

    def test_rewrite_follow_up_uses_history(self):
        history = [
            {"role": "user", "content": "Tell me about shipping."},
            {"role": "assistant", "content": "Standard takes five days [1]."},
            {"role": "user", "content": "And express?"},
        ]
        with patch("rag.llm.requests.post", return_value=groq_ok("How long does express shipping take?")) as post:
            res = self.client.post("/api/rewrite", json={"messages": history})
        self.assertEqual(res.get_json()["query"], "How long does express shipping take?")
        prompt = post.call_args.kwargs["json"]["messages"][1]["content"]
        self.assertIn("Tell me about shipping", prompt)
        self.assertNotIn("[1]", prompt)

    def test_rewrite_falls_back_to_original_on_groq_error(self):
        history = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}, {"role": "user", "content": "and?"}]
        with patch("rag.llm.requests.post", return_value=fake_response(500)):
            self.assertEqual(self.client.post("/api/rewrite", json={"messages": history}).get_json()["query"], "and?")

    # ---- misc
    def test_api_errors_are_always_json(self):
        self.assertEqual(self.client.get("/api/nope").get_json(), {"error": "Not found."})
        res = self.client.post("/api/health")  # the route exists, but only for GET
        self.assertEqual((res.status_code, res.get_json()["error"]), (405, "Method not allowed."))

    def test_unexpected_errors_are_hidden(self):
        with patch("app.llm.build_messages", side_effect=RuntimeError("database password is hunter2")):
            res = self.chat([{"role": "user", "content": "q"}], [passage("text")])
        self.assertEqual(res.status_code, 500)
        self.assertNotIn("hunter2", res.get_data(as_text=True))

    def test_frontend_files_served_locally(self):
        for path, marker in (("/", b"Groq Chat"), ("/markdown.js", b"render"), ("/app.js", b"/api/extract"), ("/retrieval.js", b"buildIndex"), ("/style.css", b"--accent")):
            res = self.client.get(path)
            self.assertEqual(res.status_code, 200, path)
            self.assertIn(marker, res.data)
            res.close()


class HistoryTests(unittest.TestCase):
    def test_clean_history_trims_and_requires_final_user_message(self):
        msgs = []
        for i in range(30):
            msgs += [{"role": "user", "content": f"q{i}"}, {"role": "assistant", "content": f"a{i}"}]
        msgs.append({"role": "user", "content": "x" * 5000})
        cleaned = app_module.clean_history(msgs)
        self.assertLessEqual(len(cleaned), app_module.MAX_HISTORY_MESSAGES)
        self.assertEqual(cleaned[0]["role"], "user")
        self.assertEqual(len(cleaned[-1]["content"]), app_module.MAX_MESSAGE_CHARS)
        self.assertLessEqual(sum(len(m["content"]) for m in cleaned), app_module.MAX_HISTORY_CHARS + app_module.MAX_MESSAGE_CHARS)


if __name__ == "__main__":
    unittest.main()
