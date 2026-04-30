from __future__ import annotations

import io
import logging
import wave
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from engines.kokoro import KokoroEngine
from engines.israwave import IsraWaveEngine

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("pdf-reader")

app = FastAPI(title="PDF Reader TTS")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

en_engine = KokoroEngine()
he_engine = IsraWaveEngine()


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    lang: Literal["en", "he"]


def to_wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim > 1:
        samples = samples.reshape(-1)
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    if peak > 1.0:
        samples = samples / peak
    pcm16 = (samples * 32767.0).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "engines": {
            "en": en_engine.status(),
            "he": he_engine.status(),
        },
    }


@app.post("/tts")
def tts(req: TTSRequest) -> Response:
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "empty text")
    try:
        if req.lang == "en":
            samples, sr = en_engine.synthesize(text)
        else:
            samples, sr = he_engine.synthesize(text)
    except ValueError as e:
        log.warning("tts produced no audio: %s", e)
        raise HTTPException(422, f"no audio produced: {e}") from e
    except Exception as e:
        log.exception("tts failed")
        raise HTTPException(500, f"tts failed: {e}") from e

    wav = to_wav_bytes(samples, sr)
    log.info("[TTS-DIAG] lang=%s text_len=%d samples=%d wav_bytes=%d", req.lang, len(text), int(samples.size), len(wav))
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8765, reload=False)
