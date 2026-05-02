import type { Provider, Voice } from "./types";

export interface TtsRequest {
  text: string;
  voice: string;        // shortName
  provider: Provider;   // which upstream the Worker should dispatch to first
  rate?: string;        // "+0%"
  pitch?: string;       // "+0Hz"
  model?: string;       // OpenAI model when provider === "openai"
}

function joinUrl(base: string, path: string): string {
  if (!base) return path;
  return base.replace(/\/+$/, "") + path;
}

export async function fetchSentenceAudio(
  workerUrl: string,
  req: TtsRequest,
  signal?: AbortSignal,
): Promise<Blob> {
  const res = await fetch(joinUrl(workerUrl, "/tts"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`TTS failed (${res.status}): ${msg}`);
  }
  return await res.blob();
}

interface RawVoice {
  ShortName: string;
  Gender: string;
  Locale: string;
  FriendlyName?: string;
  DisplayName?: string;
  provider?: Provider;
}

export async function fetchVoices(workerUrl: string, signal?: AbortSignal): Promise<Voice[]> {
  const res = await fetch(joinUrl(workerUrl, "/voices"), { signal });
  if (!res.ok) {
    throw new Error(`Voices fetch failed (${res.status})`);
  }
  const raw = (await res.json()) as RawVoice[];
  return raw.map((v) => ({
    shortName: v.ShortName,
    locale: v.Locale,
    langPrefix: (v.Locale.split("-")[0] || "").toLowerCase(),
    gender: v.Gender,
    displayName: v.DisplayName ?? v.FriendlyName ?? v.ShortName,
    friendlyName: v.FriendlyName ?? v.ShortName,
    provider: v.provider ?? "edge",
  }));
}
