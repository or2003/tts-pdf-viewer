# tts-relay

Cloudflare Worker that proxies the browser to Microsoft's free Edge "Read Aloud" TTS endpoint. Microsoft does not serve CORS headers for that endpoint, so a tiny relay is required.

## Endpoints

- `POST /tts` — body `{ text, voice, rate?, pitch? }`. Returns `audio/mpeg`.
- `GET /voices` — full Edge TTS voice catalog (cached 24h client-side).
- `GET /health` — `{ status: "ok" }`.

## Local dev

```bash
npm install
npm run dev          # http://127.0.0.1:8787
```

## Deploy

```bash
npm run deploy       # publishes to <name>.<account>.workers.dev
```

## Notes

- Uses the same hardcoded `TrustedClientToken` the python `edge-tts` library uses.
- Sends `Sec-MS-GEC` token (SHA-256 of `${ticks}${TRUSTED_TOKEN}`, ticks rounded to 5-minute boundary), `Sec-MS-GEC-Version`, `ConnectionId`, and a random `MUID` cookie — all required by the upstream as of Chromium 143.
- If Microsoft bumps the required Chromium major version again, update `CHROMIUM_FULL` / `CHROMIUM_MAJOR` in `src/index.ts` to whatever the current `edge-tts` python library uses.
- No auth, no rate limit. If you deploy publicly, lock down `Access-Control-Allow-Origin` in `src/index.ts` to your frontend's origin.
