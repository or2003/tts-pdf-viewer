import type { Lang } from "./types";

export async function fetchSentenceAudio(text: string, lang: Lang, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, lang }),
    signal,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`TTS failed (${res.status}): ${msg}`);
  }
  return await res.blob();
}

export async function checkBackendHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, detail: JSON.stringify(data.engines) };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
