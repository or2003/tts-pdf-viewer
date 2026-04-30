from __future__ import annotations

import asyncio
import io
import logging
import os
import re
import unicodedata
from typing import Tuple

import numpy as np

log = logging.getLogger(__name__)

DEFAULT_VOICE = os.environ.get("EDGE_TTS_HE_VOICE", "he-IL-AvriNeural")
DEFAULT_RATE = os.environ.get("EDGE_TTS_RATE", "+0%")
DEFAULT_PITCH = os.environ.get("EDGE_TTS_PITCH", "+0Hz")


class EdgeTTSEngine:
    """Hebrew TTS via Microsoft Edge TTS (cloud, no API key). Returns MP3, decoded to float32 numpy."""

    def __init__(self, voice: str = DEFAULT_VOICE) -> None:
        self._voice = voice
        self._sample_rate: int | None = None

    def status(self) -> dict:
        return {
            "name": f"edge-tts ({self._voice})",
            "voice": self._voice,
            "loaded": True,
            "sample_rate": self._sample_rate,
        }

    @staticmethod
    def _normalize(text: str) -> str:
        s = unicodedata.normalize("NFC", text)
        s = "".join(ch for ch in s if unicodedata.category(ch) != "Cf")
        s = re.sub(r"\s+", " ", s).strip()
        return s

    async def _stream_mp3(self, text: str) -> bytes:
        import edge_tts

        comm = edge_tts.Communicate(text, self._voice, rate=DEFAULT_RATE, pitch=DEFAULT_PITCH)
        buf = bytearray()
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                buf.extend(chunk["data"])
        return bytes(buf)

    def synthesize(self, text: str) -> Tuple[np.ndarray, int]:
        import soundfile as sf

        cleaned = self._normalize(text)
        if not cleaned:
            raise ValueError(f"no Hebrew content to synthesize (input_len={len(text)})")
        log.info("[TTS-DIAG] in=%r cleaned=%r", text[:120], cleaned[:120])

        mp3 = asyncio.run(self._stream_mp3(cleaned))
        if not mp3:
            raise ValueError(f"edge-tts returned no audio (input_len={len(text)})")

        samples, sr = sf.read(io.BytesIO(mp3), dtype="float32")
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        samples = samples.astype(np.float32, copy=False).reshape(-1)

        self._sample_rate = int(sr)
        log.info("[TTS-DIAG] mp3_bytes=%d samples=%d sr=%d", len(mp3), samples.size, sr)

        if samples.size == 0:
            raise ValueError(f"edge-tts decoded to zero samples (input_len={len(text)})")
        return samples, int(sr)
