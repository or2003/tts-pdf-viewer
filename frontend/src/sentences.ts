import type { Lang, Sentence, SpanRef } from "./types";

const HEBREW_RE = /[֐-׿]/;

export function detectLang(text: string): Lang {
  return HEBREW_RE.test(text) ? "he" : "en";
}

interface SpanInput {
  pageIndex: number;
  spanIndex: number;
  text: string;
}

/**
 * Build sentences spanning across PDF text-layer spans. Each sentence carries
 * back-references to the spans it covers so the UI can highlight them.
 */
export function buildSentences(spans: SpanInput[]): Sentence[] {
  if (spans.length === 0) return [];

  const joiner = " ";
  let cursor = 0;
  type SpanRange = { spanIndex: number; pageIndex: number; start: number; end: number };
  const ranges: SpanRange[] = [];
  const parts: string[] = [];

  spans.forEach((s, i) => {
    const start = cursor;
    const end = start + s.text.length;
    ranges.push({ spanIndex: s.spanIndex, pageIndex: s.pageIndex, start, end });
    parts.push(s.text);
    cursor = end;
    if (i < spans.length - 1) {
      parts.push(joiner);
      cursor += joiner.length;
    }
  });

  const fullText = parts.join("");
  if (!fullText.trim()) return [];

  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

  const sentences: Sentence[] = [];
  let id = 0;
  for (const seg of segmenter.segment(fullText)) {
    const raw = seg.segment;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const segStart = seg.index + raw.indexOf(trimmed);
    const segEnd = segStart + trimmed.length;

    const refs: SpanRef[] = [];
    for (const r of ranges) {
      if (r.end <= segStart) continue;
      if (r.start >= segEnd) break;
      const charStart = Math.max(0, segStart - r.start);
      const charEnd = Math.min(r.end - r.start, segEnd - r.start);
      if (charEnd > charStart) {
        refs.push({
          pageIndex: r.pageIndex,
          spanIndex: r.spanIndex,
          charStart,
          charEnd,
        });
      }
    }
    if (refs.length === 0) continue;

    sentences.push({
      id: id++,
      text: trimmed,
      lang: detectLang(trimmed),
      spans: refs,
    });
  }
  return sentences;
}
