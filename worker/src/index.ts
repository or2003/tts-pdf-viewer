// ─── Edge TTS (Microsoft "Read Aloud" — free, no key) ────────────────────────

const TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_BASE = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_TOKEN}`;
const EDGE_VOICE_LIST_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_TOKEN}`;
const CHROMIUM_FULL = "143.0.3650.75";
const CHROMIUM_MAJOR = "143";
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`;
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL}`;

// ─── Google Cloud TTS (paid API, generous free tier) ─────────────────────────

const GOOGLE_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
const GOOGLE_VOICES_URL = "https://texttospeech.googleapis.com/v1/voices";
const GOOGLE_TIER_RE = /(Wavenet|Neural2|Studio)/i;

// Per-locale defaults used by the fallback path. Covers the locales that
// currently get exercised; anything outside this map falls back by string-
// matching the locale prefix in the Edge voice list at runtime.
const FALLBACK_DEFAULTS: Record<string, { google: string; edge: string }> = {
	"en-US": { google: "en-US-Neural2-A", edge: "en-US-AriaNeural" },
	"en-GB": { google: "en-GB-Neural2-A", edge: "en-GB-LibbyNeural" },
	"he-IL": { google: "he-IL-Wavenet-A", edge: "he-IL-AvriNeural" },
	"ar-SA": { google: "ar-XA-Wavenet-A", edge: "ar-SA-HamedNeural" },
	"ru-RU": { google: "ru-RU-Wavenet-A", edge: "ru-RU-DmitryNeural" },
	"de-DE": { google: "de-DE-Neural2-A", edge: "de-DE-KatjaNeural" },
	"fr-FR": { google: "fr-FR-Neural2-A", edge: "fr-FR-DeniseNeural" },
	"es-ES": { google: "es-ES-Neural2-A", edge: "es-ES-ElviraNeural" },
	"zh-CN": { google: "cmn-CN-Wavenet-A", edge: "zh-CN-XiaoxiaoNeural" },
	"ja-JP": { google: "ja-JP-Neural2-B", edge: "ja-JP-NanamiNeural" },
	"ko-KR": { google: "ko-KR-Neural2-A", edge: "ko-KR-SunHiNeural" },
};

interface Env {
	ALLOWED_ORIGINS?: string;
	GOOGLE_API_KEY?: string;
	OPENAI_API_KEY?: string;
}

// ─── OpenAI TTS (paid API, gpt-4o-mini-tts / tts-1 / tts-1-hd) ───────────────

const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
const OPENAI_VOICES = [
	{ name: "alloy", gender: "Neutral" },
	{ name: "ash", gender: "Male" },
	{ name: "ballad", gender: "Male" },
	{ name: "coral", gender: "Female" },
	{ name: "echo", gender: "Male" },
	{ name: "fable", gender: "Male" },
	{ name: "nova", gender: "Female" },
	{ name: "onyx", gender: "Male" },
	{ name: "sage", gender: "Female" },
	{ name: "shimmer", gender: "Female" },
	{ name: "verse", gender: "Male" },
] as const;
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini-tts";
const OPENAI_MODELS = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"] as const;
const OPENAI_ALLOWED_MODELS = new Set<string>(OPENAI_MODELS);
// tts-1 / tts-1-hd only support the original 6 voices; the newer voices
// (ash/ballad/coral/sage/verse) require gpt-4o-mini-tts.
const OPENAI_LEGACY_VOICES = new Set<string>(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);
// Curated list of language prefixes the OpenAI voices speak well. Each voice
// is registered once per locale so it shows up in the per-language voice
// dropdown alongside Edge/Google voices.
const OPENAI_LOCALES = [
	"en-US", "he-IL", "ar-SA", "es-ES", "fr-FR", "de-DE", "zh-CN", "ja-JP",
	"ko-KR", "ru-RU", "pt-BR", "it-IT", "pl-PL", "nl-NL", "tr-TR", "sv-SE",
	"cs-CZ", "da-DK", "fi-FI", "no-NO", "hi-IN", "hu-HU", "id-ID", "th-TH",
	"vi-VN", "uk-UA", "el-GR", "ro-RO", "sk-SK", "ms-MY",
] as const;
const OPENAI_VOICE_PREFIX = "openai-";

const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

function corsHeaders(env: Env, reqOrigin: string | null): Record<string, string> {
	const list = (env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS.join(","))
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const allow = reqOrigin && list.includes(reqOrigin) ? reqOrigin : list[0] ?? "";
	return {
		"Access-Control-Allow-Origin": allow,
		Vary: "Origin",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		"Access-Control-Max-Age": "86400",
	};
}

function uuidNoDashes(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function localeFromVoice(voice: string): string {
	const parts = voice.split("-");
	return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : "en-US";
}

function generateMuid(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function generateSecMsGec(): Promise<string> {
	const ms = BigInt(Date.now());
	const epochOffsetMs = 11644473600000n;
	const ticks = (ms + epochOffsetMs) * 10000n;
	const rounded = ticks - (ticks % 3000000000n);
	const buf = new TextEncoder().encode(`${rounded.toString()}${TRUSTED_TOKEN}`);
	const hash = await crypto.subtle.digest("SHA-256", buf);
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function buildSsml(text: string, voice: string, rate: string, pitch: string): string {
	const locale = localeFromVoice(voice);
	return (
		`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${locale}'>` +
		`<voice name='${voice}'>` +
		`<prosody rate='${escapeXml(rate)}' pitch='${escapeXml(pitch)}'>${escapeXml(text)}</prosody>` +
		`</voice></speak>`
	);
}

async function readBinary(data: unknown): Promise<ArrayBuffer | null> {
	if (data instanceof ArrayBuffer) return data;
	if (data instanceof Uint8Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	if (typeof Blob !== "undefined" && data instanceof Blob) return await data.arrayBuffer();
	return null;
}

async function synthesizeEdge(text: string, voice: string, rate: string, pitch: string): Promise<Uint8Array> {
	const token = await generateSecMsGec();
	const connectionId = uuidNoDashes();
	const url = `${WSS_BASE}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${encodeURIComponent(SEC_MS_GEC_VERSION)}&ConnectionId=${connectionId}`;
	const upgradeResp = await fetch(url, {
		headers: {
			Upgrade: "websocket",
			"User-Agent": UA,
			Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
			Pragma: "no-cache",
			"Cache-Control": "no-cache",
			"Accept-Encoding": "gzip, deflate, br, zstd",
			"Accept-Language": "en-US,en;q=0.9",
			"Sec-WebSocket-Version": "13",
			Cookie: `muid=${generateMuid()};`,
		},
	});
	const ws = (upgradeResp as unknown as { webSocket: WebSocket | null }).webSocket;
	if (!ws) throw new Error(`Edge TTS upgrade failed (${upgradeResp.status})`);
	ws.accept();

	return await new Promise<Uint8Array>((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			try { ws.close(); } catch { /* ignore */ }
			fn();
		};
		const timeout = setTimeout(() => finish(() => reject(new Error("Edge TTS timeout"))), 30000);

		ws.addEventListener("message", async (ev: MessageEvent) => {
			try {
				if (typeof ev.data === "string") {
					if (ev.data.includes("Path:turn.end")) {
						clearTimeout(timeout);
						finish(() => {
							const total = chunks.reduce((n, c) => n + c.byteLength, 0);
							if (total === 0) return reject(new Error("Edge TTS returned empty audio"));
							const out = new Uint8Array(total);
							let off = 0;
							for (const c of chunks) { out.set(c, off); off += c.byteLength; }
							resolve(out);
						});
					}
					return;
				}
				const buf = await readBinary(ev.data);
				if (!buf || buf.byteLength < 2) return;
				const headerLen = new DataView(buf).getUint16(0, false);
				if (2 + headerLen >= buf.byteLength) return;
				chunks.push(new Uint8Array(buf, 2 + headerLen));
			} catch (e) {
				clearTimeout(timeout);
				finish(() => reject(e instanceof Error ? e : new Error(String(e))));
			}
		});
		ws.addEventListener("error", () => {
			clearTimeout(timeout);
			finish(() => reject(new Error("Edge TTS websocket error")));
		});
		ws.addEventListener("close", (ev: CloseEvent) => {
			clearTimeout(timeout);
			finish(() => reject(new Error(`Edge TTS closed (${ev.code} ${ev.reason || ""})`.trim())));
		});

		const ts = new Date().toISOString();
		ws.send(
			`X-Timestamp:${ts}\r\n` +
				`Content-Type:application/json; charset=utf-8\r\n` +
				`Path:speech.config\r\n\r\n` +
				`{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`,
		);
		ws.send(
			`X-RequestId:${uuidNoDashes()}\r\n` +
				`Content-Type:application/ssml+xml\r\n` +
				`X-Timestamp:${ts}Z\r\n` +
				`Path:ssml\r\n\r\n` +
				buildSsml(text, voice, rate, pitch),
		);
	});
}

function parsePercent(s: string, fallback: number): number {
	const n = parseFloat(s);
	return Number.isFinite(n) ? n : fallback;
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

async function synthesizeGoogle(text: string, voice: string, rate: string, pitch: string, apiKey: string): Promise<Uint8Array> {
	const languageCode = localeFromVoice(voice);
	// "+10%" → 1.10 ; "-25%" → 0.75
	const speakingRate = Math.max(0.25, Math.min(4, 1 + parsePercent(rate, 0) / 100));
	// "+5Hz" → 5 (Google uses semitones — close enough for our small range)
	const pitchSemitones = Math.max(-20, Math.min(20, parsePercent(pitch, 0)));

	const resp = await fetch(`${GOOGLE_TTS_URL}?key=${encodeURIComponent(apiKey)}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			input: { text },
			voice: { languageCode, name: voice },
			audioConfig: { audioEncoding: "MP3", speakingRate, pitch: pitchSemitones },
		}),
	});
	if (!resp.ok) {
		const detail = await resp.text().catch(() => "");
		throw new Error(`Google TTS failed (${resp.status}): ${detail.slice(0, 200)}`);
	}
	const data = (await resp.json()) as { audioContent?: string };
	if (!data.audioContent) throw new Error("Google TTS returned no audioContent");
	return base64ToBytes(data.audioContent);
}

// Parse `openai-<model>-<voiceName>` ShortNames. Voice names are simple
// alphanumeric tokens with no hyphens, so the trailing `-<voiceName>` always
// terminates the model. Returns null if the ShortName isn't an OpenAI voice.
function parseOpenAIShortName(shortName: string): { model: string; voice: string } | null {
	if (!shortName.startsWith(OPENAI_VOICE_PREFIX)) return null;
	const rest = shortName.slice(OPENAI_VOICE_PREFIX.length);
	const lastDash = rest.lastIndexOf("-");
	if (lastDash <= 0) return { model: OPENAI_DEFAULT_MODEL, voice: rest };
	const model = rest.slice(0, lastDash);
	const voice = rest.slice(lastDash + 1);
	return { model, voice };
}

async function synthesizeOpenAI(
	text: string,
	voice: string,
	rate: string,
	model: string,
	apiKey: string,
): Promise<Uint8Array> {
	// Either the ShortName encodes (model, voice) — preferred — or a bare voice
	// id like `openai-nova` is paired with an explicit `model` field.
	const parsed = parseOpenAIShortName(voice);
	const openaiVoice = parsed ? parsed.voice : voice;
	const inferredModel = parsed?.model;
	const candidate = inferredModel || model;
	const useModel = OPENAI_ALLOWED_MODELS.has(candidate) ? candidate : OPENAI_DEFAULT_MODEL;
	const speed = Math.max(0.25, Math.min(4, 1 + parsePercent(rate, 0) / 100));

	const resp = await fetch(OPENAI_TTS_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: useModel,
			input: text,
			voice: openaiVoice,
			response_format: "mp3",
			speed,
		}),
	});
	if (!resp.ok) {
		const detail = await resp.text().catch(() => "");
		throw new Error(`OpenAI TTS failed (${resp.status}): ${detail.slice(0, 200)}`);
	}
	const buf = await resp.arrayBuffer();
	return new Uint8Array(buf);
}

// ─── Voice catalogs ──────────────────────────────────────────────────────────

interface UnifiedVoice {
	ShortName: string;
	Locale: string;
	Gender: string;
	FriendlyName: string;
	DisplayName: string;
	provider: "edge" | "google" | "openai";
	openaiModel?: string;
}

interface RawEdgeVoice {
	ShortName: string;
	Locale: string;
	Gender: string;
	FriendlyName?: string;
	DisplayName?: string;
}

interface RawGoogleVoice {
	name: string;
	languageCodes: string[];
	ssmlGender: string;
}

async function fetchEdgeVoices(): Promise<UnifiedVoice[]> {
	const tok = await generateSecMsGec();
	const url = `${EDGE_VOICE_LIST_URL}&Sec-MS-GEC=${tok}&Sec-MS-GEC-Version=${encodeURIComponent(SEC_MS_GEC_VERSION)}`;
	const r = await fetch(url, { headers: { "User-Agent": UA } });
	if (!r.ok) throw new Error(`Edge voices ${r.status}`);
	const raw = (await r.json()) as RawEdgeVoice[];
	return raw.map((v) => ({
		ShortName: v.ShortName,
		Locale: v.Locale,
		Gender: v.Gender,
		FriendlyName: v.FriendlyName ?? v.ShortName,
		DisplayName: v.DisplayName ?? v.FriendlyName ?? v.ShortName,
		provider: "edge",
	}));
}

function buildOpenAIVoices(): UnifiedVoice[] {
	const out: UnifiedVoice[] = [];
	for (const locale of OPENAI_LOCALES) {
		for (const model of OPENAI_MODELS) {
			for (const v of OPENAI_VOICES) {
				// tts-1 / tts-1-hd only support the original 6 voices.
				if (model !== "gpt-4o-mini-tts" && !OPENAI_LEGACY_VOICES.has(v.name)) continue;
				const display = `OpenAI ${v.name} (${model})`;
				out.push({
					ShortName: `${OPENAI_VOICE_PREFIX}${model}-${v.name}`,
					Locale: locale,
					Gender: v.gender,
					FriendlyName: display,
					DisplayName: display,
					provider: "openai",
					openaiModel: model,
				});
			}
		}
	}
	return out;
}

async function fetchGoogleVoices(apiKey: string): Promise<UnifiedVoice[]> {
	const r = await fetch(`${GOOGLE_VOICES_URL}?key=${encodeURIComponent(apiKey)}`);
	if (!r.ok) throw new Error(`Google voices ${r.status}`);
	const data = (await r.json()) as { voices?: RawGoogleVoice[] };
	const out: UnifiedVoice[] = [];
	for (const v of data.voices ?? []) {
		if (!GOOGLE_TIER_RE.test(v.name)) continue;
		const locale = v.languageCodes[0] ?? "";
		const gender =
			v.ssmlGender === "FEMALE" ? "Female" :
			v.ssmlGender === "MALE" ? "Male" :
			"Neutral";
		const tier = v.name.match(GOOGLE_TIER_RE)?.[0] ?? "";
		out.push({
			ShortName: v.name,
			Locale: locale,
			Gender: gender,
			FriendlyName: `${v.name} (${tier})`,
			DisplayName: v.name,
			provider: "google",
		});
	}
	return out;
}

// ─── /tts dispatch with fallback ─────────────────────────────────────────────

type Provider = "edge" | "google" | "openai";

interface TtsBody {
	text?: string;
	voice?: string;
	rate?: string;
	pitch?: string;
	provider?: Provider;
	model?: string; // OpenAI model when provider === "openai"
}

function pickFallbackVoice(originalVoice: string, target: Exclude<Provider, "openai">): string | null {
	const locale = localeFromVoice(originalVoice);
	const entry = FALLBACK_DEFAULTS[locale];
	return entry ? entry[target] : null;
}

async function synthesizeWithFallback(
	body: Required<Pick<TtsBody, "text" | "voice" | "rate" | "pitch">> & { provider: Provider; model: string },
	env: Env,
): Promise<{ audio: Uint8Array; usedProvider: Provider; usedFallback: boolean }> {
	let primary = body.provider;
	if (primary === "google" && !env.GOOGLE_API_KEY) primary = "edge";
	if (primary === "openai" && !env.OPENAI_API_KEY) primary = "edge";

	const tryOne = async (p: Provider, voice: string): Promise<Uint8Array> => {
		if (p === "google") {
			if (!env.GOOGLE_API_KEY) throw new Error("Google TTS not configured");
			return await synthesizeGoogle(body.text, voice, body.rate, body.pitch, env.GOOGLE_API_KEY);
		}
		if (p === "openai") {
			if (!env.OPENAI_API_KEY) throw new Error("OpenAI TTS not configured");
			return await synthesizeOpenAI(body.text, voice, body.rate, body.model, env.OPENAI_API_KEY);
		}
		return await synthesizeEdge(body.text, voice, body.rate, body.pitch);
	};

	try {
		const audio = await tryOne(primary, body.voice);
		return { audio, usedProvider: primary, usedFallback: false };
	} catch (primaryErr) {
		// Always fall back to Edge (free, always available).
		if (primary === "edge") throw primaryErr;
		const fallbackLocaleVoice = pickFallbackVoice(body.voice, "edge");
		const fallbackVoice = fallbackLocaleVoice ?? "en-US-AriaNeural";

		console.log(`[tts] ${primary} failed (${primaryErr instanceof Error ? primaryErr.message : primaryErr}), retrying via edge with ${fallbackVoice}`);
		try {
			const audio = await tryOne("edge", fallbackVoice);
			return { audio, usedProvider: "edge", usedFallback: true };
		} catch (secondaryErr) {
			console.log(`[tts] fallback also failed: ${secondaryErr instanceof Error ? secondaryErr.message : secondaryErr}`);
			throw primaryErr;
		}
	}
}

// ─── HTTP entry point ────────────────────────────────────────────────────────

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const reqOrigin = req.headers.get("Origin");
		const cors = corsHeaders(env, reqOrigin);

		if (req.method === "OPTIONS") return new Response(null, { headers: cors });
		const url = new URL(req.url);

		if (url.pathname === "/health") {
			return new Response(
				JSON.stringify({
					status: "ok",
					googleEnabled: Boolean(env.GOOGLE_API_KEY),
					openaiEnabled: Boolean(env.OPENAI_API_KEY),
				}),
				{ headers: { ...cors, "Content-Type": "application/json" } },
			);
		}

		if (url.pathname === "/voices" && req.method === "GET") {
			const tasks: Array<Promise<UnifiedVoice[]>> = [fetchEdgeVoices()];
			if (env.GOOGLE_API_KEY) tasks.push(fetchGoogleVoices(env.GOOGLE_API_KEY));
			const settled = await Promise.allSettled(tasks);
			const edgeRes = settled[0];
			const googleRes = settled[1];
			const merged: UnifiedVoice[] = [];
			if (googleRes && googleRes.status === "fulfilled") merged.push(...googleRes.value);
			if (edgeRes.status === "fulfilled") merged.push(...edgeRes.value);
			if (env.OPENAI_API_KEY) merged.push(...buildOpenAIVoices());
			if (merged.length === 0) {
				const reason = edgeRes.status === "rejected" ? edgeRes.reason : "no providers available";
				return new Response(`Voices unavailable: ${reason}`, { status: 502, headers: cors });
			}
			return new Response(JSON.stringify(merged), {
				headers: {
					...cors,
					"Content-Type": "application/json",
					"Cache-Control": "public, max-age=86400",
				},
			});
		}

		if (url.pathname === "/tts" && req.method === "POST") {
			let body: TtsBody;
			try {
				body = await req.json();
			} catch {
				return new Response("Invalid JSON", { status: 400, headers: cors });
			}
			const text = (body.text ?? "").trim();
			const voice = (body.voice ?? "").trim();
			const rate = body.rate ?? "+0%";
			const pitch = body.pitch ?? "+0Hz";
			const provider: Provider =
				body.provider === "google" || body.provider === "edge" || body.provider === "openai"
					? body.provider
					: "edge";
			const model = (body.model ?? OPENAI_DEFAULT_MODEL).trim() || OPENAI_DEFAULT_MODEL;
			if (!text) return new Response("Missing text", { status: 400, headers: cors });
			if (!voice) return new Response("Missing voice", { status: 400, headers: cors });
			try {
				const result = await synthesizeWithFallback({ text, voice, rate, pitch, provider, model }, env);
				return new Response(result.audio, {
					headers: {
						...cors,
						"Content-Type": "audio/mpeg",
						"Cache-Control": "no-store",
						"X-TTS-Provider": result.usedProvider,
						"X-TTS-Fallback": result.usedFallback ? "1" : "0",
					},
				});
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return new Response(msg, { status: 502, headers: cors });
			}
		}

		return new Response("Not found", { status: 404, headers: cors });
	},
};
