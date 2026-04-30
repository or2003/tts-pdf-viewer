from __future__ import annotations

import logging
import threading
from typing import Tuple

import numpy as np

log = logging.getLogger(__name__)

KOKORO_REPO = "mlx-community/Kokoro-82M-bf16"
DEFAULT_VOICE = "af_heart"
DEFAULT_LANG_CODE = "a"
KOKORO_SAMPLE_RATE = 24_000


class KokoroEngine:
    def __init__(self, repo: str = KOKORO_REPO, voice: str = DEFAULT_VOICE, lang_code: str = DEFAULT_LANG_CODE):
        self.repo = repo
        self.voice = voice
        self.lang_code = lang_code
        self._model = None
        self._lock = threading.Lock()

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        with self._lock:
            if self._model is not None:
                return
            log.info("loading Kokoro from %s", self.repo)
            from mlx_audio.tts.utils import load_model

            self._model = load_model(self.repo)
            log.info("Kokoro loaded")

    def status(self) -> dict:
        return {
            "name": "kokoro (mlx-audio)",
            "repo": self.repo,
            "voice": self.voice,
            "loaded": self._model is not None,
            "sample_rate": KOKORO_SAMPLE_RATE,
        }

    def synthesize(self, text: str) -> Tuple[np.ndarray, int]:
        self._ensure_loaded()
        assert self._model is not None

        chunks: list[np.ndarray] = []
        for result in self._model.generate(
            text=text,
            voice=self.voice,
            speed=1.0,
            lang_code=self.lang_code,
        ):
            audio = result.audio
            arr = np.array(audio, dtype=np.float32)
            chunks.append(arr.reshape(-1))

        if not chunks:
            return np.zeros(0, dtype=np.float32), KOKORO_SAMPLE_RATE
        samples = np.concatenate(chunks)
        return samples, KOKORO_SAMPLE_RATE
