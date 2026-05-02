import type { Lang } from "./types";

/**
 * Per-script character counts for a piece of text. Letters only —
 * digits, punctuation, whitespace, emoji and other symbols are excluded.
 */
export interface ScriptCounts {
  hebrew: number;
  arabic: number;
  cyrillic: number;
  greek: number;
  devanagari: number;
  thai: number;
  hangul: number;
  hiragana: number;
  katakana: number;
  cjk: number;
  latin: number;
  totalLetters: number;
}

const RANGES: Array<{ key: keyof Omit<ScriptCounts, "totalLetters" | "latin">; lo: number; hi: number }> = [
  { key: "hebrew", lo: 0x0590, hi: 0x05ff },
  { key: "arabic", lo: 0x0600, hi: 0x06ff },
  { key: "arabic", lo: 0x0750, hi: 0x077f },
  { key: "arabic", lo: 0xfb50, hi: 0xfdff },
  { key: "arabic", lo: 0xfe70, hi: 0xfeff },
  { key: "cyrillic", lo: 0x0400, hi: 0x04ff },
  { key: "greek", lo: 0x0370, hi: 0x03ff },
  { key: "devanagari", lo: 0x0900, hi: 0x097f },
  { key: "thai", lo: 0x0e00, hi: 0x0e7f },
  { key: "hangul", lo: 0xac00, hi: 0xd7af },
  { key: "hangul", lo: 0x1100, hi: 0x11ff },
  { key: "hiragana", lo: 0x3040, hi: 0x309f },
  { key: "katakana", lo: 0x30a0, hi: 0x30ff },
  { key: "cjk", lo: 0x4e00, hi: 0x9fff },
  { key: "cjk", lo: 0x3400, hi: 0x4dbf },
];

const LATIN_RE = /[A-Za-zÀ-ɏ]/;

const NON_LATIN_LANG_PREFIXES = new Set([
  "he", "ar", "ru", "uk", "bg", "sr", "mk", "be",
  "el", "hi", "mr", "ne", "th", "ko", "ja", "zh",
  "yue", "fa", "ur", "ps", "yi", "iw",
]);

export function isLatinScriptLang(lang: Lang): boolean {
  const prefix = lang.toLowerCase().split("-")[0];
  return !NON_LATIN_LANG_PREFIXES.has(prefix);
}

export function countScripts(text: string): ScriptCounts {
  const c: ScriptCounts = {
    hebrew: 0, arabic: 0, cyrillic: 0, greek: 0, devanagari: 0, thai: 0,
    hangul: 0, hiragana: 0, katakana: 0, cjk: 0, latin: 0, totalLetters: 0,
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (LATIN_RE.test(ch)) {
      c.latin++;
      c.totalLetters++;
      continue;
    }
    for (const r of RANGES) {
      if (cp >= r.lo && cp <= r.hi) {
        c[r.key]++;
        c.totalLetters++;
        break;
      }
    }
  }
  return c;
}

const SCRIPT_TO_LANG: Record<keyof Omit<ScriptCounts, "totalLetters" | "latin">, Lang> = {
  hebrew: "he",
  arabic: "ar",
  cyrillic: "ru",
  greek: "el",
  devanagari: "hi",
  thai: "th",
  hangul: "ko",
  hiragana: "ja",
  katakana: "ja",
  cjk: "zh",
};

function dominantNonLatin(c: ScriptCounts): Lang | null {
  let best: keyof typeof SCRIPT_TO_LANG | null = null;
  let max = 0;
  (Object.keys(SCRIPT_TO_LANG) as Array<keyof typeof SCRIPT_TO_LANG>).forEach((k) => {
    if (c[k] > max) { max = c[k]; best = k; }
  });
  // Kana presence forces Japanese over generic CJK (Chinese)
  if ((c.hiragana + c.katakana) > 0) return "ja";
  return best ? SCRIPT_TO_LANG[best] : null;
}

/**
 * Detect BCP-47 lang for a piece of text. `fallback` is the document-dominant
 * language (or user's primary-language setting). It's used when:
 *   - the text has no letters at all (e.g. "1.", "—"),
 *   - the text has only a couple of stray Latin chars inside a non-Latin doc.
 */
export function detectLangFor(text: string, fallback: Lang): Lang {
  const c = countScripts(text);
  if (c.totalLetters === 0) return fallback;

  const nonLatinDom = dominantNonLatin(c);
  const nonLatinTotal = c.totalLetters - c.latin;

  if (nonLatinDom && nonLatinTotal >= c.latin) return nonLatinDom;

  // Few-letter edge case inside a non-Latin doc — inherit fallback.
  if (c.totalLetters < 3 && !isLatinScriptLang(fallback)) return fallback;

  if (c.latin > 0) return isLatinScriptLang(fallback) ? fallback : "en";
  return nonLatinDom ?? fallback;
}

/**
 * Compute the document-dominant language across all sentence texts. Used as
 * the fallback for letterless segments (the "1." in a Hebrew doc bug).
 */
export function documentDominantLang(texts: string[], primaryLang: Lang): Lang {
  const total: ScriptCounts = {
    hebrew: 0, arabic: 0, cyrillic: 0, greek: 0, devanagari: 0, thai: 0,
    hangul: 0, hiragana: 0, katakana: 0, cjk: 0, latin: 0, totalLetters: 0,
  };
  for (const t of texts) {
    const c = countScripts(t);
    (Object.keys(total) as Array<keyof ScriptCounts>).forEach((k) => { total[k] += c[k]; });
  }
  if (total.totalLetters === 0) return primaryLang;
  const nonLatinDom = dominantNonLatin(total);
  const nonLatinTotal = total.totalLetters - total.latin;
  if (nonLatinDom && nonLatinTotal > total.latin) return nonLatinDom;
  return primaryLang;
}
