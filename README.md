# Alteran Voice

A spoken conversation with **AlteranAI** — free-tier, local-first, auditable.
The agent answers from the site's own published corpus (articles, glossary,
taxonomy), speaks them aloud, and names its sources. No Cloudflare call in the
loop for this version; the existing AI Search bubble stays untouched.

```
mic ──► Groq whisper-large-v3-turbo (STT)
           │  transcript
           ▼
      local BM25 over src/content/articles + src/data/entities.ts   ← this machine
           │  top-5 passages
           ▼
      Groq gpt-oss-120b  ──fallback──►  OpenRouter gemma-4-31b-it:free
           │  reply (grounded, 2–4 spoken sentences, EN or SK)
           ▼
      Groq Orpheus TTS  ──fallback──►  edge-tts  ──fallback──►  browser speechSynthesis
           │
           ▼
        speaker
```

Every stage is one HTTP request you can replay with curl. Every number the UI
shows (stt/retrieve/think/speak ms) is measured on the actual turn — the site's
own rule: *measure before you claim*.

## Run

```bash
cd voice
./run.sh            # or: uv run uvicorn server:app --port 8787
# open http://127.0.0.1:8787
```

Keys live in `voice/.env` (gitignored):

```
GROQ_API_KEY=...
OPENROUTER_API_KEY=...
```

Optional env overrides: `LLM_MODEL`, `OR_FALLBACK`, `STT_MODEL`, `TTS_MODEL`,
`TTS_VOICE`, `EDGE_VOICE_EN`, `EDGE_VOICE_SK`, `PORT`.

### One-time: Orpheus terms

Groq's Orpheus TTS needs a terms acceptance in the console (org admin, one click):
<https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english>

Until then the agent automatically falls back to **edge-tts** (free, no key),
and after that to the browser's own speech. Nothing breaks; quality steps down.

## Use

- **Click the mic** (or press Space) to talk; click again to send. Click while
  Alteran speaks to interrupt.
- **Type** in the box for a silent turn (same pipeline, minus STT).
- **Voice** selector picks among Orpheus voices (tara, leo, dan, mia, …).
- **reset** starts a fresh conversation. Source chips link to the real articles.
- Works in English and Slovak — Whisper detects the language, the reply matches
  it, and the TTS fallback switches to a Slovak voice.

## What is indexed

`corpus.py` reads the repo at startup — the same files the website builds from:

| source | chunks |
| --- | --- |
| `src/content/articles/*.md` (published only) | ~400 sections |
| `src/data/entities.ts` (73 tools & concepts) | 67 definitions |
| `src/data/site.ts` (categories, clusters) | 19 |
| identity facts (from `about.astro`, `index.astro`) | 8 |

BM25 (`rank_bm25`), no embeddings, no vector DB, no network. Reindex = restart.
Drafts are excluded, exactly as in production.

## API

- `GET /api/health` — corpus stats + model config
- `POST /api/turn` — multipart: `audio` (webm/mp4 blob) **or** `text`, plus
  `session_id`, `voice`. Returns `{transcript, reply, sources[], audio(base64),
  audio_mime, llm_provider, tts_provider, timings_ms}`.
- `POST /api/reset` — `{session_id}` clears that conversation.

## Free-tier limits (the honest part)

- Groq free tier: rate-limited per model (requests/min, tokens/min, audio
  seconds/day). A voice turn ≈ 1 STT + 1 LLM + 1 TTS call. Heavy conversation
  will hit 429s; the LLM then falls back to OpenRouter `:free` (also rate-limited).
- Orpheus terms acceptance is per org, one time.
- edge-tts is an unofficial free endpoint; it can change or throttle. It is a
  fallback, not a foundation.
- Sessions are in-memory: a server restart forgets conversations (the corpus
  persists — it is the repo).

## Deployment paths (later)

1. **Any small VPS / this machine exposed**: `run.sh` behind Caddy/nginx with
   TLS (mic requires HTTPS off-localhost). One process, ~100 MB RAM.
2. **Cloudflare**: the static UI fits Pages; the pipeline needs a Worker doing
   the same three fetches (Groq STT/LLM/TTS are plain HTTPS). Retrieval would
   move to the existing AI Search index or a precomputed BM25 JSON in KV — the
   corpus is small enough (~500 chunks) to ship whole. Keys become Worker secrets.
3. **Site integration**: replace or complement the `chat-bubble-snippet` in
   `src/layouts/Base.astro` with this UI pointed at the deployed endpoint.

## Files

```
voice/
├── agent.py      # STT / LLM / TTS calls + fallback chain + persona prompt
├── corpus.py     # repo -> chunks -> BM25 index (run standalone to inspect)
├── server.py     # FastAPI: /api/turn, /api/health, /api/reset, static UI
├── web/          # index.html, app.js, style.css (no build step)
├── run.sh
└── .env          # keys, gitignored
```