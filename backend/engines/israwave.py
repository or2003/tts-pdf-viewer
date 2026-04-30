from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Tuple

import numpy as np

log = logging.getLogger(__name__)

MODELS_DIR = Path(os.environ.get("ISRAWAVE_MODELS_DIR", Path(__file__).resolve().parent.parent / "models" / "israwave"))
SPEECH_MODEL = MODELS_DIR / "israwave.onnx"
NIQQUD_MODEL = MODELS_DIR / "nakdimon.onnx"
ESPEAK_DATA = MODELS_DIR / "espeak-ng-data"


class IsraWaveEngine:
    def __init__(self) -> None:
        self._speech = None
        self._niqqud = None
        self._segmenter = None
        self._sample_rate: int | None = None
        self._lock = threading.Lock()

    def _ensure_loaded(self) -> None:
        if self._speech is not None:
            return
        with self._lock:
            if self._speech is not None:
                return
            for p in (SPEECH_MODEL, NIQQUD_MODEL, ESPEAK_DATA):
                if not p.exists():
                    raise RuntimeError(
                        f"Israwave asset missing: {p}. Run `bash backend/setup_models.sh` to download."
                    )

            log.info("loading Israwave from %s", MODELS_DIR)
            from israwave import IsraWave
            from israwave.segment import SegmentExtractor
            from nakdimon_ort import Nakdimon

            self._speech = IsraWave(str(SPEECH_MODEL), str(ESPEAK_DATA))
            self._niqqud = Nakdimon(str(NIQQUD_MODEL))
            self._segmenter = SegmentExtractor()
            self._sample_rate = int(self._speech.sample_rate)
            log.info("Israwave loaded (sr=%d)", self._sample_rate)

    def status(self) -> dict:
        return {
            "name": "israwave (onnx)",
            "models_dir": str(MODELS_DIR),
            "loaded": self._speech is not None,
            "sample_rate": self._sample_rate,
        }

    def synthesize(self, text: str) -> Tuple[np.ndarray, int]:
        self._ensure_loaded()
        assert self._speech is not None and self._niqqud is not None and self._segmenter is not None
        assert self._sample_rate is not None

        vocalized = self._niqqud.compute(text)

        chunks: list[np.ndarray] = []
        for segment in self._segmenter.extract_segments(vocalized):
            waveform = self._speech.create(segment.text)
            chunks.append(np.asarray(waveform.samples, dtype=np.float32).reshape(-1))
            silence = segment.create_pause(waveform.sample_rate)
            chunks.append(np.asarray(silence, dtype=np.float32).reshape(-1))

        if not chunks:
            return np.zeros(0, dtype=np.float32), self._sample_rate
        return np.concatenate(chunks), self._sample_rate
