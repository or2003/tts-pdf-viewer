# PDF Reader · Multilingual TTS

A web app that reads PDFs aloud with sentence-level highlighting. Uses **Google Cloud Text-to-Speech (Neural2 / Wavenet)** as the primary engine, with **Microsoft Edge TTS** as automatic fallback. Together: ~140 languages, hundreds of neural voices. Mobile-friendly. No Python.

## Architecture

```
                                                              ┌─ Google Cloud TTS (primary)
                                                              │  https://texttospeech.googleapis.com
┌─────────────────────────┐    POST /tts             ┌────────┴───────────────┐
│  Static frontend        │ ──{ text, voice, prov }─►│  Cloudflare Worker     │
│  (Vite + React + TS)    │ ◄────── audio/mpeg ──────│  worker/ (tts-relay)   │
└─────────────────────────┘                          └────────┬───────────────┘
                                                              │  on Google failure / no key
                                                              └─ Microsoft Edge "Read Aloud" (fallback)
                                                                 wss://speech.platform.bing.com/...
```

The Worker dispatches each request to the user-selected provider, and on any failure (quota, network, missing key) silently retries via the other provider so the frontend never sees an error.

## Features

- Drop in any PDF, hit play.
- The currently spoken sentence is highlighted on the rendered PDF.
- **Skip to any sentence** (scrubber slider) or **page** (TOC drawer).
- **Per-language voice picker** — pick a default voice for each language you read.
- **Auto language detection per sentence** by Unicode script. Letterless segments like `1.` `2.` `3.` inside a Hebrew document inherit the document's dominant language (this fixes a real bug where numbered list markers were spoken in English).
- Speed control (0.5×–3×) without pitch shift; rate/pitch tunable in settings.
- Prefetches the next 2 sentences for seamless transitions.
- Mobile-friendly: bottom-fixed transport bar, full-width drawers, 44×44 touch targets.

## Project layout

```
worker/                      Cloudflare Worker — proxies browser ↔ Edge TTS WSS
  src/index.ts               POST /tts, GET /voices, GET /health
  wrangler.toml              CF config; dev port 8787
  package.json
frontend/
  src/pdf.ts                 PDF.js loader + per-page renderer with text layer
  src/sentences.ts           Intl.Segmenter splitting + back-references to PDF spans
  src/lang.ts                Script-aware BCP-47 detection + document-dominant fallback
  src/voices.ts              Voice catalog cache + per-language resolver
  src/tts.ts                 Worker client: POST /tts, GET /voices
  src/playback.ts            Playback engine: prefetch, voice lookup, seek
  src/components/
    PdfViewer.tsx            PDF render + sentence highlight
    Controls.tsx             File picker, transport, scrubber, settings/TOC buttons
    SentenceScrubber.tsx     Slider with hover tooltip
    TocDrawer.tsx            Per-page table of contents
    SettingsPanel.tsx        Voice picker, primary lang, rate/pitch, worker URL
  src/App.tsx                Glue + settings persistence
  vite.config.ts             proxies /api → $VITE_WORKER_URL || 127.0.0.1:8787
```

## Local development

You need two things running: the Worker (port 8787) and the frontend (port 5173).

```bash
# Terminal 1 — Worker
cd worker
npm install
npm run dev               # http://127.0.0.1:8787

# Terminal 2 — Frontend
cd frontend
npm install
npm run dev               # http://127.0.0.1:5173
```

Open <http://127.0.0.1:5173>, drop in a PDF, hit ▶.

## Deploy

### One-time setup (do this once before the first deploy)

**Cloudflare:**

1. Sign in to <https://dash.cloudflare.com>.
2. **Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template. Copy the token.
3. **Workers & Pages → Overview** — copy your **Account ID** (right sidebar).

**Google Cloud (recommended — better quality, ~1M chars/month free):**

1. Sign in to <https://console.cloud.google.com> and create a project.
2. **APIs & Services → Library** → enable **Cloud Text-to-Speech API**.
3. **APIs & Services → Credentials → Create credentials → API key**. Copy the key.
4. (Recommended) Edit the key, set **API restrictions → Restrict key → Cloud Text-to-Speech API**.

If you skip Google Cloud entirely, the app still works — it falls back to Microsoft Edge TTS for free.

**GitHub:**

1. Repo → **Settings → Secrets and variables → Actions**:
   - **Secrets** → add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and (optional) `GOOGLE_API_KEY`.
   - **Variables** → add `WORKER_URL` set to `https://tts-relay.<your-cf-subdomain>.workers.dev` (you'll get this after the first Worker deploy — see below).
2. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.

**First deploy:** push to `main`. The first run of `Deploy → worker` will publish the Worker (and push `GOOGLE_API_KEY` as a Worker secret if you set the GitHub secret). Copy the resulting URL into `WORKER_URL` repo variable, then re-run the workflow (Actions tab → Deploy → "Re-run failed jobs" or push an empty commit). Subsequent deploys are fully automatic.

### CI/CD pipelines

- `.github/workflows/ci.yml` — runs on every PR + non-main push. Type-checks and builds both packages.
- `.github/workflows/deploy.yml` — runs on push to `main`. Deploys the Worker, then builds the frontend with `VITE_WORKER_URL` baked in and publishes to GitHub Pages.

### Manual deploy (if you'd rather not use Actions)

```bash
# Worker
cd worker
npx wrangler login            # one-time
npm run deploy

# Frontend
cd ../frontend
VITE_WORKER_URL=https://tts-relay.<your-cf-subdomain>.workers.dev \
VITE_BASE=/tts-pdf-viewer/ \
  npm run build
# upload dist/ to GitHub Pages / Cloudflare Pages / Vercel / Netlify
```

### CORS

The Worker reads `ALLOWED_ORIGINS` from `wrangler.toml` (`[vars]` section). It currently allows:

- `https://or2003.github.io` (GitHub Pages)
- `http://localhost:5173`, `http://127.0.0.1:5173` (local dev)

Add any custom domain to that list and redeploy.

## Settings

Click the ⚙ icon in the toolbar.

- **Worker URL** — for self-hosting the relay elsewhere.
- **Primary language** — fallback for ambiguous text. The app uses this when a sentence has no letters of its own (`"1."`, `"—"`) and the document doesn't have an obvious dominant script.
- **Voice per language** — pick any voice from Google or Microsoft's catalog for each language you read. Each voice is tagged with its provider in the dropdown. Default picks prefer Google when available.
- **Rate** / **Pitch** — passed as SSML prosody (Edge) or `audioConfig` numerics (Google).

Settings persist in `localStorage`. The voice catalog is cached in `localStorage` for 24 hours.

## Local dev with Google TTS

1. `cp worker/.dev.vars.example worker/.dev.vars`
2. Paste your `GOOGLE_API_KEY` into `worker/.dev.vars` (gitignored).
3. Restart `wrangler dev`.

Without `.dev.vars`, the Worker runs in Edge-only mode.

## Notes

- **Google TTS** is the primary path. Free tier is generous (~1M chars/month for Neural2/Wavenet, ~100K for Studio/Chirp HD as of 2025) — verify on Google's pricing page if you're worried about overage.
- **Edge TTS** is Microsoft's free, undocumented endpoint (the same one Edge browser's "Read Aloud" uses). Don't ship a high-volume product on it. The Worker uses the well-known `TrustedClientToken` from the python `edge-tts` library and generates a `Sec-MS-GEC` request token. If Microsoft rotates the protocol, bump `CHROMIUM_FULL` / `CHROMIUM_MAJOR` in `worker/src/index.ts` to whatever python `edge-tts` is using.
- The Worker returns `X-TTS-Provider` and `X-TTS-Fallback` headers on each `/tts` response so you can confirm which provider served any request from the browser DevTools.
- License: the TTS endpoints belong to their respective vendors; usage is subject to their terms.
