# PDF Reader

A web app that reads PDFs aloud with sentence-level highlighting. Runs **fully local** on Apple Silicon (tested on MacBook Pro M3 Pro). Supports **English** and **Hebrew**.

- **English** → [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) on [mlx-audio](https://github.com/Blaizzy/mlx-audio) (Apple-native, ~100× realtime on M-series)
- **Hebrew** → [Israwave](https://github.com/thewh1teagle/israwave) (purpose-built ONNX model with [Nakdimon](https://github.com/thewh1teagle/nakdimon-onnx) diacritization)
- **PDF rendering** → PDF.js with text layer alignment for highlighting
- **Frontend** → Vite + React + TypeScript

After the one-time model download, everything runs on-device. No cloud calls during synthesis.

## Features

- Drop in any PDF, hit play, listen to it.
- The currently spoken sentence is highlighted directly on the rendered PDF.
- Click any sentence to jump playback there.
- Speed control (0.5×–3×) without pitch shift.
- Auto language detection per sentence (Hebrew Unicode block → Israwave; otherwise Kokoro).
- Sentences are prefetched ahead of playback, so transitions are seamless.

## Project layout

```
backend/
  app.py                   FastAPI server, POST /tts, GET /health
  engines/kokoro.py        English: Kokoro 82M via mlx-audio (lazy-loaded)
  engines/israwave.py      Hebrew: Israwave + Nakdimon (lazy-loaded)
  setup_models.sh          One-shot download of Israwave + Kokoro weights
  requirements.txt
frontend/
  src/pdf.ts               PDF.js loader + page renderer with text layer
  src/sentences.ts         Intl.Segmenter sentence splitting + Hebrew detection
  src/playback.ts          Playback engine: queue, prefetch, speed control
  src/tts.ts               /api client
  src/components/
    PdfViewer.tsx          PDF render, per-page text layer, sentence highlight
    Controls.tsx           File picker, transport, speed/zoom sliders
  src/App.tsx              Glue
  vite.config.ts           proxies /api → http://127.0.0.1:8765
```

## Requirements

- **Hardware**: Apple Silicon Mac (M1/M2/M3/M4). MLX won't accelerate on Intel.
- **Python**: 3.10+
- **Node.js**: 18+
- **Disk**: ~500 MB for model weights (one-time download).

## Setup

### 1. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
bash setup_models.sh          # downloads all weights once, then fully offline
python app.py                  # serves on http://127.0.0.1:8765
```

`setup_models.sh` downloads:
- `israwave.onnx`, `nakdimon.onnx`, and `espeak-ng-data` from the Israwave GitHub release into `backend/models/israwave/`
- Kokoro 82M (bf16) weights into the Hugging Face cache (`~/.cache/huggingface`)

Both engines lazy-load on first synthesis call. Subsequent calls reuse the loaded model.

### 2. Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev                    # opens http://127.0.0.1:5173
```

Open <http://127.0.0.1:5173>, pick a PDF, hit ▶.

## Configuration

| Setting | Where | Default |
|---|---|---|
| English voice | `backend/engines/kokoro.py` `DEFAULT_VOICE` | `af_heart` |
| English language code | `backend/engines/kokoro.py` `DEFAULT_LANG_CODE` | `a` (American) — try `b` for British |
| Server port | `backend/app.py` (`uvicorn.run`) | `8765` |
| Vite proxy target | `frontend/vite.config.ts` | `127.0.0.1:8765` |
| Israwave models dir | `ISRAWAVE_MODELS_DIR` env var | `backend/models/israwave` |

Available Kokoro voices include `af_heart`, `af_bella`, `am_adam`, `bf_alice`, etc. — see the [mlx-audio readme](https://github.com/Blaizzy/mlx-audio).

## API

### `POST /tts`

```json
{ "text": "Hello world.", "lang": "en" }
```

Returns: `audio/wav` bytes (16-bit PCM, mono, engine-native sample rate).

`lang` must be `"en"` or `"he"`.

### `GET /health`

Reports per-engine load status and sample rate.

## Architecture notes

- **Speed control** uses `HTMLAudioElement.playbackRate` with `preservesPitch = true`, so a 2× speedup doesn't chipmunk the voice. This is uniform across both engines and avoids round-tripping the model on every speed change.
- **Sentence highlighting** works by rendering the PDF.js text layer (invisible spans that align with the rendered canvas), splitting the concatenated text with `Intl.Segmenter`, and mapping each sentence back to its source spans. The active sentence's spans get a `.tts-highlight` class.
- **Prefetch** keeps the next 2 sentences' audio in flight via `AbortController`-cancelable fetches.

## Troubleshooting

- **`Israwave asset missing` on /tts** — run `bash backend/setup_models.sh` again; it's idempotent.
- **`backend offline` in the UI** — the FastAPI server isn't running on 8765, or CORS is blocked. Check `python app.py` is up.
- **Kokoro first call is slow** — yes, model loads on first request (~3-5s on M3 Pro). Subsequent requests are fast.
- **Hebrew sounds robotic on certain words** — Hebrew without diacritics is fundamentally ambiguous; Nakdimon adds vowel marks heuristically. Fix is dataset-level, not in this app.

## License

The TTS models have their own licenses:
- Kokoro: Apache 2.0
- Israwave / Nakdimon: see their repositories
