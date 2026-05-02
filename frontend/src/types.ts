/** BCP-47 language tag, e.g. "en", "he", "zh-CN". */
export type Lang = string;

export interface SpanRef {
  pageIndex: number;
  spanIndex: number;
  charStart: number;
  charEnd: number;
}

export interface Sentence {
  id: number;
  text: string;
  lang: Lang;
  spans: SpanRef[];
}

export interface PageRender {
  pageIndex: number;
  width: number;
  height: number;
  spanTexts: string[];
}

export type Provider = "edge" | "google";

export interface Voice {
  shortName: string;     // e.g. "en-US-AriaNeural" or "en-US-Neural2-A"
  locale: string;        // e.g. "en-US"
  langPrefix: string;    // e.g. "en"
  gender: string;        // "Male" | "Female" | ...
  displayName: string;   // human-readable name
  friendlyName: string;  // longer marketing name from the API
  provider: Provider;    // which upstream synthesizes this voice
}

export interface Settings {
  primaryLang: Lang;                       // doc fallback when script can't decide
  voicesByLang: Record<string, string>;    // langPrefix -> voice shortName
  rate: string;                            // "+0%" .. "+50%" .. "-25%"
  pitch: string;                           // "+0Hz" .. "+5Hz" .. "-5Hz"
  workerUrl: string;                       // base URL of the tts-relay Worker
}
