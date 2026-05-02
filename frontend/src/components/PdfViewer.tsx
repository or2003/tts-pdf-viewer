import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  extractPageText,
  isRenderCancelled,
  loadPdf,
  renderPage,
  type PdfDoc,
  type RenderHandle,
} from "../pdf";
import { buildSentences } from "../sentences";
import type { Sentence } from "../types";

interface Props {
  fileBuffer: ArrayBuffer | null;
  scale: number;
  primaryLang: string;
  highlightedSentence: Sentence | null;
  onSentencesReady: (sentences: Sentence[]) => void;
  onSpanClick: (sentenceId: number) => void;
  sentences: Sentence[];
}

interface PageDim {
  w: number;
  h: number;
}

const ACTIVE_RADIUS = 1;

export default function PdfViewer({
  fileBuffer,
  scale,
  primaryLang,
  highlightedSentence,
  onSentencesReady,
  onSpanClick,
  sentences,
}: Props) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageDims, setPageDims] = useState<(PageDim | null)[]>([]);
  const [textPassComplete, setTextPassComplete] = useState(false);
  const [activePages, setActivePages] = useState<Set<number>>(new Set());

  const pageSpansRef = useRef<Map<number, string[]>>(new Map());
  const pinnedPagesRef = useRef<Set<number>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const pageElsRef = useRef<Map<number, HTMLElement>>(new Map());
  const visibleSetRef = useRef<Set<number>>(new Set());
  const refCallbacksRef = useRef<Map<number, (el: HTMLElement | null) => void>>(new Map());
  const passToken = useRef(0);

  // Load PDF
  useEffect(() => {
    if (!fileBuffer) {
      setDoc(null);
      setPageDims([]);
      setTextPassComplete(false);
      setActivePages(new Set());
      pageSpansRef.current.clear();
      pinnedPagesRef.current.clear();
      visibleSetRef.current.clear();
      onSentencesReady([]);
      return;
    }
    setError(null);
    let cancelled = false;
    passToken.current += 1;
    pageSpansRef.current.clear();
    pinnedPagesRef.current.clear();
    visibleSetRef.current.clear();
    setPageDims([]);
    setTextPassComplete(false);
    setActivePages(new Set());
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

  // Upfront text pass — independent of scale.
  useEffect(() => {
    if (!doc) return;
    const myToken = ++passToken.current;
    let cancelled = false;
    setTextPassComplete(false);
    pageSpansRef.current.clear();

    (async () => {
      for (let i = 0; i < doc.numPages; i++) {
        if (cancelled || passToken.current !== myToken) return;
        const page = await doc.getPage(i + 1);
        if (cancelled || passToken.current !== myToken) return;
        const texts = await extractPageText(page);
        if (cancelled || passToken.current !== myToken) return;
        pageSpansRef.current.set(i, texts);
      }
      if (cancelled || passToken.current !== myToken) return;

      type SpanInput = { pageIndex: number; spanIndex: number; text: string };
      const all: SpanInput[] = [];
      let g = 0;
      for (let i = 0; i < doc.numPages; i++) {
        const texts = pageSpansRef.current.get(i) ?? [];
        for (const t of texts) all.push({ pageIndex: i, spanIndex: g++, text: t });
      }
      onSentencesReady(buildSentences(all, primaryLang));
      setTextPassComplete(true);
    })().catch((e) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      cancelled = true;
    };
  }, [doc, primaryLang, onSentencesReady]);

  // Dim pass — recomputes on scale change. Updates entries in place so old
  // dims stay around until replaced (avoids scroll jumps).
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < doc.numPages; i++) {
        if (cancelled) return;
        const page = await doc.getPage(i + 1);
        if (cancelled) return;
        const vp = page.getViewport({ scale });
        const dim: PageDim = { w: Math.floor(vp.width), h: Math.floor(vp.height) };
        setPageDims((prev) => {
          const next =
            prev.length === doc.numPages ? prev.slice() : new Array(doc.numPages).fill(null);
          next[i] = dim;
          return next;
        });
      }
    })().catch((e) => {
      if (!cancelled) console.error("PDF dim pass failed:", e);
    });
    return () => {
      cancelled = true;
    };
  }, [doc, scale]);

  // IntersectionObserver — maintain active page set based on visibility.
  useEffect(() => {
    if (!doc) return;
    const root = document.querySelector(".pdf-pages");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idxStr = (e.target as HTMLElement).dataset.pageIndex;
          if (idxStr == null) continue;
          const idx = Number(idxStr);
          if (e.isIntersecting) visibleSetRef.current.add(idx);
          else visibleSetRef.current.delete(idx);
        }
        const next = new Set<number>();
        for (const v of visibleSetRef.current) {
          for (let d = -ACTIVE_RADIUS; d <= ACTIVE_RADIUS; d++) {
            const k = v + d;
            if (k >= 0 && k < doc.numPages) next.add(k);
          }
        }
        for (const p of pinnedPagesRef.current) next.add(p);

        setActivePages((prev) => {
          if (prev.size === next.size) {
            let same = true;
            for (const k of next) if (!prev.has(k)) { same = false; break; }
            if (same) return prev;
          }
          return next;
        });
      },
      { root: root as Element | null, rootMargin: "200px 0px" },
    );
    observerRef.current = observer;
    for (const el of pageElsRef.current.values()) observer.observe(el);
    return () => {
      observer.disconnect();
      observerRef.current = null;
      visibleSetRef.current.clear();
    };
  }, [doc]);

  const registerPageEl = useCallback((index: number, el: HTMLElement | null) => {
    const map = pageElsRef.current;
    const prev = map.get(index);
    if (prev && prev !== el) {
      observerRef.current?.unobserve(prev);
      map.delete(index);
    }
    if (el) {
      map.set(index, el);
      observerRef.current?.observe(el);
    }
  }, []);

  const getRefCb = useCallback(
    (i: number) => {
      let cb = refCallbacksRef.current.get(i);
      if (!cb) {
        cb = (el: HTMLElement | null) => registerPageEl(i, el);
        refCallbacksRef.current.set(i, cb);
      }
      return cb;
    },
    [registerPageEl],
  );

  // Highlight pin + scroll. Pins target pages so they get rendered, then
  // retries DOM lookup on rAF until spans exist or budget runs out.
  useEffect(() => {
    if (!doc) return;
    if (!highlightedSentence) {
      pinnedPagesRef.current.clear();
      const rootEl = document.querySelector(".pdf-pages");
      rootEl?.querySelectorAll<HTMLSpanElement>("span.tts-highlight").forEach((s) =>
        s.classList.remove("tts-highlight"),
      );
      return;
    }
    const needed = new Set(highlightedSentence.spans.map((s) => s.pageIndex));
    pinnedPagesRef.current = needed;
    setActivePages((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const p of needed) {
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    let frames = 30;
    let raf = 0;
    const tick = () => {
      const rootEl = document.querySelector(".pdf-pages");
      if (!rootEl) return;
      rootEl.querySelectorAll<HTMLSpanElement>("span.tts-highlight").forEach((s) =>
        s.classList.remove("tts-highlight"),
      );
      let allFound = true;
      for (const ref of highlightedSentence.spans) {
        const sel = `[data-page-index="${ref.pageIndex}"] [data-global-span-index="${ref.spanIndex}"]`;
        const span = rootEl.querySelector<HTMLSpanElement>(sel);
        if (span) span.classList.add("tts-highlight");
        else allFound = false;
      }
      if (!allFound && frames-- > 0) {
        raf = requestAnimationFrame(tick);
        return;
      }
      if (highlightedSentence.spans.length > 0) {
        const first = highlightedSentence.spans[0];
        const sel = `[data-page-index="${first.pageIndex}"] [data-global-span-index="${first.spanIndex}"]`;
        const span = rootEl.querySelector<HTMLSpanElement>(sel);
        span?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [highlightedSentence, doc, activePages]);

  const handlePageError = useCallback((e: Error) => {
    setError(e.message);
  }, []);

  const spanToSentence = useMemo(() => {
    const map = new Map<number, number>();
    for (const s of sentences) for (const ref of s.spans) map.set(ref.spanIndex, s.id);
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

  const spanOffsets = computeSpanOffsets(doc.numPages, pageSpansRef.current);

  return (
    <div className="pdf-pages" onClick={handleClick}>
      {Array.from({ length: doc.numPages }, (_, i) => {
        const dim = pageDims[i] ?? null;
        const active = textPassComplete && dim && activePages.has(i);
        if (active) {
          return (
            <PageView
              key={`${doc.fingerprints?.[0] ?? "doc"}-${scale}-${i}`}
              doc={doc}
              pageIndex={i}
              scale={scale}
              globalSpanOffset={spanOffsets[i]}
              registerEl={getRefCb(i)}
              onError={handlePageError}
              dim={dim}
            />
          );
        }
        const placeholderStyle: React.CSSProperties = dim
          ? { width: dim.w, height: dim.h }
          : { minHeight: "100vh", width: "min(800px, 100%)" };
        return (
          <div
            key={`placeholder-${scale}-${i}`}
            className="pdf-page placeholder"
            data-page-index={i}
            style={placeholderStyle}
            ref={getRefCb(i)}
          />
        );
      })}
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
  registerEl: (el: HTMLElement | null) => void;
  onError: (e: Error) => void;
  dim: PageDim;
}

function PageView({ doc, pageIndex, scale, globalSpanOffset, registerEl, onError, dim }: PageViewProps) {
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
      await handle.promise;
      if (cancelled) return;

      const spans = textLayer.querySelectorAll<HTMLSpanElement>("span");
      spans.forEach((span, i) => {
        span.dataset.globalSpanIndex = String(globalSpanOffset + i);
      });
    })().catch((e) => {
      if (cancelled || isRenderCancelled(e)) return;
      onError(e instanceof Error ? e : new Error(String(e)));
    });
    return () => {
      cancelled = true;
      handle?.cancel();
    };
  }, [doc, pageIndex, scale, globalSpanOffset, onError]);

  return (
    <div
      ref={registerEl}
      className="pdf-page"
      data-page-index={pageIndex}
      style={{ minWidth: dim.w, minHeight: dim.h }}
    >
      <canvas ref={canvasRef} />
      <div className="text-layer" ref={textLayerRef} />
    </div>
  );
}
