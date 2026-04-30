# PDF Reader

A web app that reads PDFs aloud with sentence-level highlighting. Tested on MacBook Pro M3 Pro. Supports **English** and **Hebrew**.

- **English** → [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) on [mlx-audio](https://github.com/Blaizzy/mlx-audio), local (Apple-native, ~100× realtime on M-series)
- **Hebrew** → [Microsoft Edge TTS](https://github.com/rany2/edge-tts) neural voices (cloud, no API key required, needs network at request time)
- **PDF rendering** → PDF.js with text layer alignment for highlighting
- **Frontend** → Vite + React + TypeScript

English runs on-device after the one-time Kokoro download. Hebrew streams from Microsoft's public Edge TTS endpoint per request — natural neural voices, but requires network connectivity.

## Features

- Drop in any PDF, hit play, listen to it.
- The currently spoken sentence is highlighted directly on the rendered PDF.
- Click any sentence to jump playback there.
- Speed control (0.5×–3×) without pitch shift.
- Auto language detection per sentence (Hebrew Unicode block → Edge TTS; otherwise Kokoro).
- Sentences are prefetched ahead of playback, so transitions are seamless.

## Project layout

```
backend/
  app.py                   FastAPI server, POST /tts, GET /health
  engines/kokoro.py        English: Kokoro 82M via mlx-audio (lazy-loaded)
  engines/edge_tts.py      Hebrew: Microsoft Edge TTS (cloud, per-request)
  setup_models.sh          One-shot download of Kokoro weights
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
- **Disk**: ~350 MB for Kokoro weights (one-time download).
- **Network**: required at request time for Hebrew (Edge TTS streams from Microsoft's endpoint).

## Setup

### 1. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
bash setup_models.sh          # downloads Kokoro weights once
python app.py                  # serves on http://127.0.0.1:8765
```

`setup_models.sh` downloads Kokoro 82M (bf16) into the Hugging Face cache (`~/.cache/huggingface`). Edge TTS needs no pre-cache — it streams from Microsoft per request.

Kokoro lazy-loads on first English synthesis call. Edge TTS makes a fresh streaming request each time.

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
| Hebrew voice | `EDGE_TTS_HE_VOICE` env var | `he-IL-AvriNeural` (try `he-IL-HilaNeural` for female) |
| Hebrew speech rate | `EDGE_TTS_RATE` env var | `+0%` (e.g. `-10%` for slower) |
| Hebrew pitch | `EDGE_TTS_PITCH` env var | `+0Hz` |

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

- **Edge TTS request fails** — check network connectivity. Microsoft's endpoint occasionally rate-limits; retry usually works.
- **`backend offline` in the UI** — the FastAPI server isn't running on 8765, or CORS is blocked. Check `python app.py` is up.
- **First English synthesis is slow** — Kokoro lazy-loads on first request (~3-5s on M3 Pro). Subsequent calls are fast. Edge TTS has a steady ~1-2s/sentence latency from network round-trip.

## License

The TTS engines have their own terms:
- Kokoro: Apache 2.0 (model weights)
- Edge TTS: Microsoft's public TTS endpoint, accessed via the [edge-tts](https://github.com/rany2/edge-tts) library. Use is subject to Microsoft's terms of service — not intended for production / high-volume use.
