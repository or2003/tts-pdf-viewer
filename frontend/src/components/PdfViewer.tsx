import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  extractPageSpanInfo,
  isMobileEnv,
  isRenderCancelled,
  loadPdf,
  renderPage,
  type PageSpanInfo,
  type PdfDoc,
  type RenderHandle,
} from "../pdf";
import { buildSentences } from "../sentences";
import type { Sentence } from "../types";

interface Props {
  fileBuffer: ArrayBuffer | null;
  scale: number;
  primaryLang: string;
  skipHeaderFooter: boolean;
  highlightedSentence: Sentence | null;
  onSentencesReady: (sentences: Sentence[]) => void;
  onSpanClick: (sentenceId: number) => void;
  sentences: Sentence[];
}

interface PageDim {
  w: number;
  h: number;
}

const ACTIVE_RADIUS = isMobileEnv() ? 0 : 1;

// Header/footer detection thresholds.
const BAND_FRAC = 0.10;            // top/bottom 10% of page = candidate band
const REPEAT_THRESHOLD = 0.7;      // >=70% of pages must repeat a normalized line
const FALLBACK_BAND_FRAC = 0.05;   // when detection is inconclusive, trim top/bottom 5%

function normalizeBandText(s: string): string {
  return s.trim().toLowerCase().replace(/\d+/g, "");
}

function computeSkipSets(
  numPages: number,
  pageInfos: Map<number, PageSpanInfo>,
  enabled: boolean,
): Set<number>[] {
  const skip: Set<number>[] = Array.from({ length: numPages }, () => new Set<number>());
  if (!enabled || numPages === 0) return skip;

  // Per-page band signatures + the indices each band covers. Signature is the
  // concat of normalized texts in the band — digits stripped — so "...from 2022"
  // and "...from 2023" produce the same signature, and a span that is *only* a
  // year/page-number still gets dropped because the whole band is dropped on
  // pages whose signature repeats across the doc.
  const headerSigs: string[] = new Array(numPages).fill("");
  const footerSigs: string[] = new Array(numPages).fill("");
  const headerIdx: number[][] = Array.from({ length: numPages }, () => []);
  const footerIdx: number[][] = Array.from({ length: numPages }, () => []);

  for (let i = 0; i < numPages; i++) {
    const info = pageInfos.get(i);
    if (!info) continue;
    const headerY = info.pageH * (1 - BAND_FRAC);
    const footerY = info.pageH * BAND_FRAC;
    const hParts: string[] = [];
    const fParts: string[] = [];
    for (let j = 0; j < info.texts.length; j++) {
      const y = info.yCoords[j];
      if (y == null) continue;
      if (y >= headerY) {
        const n = normalizeBandText(info.texts[j]);
        if (n) hParts.push(n);
        headerIdx[i].push(j);
      } else if (y <= footerY) {
        const n = normalizeBandText(info.texts[j]);
        if (n) fParts.push(n);
        footerIdx[i].push(j);
      }
    }
    headerSigs[i] = hParts.join(" ");
    footerSigs[i] = fParts.join(" ");
  }

  const countSigs = (sigs: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const s of sigs) {
      if (!s) continue;
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  };
  const headerCounts = countSigs(headerSigs);
  const footerCounts = countSigs(footerSigs);
  const need = Math.max(2, Math.ceil(numPages * REPEAT_THRESHOLD));
  const headerSigSkip = new Set<string>();
  const footerSigSkip = new Set<string>();
  for (const [s, c] of headerCounts) if (c >= need) headerSigSkip.add(s);
  for (const [s, c] of footerCounts) if (c >= need) footerSigSkip.add(s);

  const fallbackHeader = headerSigSkip.size === 0 && numPages >= 3;
  const fallbackFooter = footerSigSkip.size === 0 && numPages >= 3;

  for (let i = 0; i < numPages; i++) {
    const info = pageInfos.get(i);
    if (!info) continue;
    if (headerSigs[i] && headerSigSkip.has(headerSigs[i])) {
      for (const j of headerIdx[i]) skip[i].add(j);
    } else if (fallbackHeader) {
      const fallbackHeaderY = info.pageH * (1 - FALLBACK_BAND_FRAC);
      for (const j of headerIdx[i]) {
        const y = info.yCoords[j];
        if (y != null && y >= fallbackHeaderY) skip[i].add(j);
      }
    }
    if (footerSigs[i] && footerSigSkip.has(footerSigs[i])) {
      for (const j of footerIdx[i]) skip[i].add(j);
    } else if (fallbackFooter) {
      const fallbackFooterY = info.pageH * FALLBACK_BAND_FRAC;
      for (const j of footerIdx[i]) {
        const y = info.yCoords[j];
        if (y != null && y <= fallbackFooterY) skip[i].add(j);
      }
    }
  }
  return skip;
}

export default function PdfViewer({
  fileBuffer,
  scale,
  primaryLang,
  skipHeaderFooter,
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

  const pageInfoRef = useRef<Map<number, PageSpanInfo>>(new Map());
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
      pageInfoRef.current.clear();
      pinnedPagesRef.current.clear();
      visibleSetRef.current.clear();
      onSentencesReady([]);
      return;
    }
    setError(null);
    let cancelled = false;
    passToken.current += 1;
    pageInfoRef.current.clear();
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
    pageInfoRef.current.clear();

    (async () => {
      for (let i = 0; i < doc.numPages; i++) {
        if (cancelled || passToken.current !== myToken) return;
        const page = await doc.getPage(i + 1);
        if (cancelled || passToken.current !== myToken) return;
        const info = await extractPageSpanInfo(page);
        if (cancelled || passToken.current !== myToken) return;
        pageInfoRef.current.set(i, info);
        // Yield so Mobile Safari can paint frames and not consider us frozen.
        await new Promise((r) => setTimeout(r, 0));
      }
      if (cancelled || passToken.current !== myToken) return;

      const skipByPage = computeSkipSets(doc.numPages, pageInfoRef.current, skipHeaderFooter);
      type SpanInput = { pageIndex: number; spanIndex: number; text: string };
      const all: SpanInput[] = [];
      let g = 0;
      for (let i = 0; i < doc.numPages; i++) {
        const info = pageInfoRef.current.get(i);
        if (!info) continue;
        const skip = skipByPage[i];
        for (let j = 0; j < info.texts.length; j++) {
          if (!skip.has(j)) all.push({ pageIndex: i, spanIndex: g, text: info.texts[j] });
          g++;
        }
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
  }, [doc, primaryLang, skipHeaderFooter, onSentencesReady]);

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

  const spanOffsets = computeSpanOffsets(doc.numPages, pageInfoRef.current);

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

function computeSpanOffsets(numPages: number, infos: Map<number, PageSpanInfo>): number[] {
  const offsets: number[] = new Array(numPages).fill(0);
  let acc = 0;
  for (let i = 0; i < numPages; i++) {
    offsets[i] = acc;
    acc += (infos.get(i)?.texts.length ?? 0);
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

      // Match the upfront pass enumeration in extractPageSpanTexts: every <span>
      // in tree order, including pdfjs marked-content wrapper spans. Self-
      // consistency is what matters, not item-vs-DOM equivalence.
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
