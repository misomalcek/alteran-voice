"""Alteran voice agent server.

Run:  uv run uvicorn server:app --host 127.0.0.1 --port 8787
Then open http://127.0.0.1:8787 — mic in, Alteran out.
"""
from __future__ import annotations

import base64
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import agent
from corpus import Corpus

HERE = __import__("pathlib").Path(__file__).resolve().parent

corpus: Corpus | None = None
sessions: dict[str, dict] = {}
MAX_HISTORY = 16  # messages kept per session


@asynccontextmanager
async def lifespan(app: FastAPI):
    global corpus
    corpus = Corpus()
    print(f"corpus indexed: {corpus.stats()}")
    yield


app = FastAPI(title="Alteran Voice", lifespan=lifespan)


def _session(sid: str | None) -> tuple[str, dict]:
    sid = sid or uuid.uuid4().hex[:12]
    s = sessions.setdefault(sid, {"history": [], "created": time.time()})
    return sid, s


def _trim(s: dict) -> None:
    s["history"] = s["history"][-MAX_HISTORY:]


@app.get("/api/health")
async def health():
    return {"ok": True, "corpus": corpus.stats(), "models": agent.config(), "sessions": len(sessions)}


@app.post("/api/reset")
async def reset(request: Request):
    body = await request.json()
    sid = body.get("session_id")
    if sid in sessions:
        sessions[sid]["history"] = []
    return {"ok": True}


async def _turn(sid: str | None, question: str, voice: str | None, lang: str = "en") -> JSONResponse:
    t0 = time.perf_counter()
    sid, s = _session(sid)
    passages = corpus.search(question, k=5)
    t_ret = time.perf_counter()
    context = agent.build_context(passages)
    reply, provider = await agent.complete(s["history"], question, context, lang)
    t_llm = time.perf_counter()
    audio, mime, tts_provider = await agent.speak(reply, voice, lang)
    t_tts = time.perf_counter()
    s["history"] += [{"role": "user", "content": question}, {"role": "assistant", "content": reply}]
    _trim(s)
    seen, sources = set(), []
    for c in passages:
        if c.url not in seen:
            seen.add(c.url)
            sources.append({"title": c.title, "url": c.url, "kind": c.kind, "score": round(c.score, 1)})
    return JSONResponse({
        "session_id": sid,
        "transcript": question,
        "reply": reply,
        "sources": sources,
        "audio": base64.b64encode(audio).decode() if audio else None,
        "audio_mime": mime,
        "llm_provider": provider,
        "tts_provider": tts_provider,
        "timings_ms": {
            "retrieval": round((t_ret - t0) * 1000),
            "llm": round((t_llm - t_ret) * 1000),
            "tts": round((t_tts - t_llm) * 1000),
            "total": round((t_tts - t0) * 1000),
        },
    })


@app.post("/api/turn")
async def turn(
    request: Request,
    audio: UploadFile | None = File(None),
    session_id: str | None = Form(None),
    text: str | None = Form(None),
    voice: str | None = Form(None),
    lang: str | None = Form(None),
):
    """One conversation turn. Multipart with `audio` (voice) or `text` (typed)."""
    lang = lang or "en"
    try:
        if audio is not None:
            t0 = time.perf_counter()
            data = await audio.read()
            if len(data) < 1000:
                return JSONResponse({"error": "recording too short"}, status_code=400)
            # Pass language hint to Whisper for better accuracy
            stt_lang = "sk" if lang == "sk" else "en"
            transcript = await agent.transcribe(data, audio.filename or "audio.webm", stt_lang)
            stt_ms = round((time.perf_counter() - t0) * 1000)
            if not transcript:
                return JSONResponse({"error": "no speech detected", "stt_ms": stt_ms}, status_code=422)
            resp = await _turn(session_id, transcript, voice, lang)
            import json
            body = json.loads(resp.body)
            body["stt_ms"] = stt_ms
            body["timings_ms"]["stt"] = stt_ms
            body["timings_ms"]["total"] += stt_ms
            return JSONResponse(body)
        if text:
            return await _turn(session_id, text.strip(), voice, lang)
        return JSONResponse({"error": "provide audio or text"}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": str(e)[:500]}, status_code=502)


app.mount("/", StaticFiles(directory=HERE / "web", html=True), name="web")