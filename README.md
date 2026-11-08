# Groq Chat: a ChatGPT-style assistant (normal chat + document Q&A)

One app that works like ChatGPT, powered by the **free Groq API**:

- **Normal chat (LLM):** ask anything, in any language (Roman Urdu works too). Follow-up questions remember the conversation.
- **Document chat (RAG):** attach PDF or TXT files with the paperclip. Answers use your documents and show **numbered sources** `[1]`. If the documents do not contain the answer, the assistant says so and answers from general knowledge.
- **ChatGPT-like experience:** streaming answers, Markdown (lists, tables, code blocks with Copy), multiple chats in a sidebar (rename/delete), Stop and Regenerate buttons, model picker, light/dark theme, mobile friendly.
- **Memory file:** chats are auto-saved in your browser, and you can **save a chat to a file** (JSON or text) and **load it back** later.

Only one secret is needed: `GROQ_API_KEY`. No database, no other services.

## How it works

```
Browser                                   Server (Flask, stateless)          Groq
  chats + documents in IndexedDB
  upload PDF/TXT  ------------------->    /api/extract  (read + split text)
  search your documents (BM25 keyword search, in the browser)
  question + top passages ---------->     /api/chat  (streams the answer) ->  free Groq model
```

- Groq has no embedding model, so documents are searched with **BM25 keyword search** in the browser. It is fast and free, but it matches words, not meaning: ask using words that appear in the document.
- Without documents (or with the "Using documents" switch off) it is a plain chatbot.
- Follow-up questions such as "and its price?" are rewritten into a standalone search query first.

## Project structure

```
app.py              Flask API (/api/health, /api/extract, /api/rewrite, /api/chat)
rag/                config, document reading/splitting, Groq client + prompts
public/             index.html, style.css, app.js, markdown.js, retrieval.js
tests/              Python + JavaScript tests
run.py              local launcher
vercel.json         Vercel settings
requirements.txt    Flask, requests, python-dotenv, pypdf
.env.example        configuration template (copy to .env)
```

## 1. Get a free Groq API key

1. Go to https://console.groq.com and sign up (free, no card).
2. Open **API Keys → Create API Key** and copy it (starts with `gsk_`).

## 2. Run locally

```bash
python -m venv .venv
# macOS / Linux:        source .venv/bin/activate
# Windows (cmd):        .venv\Scripts\activate
# Windows (PowerShell): .venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env        # Windows: copy .env.example .env
# open .env and put your real key after GROQ_API_KEY=
python run.py
```

Open http://localhost:5000.

Run the tests: `python -m unittest discover -s tests` and `node --test tests/markdown.test.js` and `node --test tests/retrieval.test.js`.

## 3. Configuration (Groq key and model)

| Variable | Required | Meaning |
|---|---|---|
| `GROQ_API_KEY` | yes | your Groq key |
| `GROQ_MODEL` | no | default model, `openai/gpt-oss-20b` |
| `GROQ_MODELS` | no | comma-separated list for the model picker (default `openai/gpt-oss-20b,openai/gpt-oss-120b`) |
| `SYSTEM_PROMPT` | no | replaces the assistant's default instructions |
| `MAX_ANSWER_TOKENS`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `MAX_UPLOAD_MB`, `MAX_DOCS` | no | tuning |

Model names change over time. If you see "model may have been retired", pick a current free chat model from https://console.groq.com/docs/models and set `GROQ_MODEL`.

## 4. Upload to GitHub

1. Create an empty repository on https://github.com/new (do not add a README).
2. Make sure `.env` is **not** in the folder you upload (only `.env.example`). `.gitignore` already blocks it.
3. In the project folder:
   ```bash
   git init
   git add -A
   git commit -m "Groq Chat"
   git branch -M main
   git remote add origin https://github.com/YOUR_NAME/YOUR_REPO.git
   git push -u origin main
   ```
   Or on the GitHub website use **Add file → Upload files** and drag in the contents of this folder.
4. **Updating an old repo** (from the earlier DocChat/RAG versions): delete the old files first (especially any `api/` folder and old `public/` files), then add these. Old `GEMINI_*` / `UPSTASH_*` variables are no longer needed.

## 5. Deploy to Vercel

1. Go to https://vercel.com → **Add New… → Project** → import your GitHub repo.
2. Framework Preset: **Other** (leave build settings empty).
3. Open **Environment Variables** and add:
   - `GROQ_API_KEY` = your key
   - `GROQ_MODEL` = `openai/gpt-oss-20b` (optional)
   
   Tick Production (and Preview/Development if you like).
4. Click **Deploy**.
5. Changed a variable later? **Deployments → ⋯ → Redeploy**. Variables only apply to new deployments.

## Using it

- **New chat** (top left) starts a fresh conversation; your chats stay listed on the left.
- **Paperclip / Documents panel:** add PDF or TXT files. The **Using documents** switch under the message box turns document answers on/off.
- **Stop** cancels a reply; **Regenerate** asks again; **Copy** copies a reply or a code block.
- **Save or load a chat:** *Save chat file* downloads JSON you can load again; *Export as text* is a readable copy.

## Limits and notes

- Free Groq limits apply (about 30 requests/minute and a few thousand tokens/minute). Long chats are trimmed before sending.
- Upload limit 3 MB per file (Vercel allows 4.5 MB per request), 10 documents, 150 PDF pages. Scanned/image-only or password-protected PDFs cannot be read.
- Chats and documents are stored only in your browser. Clearing site data deletes them, so use *Save chat file* for backups. Private/incognito windows may not keep them.
- On Vercel, streaming may arrive in larger pieces than locally; answers still work.

## Troubleshooting

| Message | Fix |
|---|---|
| Server is missing `GROQ_API_KEY` | Add it in `.env` (local) or Vercel → Settings → Environment Variables, then **Redeploy**. Name must be exactly `GROQ_API_KEY`, with no spaces or quotes. |
| API key was rejected | The key is wrong or revoked. Create a new one at console.groq.com. |
| Rate limit reached | Wait a minute; the free tier is limited. |
| Model may have been retired | Set `GROQ_MODEL` to a current model. |
| Request failed (405/404) | An old `api/` folder or old files are still in the repo. Delete them and redeploy. |
| "Couldn't find your answer in documents" | BM25 matches words; use words from the document or turn documents off for general questions. |

## Security

The key is read only on the server from environment variables and never sent to the browser. `.env` is git-ignored. Model output is escaped before display, links are limited to http/https/mailto, and uploads are validated (type, size, page count).
