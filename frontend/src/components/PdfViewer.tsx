import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isRenderCancelled, loadPdf, renderPage, type PdfDoc, type RenderHandle } from "../pdf";
import { buildSentences } from "../sentences";
import type { Sentence } from "../types";

interface Props {
  fileBuffer: ArrayBuffer | null;
  scale: number;
  highlightedSentence: Sentence | null;
  onSentencesReady: (sentences: Sentence[]) => void;
  onSpanClick: (sentenceId: number) => void;
  sentences: Sentence[];
}

interface PageSpans {
  pageIndex: number;
  texts: string[];
}

export default function PdfViewer({
  fileBuffer,
  scale,
  highlightedSentence,
  onSentencesReady,
  onSpanClick,
  sentences,
}: Props) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pageSpansRef = useRef<Map<number, string[]>>(new Map());
  const renderToken = useRef(0);
  const sentencesEmittedRef = useRef(false);

  useEffect(() => {
    if (!fileBuffer) {
      setDoc(null);
      pageSpansRef.current.clear();
      sentencesEmittedRef.current = false;
      onSentencesReady([]);
      return;
    }
    setError(null);
    let cancelled = false;
    renderToken.current += 1;
    pageSpansRef.current.clear();
    sentencesEmittedRef.current = false;
    onSentencesReady([]);

    loadPdf(fileBuffer.slice(0))
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [fileBuffer, onSentencesReady]);

  // When scale changes we need to rerender pages; bump token so children rerun.
  useEffect(() => {
    if (!doc) return;
    renderToken.current += 1;
    pageSpansRef.current.clear();
    sentencesEmittedRef.current = false;
    onSentencesReady([]);
  }, [scale, doc, onSentencesReady]);

  const handlePageReady = useCallback(
    (page: PageSpans) => {
      if (!doc) return;
      pageSpansRef.current.set(page.pageIndex, page.texts);
      if (pageSpansRef.current.size !== doc.numPages) return;
      if (sentencesEmittedRef.current) return;
      sentencesEmittedRef.current = true;

      type SpanInput = { pageIndex: number; spanIndex: number; text: string };
      const all: SpanInput[] = [];
      let g = 0;
      for (let i = 0; i < doc.numPages; i++) {
        const texts = pageSpansRef.current.get(i) ?? [];
        for (const t of texts) {
          all.push({ pageIndex: i, spanIndex: g++, text: t });
        }
      }
      onSentencesReady(buildSentences(all));
    },
    [doc, onSentencesReady],
  );

  const handlePageError = useCallback((e: Error) => {
    setError(e.message);
  }, []);

  // Apply highlight class to spans of the active sentence.
  useEffect(() => {
    const root = document.querySelector(".pdf-pages");
    if (!root) return;
    root.querySelectorAll<HTMLSpanElement>("span.tts-highlight").forEach((s) => {
      s.classList.remove("tts-highlight");
    });
    if (!highlightedSentence) return;
    for (const ref of highlightedSentence.spans) {
      const sel = `[data-page-index="${ref.pageIndex}"] [data-global-span-index="${ref.spanIndex}"]`;
      const span = root.querySelector<HTMLSpanElement>(sel);
      if (span) span.classList.add("tts-highlight");
    }
    if (highlightedSentence.spans.length > 0) {
      const first = highlightedSentence.spans[0];
      const sel = `[data-page-index="${first.pageIndex}"] [data-global-span-index="${first.spanIndex}"]`;
      const span = root.querySelector<HTMLSpanElement>(sel);
      span?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightedSentence]);

  const spanToSentence = useMemo(() => {
    const map = new Map<number, number>();
    for (const s of sentences) {
      for (const ref of s.spans) {
        map.set(ref.spanIndex, s.id);
      }
    }
    return map;
  }, [sentences]);

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = (e.target as HTMLElement).closest<HTMLSpanElement>("span[data-global-span-index]");
    if (!target) return;
    const idx = Number(target.dataset.globalSpanIndex);
    const sentenceId = spanToSentence.get(idx);
    if (sentenceId !== undefined) onSpanClick(sentenceId);
  }

  if (error) {
    return <div className="pdf-pages error">Error: {error}</div>;
  }
  if (!fileBuffer) {
    return <div className="pdf-pages empty">Choose a PDF to start.</div>;
  }
  if (!doc) {
    return <div className="pdf-pages empty">Loading PDF…</div>;
  }

  // Compute global span offset for each page based on prior pages' span counts.
  // Children compute it themselves once they render and report.
  const spanOffsets = computeSpanOffsets(doc.numPages, pageSpansRef.current);

  return (
    <div className="pdf-pages" onClick={handleClick}>
      {Array.from({ length: doc.numPages }, (_, i) => (
        <PageView
          key={`${doc.fingerprints?.[0] ?? "doc"}-${scale}-${i}`}
          doc={doc}
          pageIndex={i}
          scale={scale}
          globalSpanOffset={spanOffsets[i]}
          onReady={handlePageReady}
          onError={handlePageError}
        />
      ))}
    </div>
  );
}

function computeSpanOffsets(numPages: number, spans: Map<number, string[]>): number[] {
  const offsets: number[] = new Array(numPages).fill(0);
  let acc = 0;
  for (let i = 0; i < numPages; i++) {
    offsets[i] = acc;
    acc += (spans.get(i) ?? []).length;
  }
  return offsets;
}

interface PageViewProps {
  doc: PdfDoc;
  pageIndex: number;
  scale: number;
  globalSpanOffset: number;
  onReady: (p: PageSpans) => void;
  onError: (e: Error) => void;
}

function PageView({ doc, pageIndex, scale, globalSpanOffset, onReady, onError }: PageViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let handle: RenderHandle | null = null;
    (async () => {
      const canvas = canvasRef.current;
      const textLayer = textLayerRef.current;
      if (!canvas || !textLayer) return;

      const page = await doc.getPage(pageIndex + 1);
      if (cancelled) return;
      handle = renderPage(page, canvas, textLayer, scale);
      const { spanTexts } = await handle.promise;
      if (cancelled) return;

      const spans = textLayer.querySelectorAll<HTMLSpanElement>("span");
      spans.forEach((span, i) => {
        span.dataset.globalSpanIndex = String(globalSpanOffset + i);
      });

      onReady({ pageIndex, texts: spanTexts });
    })().catch((e) => {
      if (cancelled || isRenderCancelled(e)) return;
      onError(e instanceof Error ? e : new Error(String(e)));
    });
    return () => {
      cancelled = true;
      handle?.cancel();
    };
  }, [doc, pageIndex, scale, globalSpanOffset, onReady, onError]);

  return (
    <div className="pdf-page" ref={containerRef} data-page-index={pageIndex}>
      <canvas ref={canvasRef} />
      <div className="text-layer" ref={textLayerRef} />
    </div>
  );
}
