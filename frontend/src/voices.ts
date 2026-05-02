import type { Voice } from "./types";
import { fetchVoices } from "./tts";

// v3 — added OpenAI provider voices.
const CACHE_KEY = "tts.voices.v3";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheShape {
  fetchedAt: number;
  workerUrl: string;
  voices: Voice[];
}

function readCache(workerUrl: string): Voice[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheShape;
    if (parsed.workerUrl !== workerUrl) return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed.voices;
  } catch {
    return null;
  }
}

function writeCache(workerUrl: string, voices: Voice[]) {
  try {
    const payload: CacheShape = { fetchedAt: Date.now(), workerUrl, voices };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Quota errors are non-fatal — we'll just refetch next time.
  }
}

export async function loadVoices(workerUrl: string, signal?: AbortSignal): Promise<Voice[]> {
  const cached = readCache(workerUrl);
  if (cached && cached.length > 0) return cached;
  const voices = await fetchVoices(workerUrl, signal);
  writeCache(workerUrl, voices);
  return voices;
}

export function groupByLangPrefix(voices: Voice[]): Map<string, Voice[]> {
  const m = new Map<string, Voice[]>();
  for (const v of voices) {
    const list = m.get(v.langPrefix) ?? [];
    list.push(v);
    m.set(v.langPrefix, list);
  }
  for (const list of m.values()) {
    list.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  return m;
}

/**
 * Best-default voice for a BCP-47 lang. Prefers Google over Edge (because
 * Google's Neural2/Wavenet voices sound more natural — especially for he-IL),
 * then exact-locale match, then a Female voice.
 */
export function pickDefaultVoice(voices: Voice[], lang: string): Voice | null {
  const prefix = lang.toLowerCase().split("-")[0];
  const candidates = voices.filter((v) => v.langPrefix === prefix);
  if (candidates.length === 0) return null;

  const lowered = lang.toLowerCase();
  const refine = (pool: Voice[]): Voice => {
    const exact = pool.filter((v) => v.locale.toLowerCase() === lowered);
    const inner = exact.length > 0 ? exact : pool;
    return inner.find((v) => v.gender === "Female") ?? inner[0];
  };

  const google = candidates.filter((v) => v.provider === "google");
  if (google.length > 0) return refine(google);
  return refine(candidates);
}

export function resolveVoiceForLang(
  voices: Voice[],
  voicesByLang: Record<string, string>,
  lang: string,
): Voice | null {
  const prefix = lang.toLowerCase().split("-")[0];
  const explicit = voicesByLang[prefix];
  if (explicit) {
    const v = voices.find((x) => x.shortName === explicit);
    if (v) return v;
  }
  return pickDefaultVoice(voices, lang);
}
