import type { Lang, Sentence, SpanRef } from "./types";
import { detectLangFor, documentDominantLang } from "./lang";

interface SpanInput {
  pageIndex: number;
  spanIndex: number;
  text: string;
}

/**
 * Build sentences spanning across PDF text-layer spans. Each sentence carries
 * back-references to the spans it covers so the UI can highlight them.
 *
 * Language assignment is two-pass: first segment, then assign per-sentence lang
 * using the document's dominant script as the fallback for segments that have
 * no letters of their own (e.g. list markers like "1." inside a Hebrew doc).
 */
export function buildSentences(spans: SpanInput[], primaryLang: Lang = "en"): Sentence[] {
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

  // Pass 1: collect segments with their span refs.
  type Draft = { text: string; spans: SpanRef[] };
  const drafts: Draft[] = [];
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
    drafts.push({ text: trimmed, spans: refs });
  }

  if (drafts.length === 0) return [];

  // Pass 2: compute document-dominant lang and assign per-sentence lang.
  const docLang = documentDominantLang(drafts.map((d) => d.text), primaryLang);
  return drafts.map((d, i) => ({
    id: i,
    text: d.text,
    lang: detectLangFor(d.text, docLang),
    spans: d.spans,
  }));
}
