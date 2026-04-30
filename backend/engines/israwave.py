from __future__ import annotations

import logging
import os
import re
import threading
import unicodedata
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

    @staticmethod
    def _normalize(text: str) -> str:
        s = unicodedata.normalize("NFC", text)
        s = "".join(ch for ch in s if unicodedata.category(ch) != "Cf")
        s = re.sub(r"\s+", " ", s).strip()
        return s

    def synthesize(self, text: str) -> Tuple[np.ndarray, int]:
        self._ensure_loaded()
        assert self._speech is not None and self._niqqud is not None and self._segmenter is not None
        assert self._sample_rate is not None

        cleaned = self._normalize(text)
        vocalized = self._niqqud.compute(cleaned)
        log.info("[TTS-DIAG] in=%r cleaned=%r vocalized=%r", text[:120], cleaned[:120], vocalized[:120])

        chunks: list[np.ndarray] = []
        seg_count = 0
        for segment in self._segmenter.extract_segments(vocalized):
            seg_count += 1
            waveform = self._speech.create(segment.text)
            log.info("[TTS-DIAG] seg=%r samples=%d", segment.text[:80], len(waveform.samples))
            chunks.append(np.asarray(waveform.samples, dtype=np.float32).reshape(-1))
            silence = segment.create_pause(waveform.sample_rate)
            chunks.append(np.asarray(silence, dtype=np.float32).reshape(-1))

        total = sum(c.size for c in chunks)
        log.info("[TTS-DIAG] total_samples=%d segments=%d", total, seg_count)

        if not chunks or total == 0:
            raise ValueError(f"no Hebrew segments produced (input_len={len(text)}, cleaned_len={len(cleaned)})")
        return np.concatenate(chunks), self._sample_rate
