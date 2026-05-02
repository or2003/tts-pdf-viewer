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

// Header/footer detection. We group each page's items into visual "lines" by
// y-coordinate, then grow the topmost N (resp. bottommost N) lines until their
// combined signature stops repeating across pages. The largest N that still
// repeats is the actual header (resp. footer) on every page that matches.
const LINE_GROUP_TOL = 4;     // items within ~4pt of each other share a line
const HEADER_MAX_LINES = 3;   // cap header / footer growth
const REPEAT_THRESHOLD = 0.7;

function normalizeBandText(s: string): string {
  // Replace digit runs with `#` (rather than dropping) so pure-page-number
  // headers like "1", "2", "3"… still collapse to a common signature.
  return s.trim().toLowerCase().replace(/\d+/g, "#");
}

interface LineGroup {
  yTop: number;
  indices: number[];
  normParts: string[];
}

function groupLines(info: PageSpanInfo): LineGroup[] {
  const sorted: { idx: number; y: number }[] = [];
  for (let j = 0; j < info.texts.length; j++) {
    const y = info.yCoords[j];
    if (y == null) continue;
    sorted.push({ idx: j, y });
  }
  sorted.sort((a, b) => b.y - a.y);

  const lines: LineGroup[] = [];
  let cur: LineGroup | null = null;
  for (const it of sorted) {
    if (cur == null || cur.yTop - it.y > LINE_GROUP_TOL) {
      cur = { yTop: it.y, indices: [], normParts: [] };
      lines.push(cur);
    }
    cur.indices.push(it.idx);
    const n = normalizeBandText(info.texts[it.idx]);
    if (n) cur.normParts.push(n);
  }
  // Drop "noise" lines that contain only whitespace/empty items — they'd
  // otherwise shadow real headers/footers (e.g., a stray empty span at the
  // very bottom of a page hiding the page-number line above it).
  return lines.filter((l) => l.normParts.length > 0);
}

function dominantCount(sigs: string[]): { sig: string; count: number } {
  const counts = new Map<string, number>();
  for (const s of sigs) {
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let bestSig = "";
  let bestC = 0;
  for (const [s, c] of counts) {
    if (c > bestC) {
      bestC = c;
      bestSig = s;
    }
  }
  return { sig: bestSig, count: bestC };
}

function computeSkipSets(
  numPages: number,
  pageInfos: Map<number, PageSpanInfo>,
  enabled: boolean,
): Set<number>[] {
  const skip: Set<number>[] = Array.from({ length: numPages }, () => new Set<number>());
  if (!enabled || numPages === 0) return skip;

  const linesByPage: LineGroup[][] = new Array(numPages);
  for (let i = 0; i < numPages; i++) {
    const info = pageInfos.get(i);
    linesByPage[i] = info ? groupLines(info) : [];
  }
  const need = Math.max(2, Math.ceil(numPages * REPEAT_THRESHOLD));

  // Greedy growth from one end: try N=1, 2, … and keep the largest N whose
  // dominant signature still repeats on >=70% of pages.
  type FromEnd = "top" | "bottom";
  function detect(end: FromEnd): { n: number; sig: string } {
    let bestN = 0;
    let bestSig = "";
    for (let n = 1; n <= HEADER_MAX_LINES; n++) {
      const sigs = linesByPage.map((lines) => {
        if (lines.length < n) return "";
        const slice = end === "top" ? lines.slice(0, n) : lines.slice(-n);
        return slice.map((l) => l.normParts.join(" ")).join("|");
      });
      const { sig, count } = dominantCount(sigs);
      if (count >= need) {
        bestN = n;
        bestSig = sig;
      } else {
        break;
      }
    }
    return { n: bestN, sig: bestSig };
  }

  const header = detect("top");
  const footer = detect("bottom");

  for (let i = 0; i < numPages; i++) {
    const lines = linesByPage[i];
    if (lines.length === 0) continue;
    const totalNeeded = header.n + footer.n;
    // If skipping both would wipe the page, prefer footer (page-number-style
    // chrome) and keep the header as content. If only one fits, do that one.
    const canHeader = header.n > 0 && lines.length > header.n;
    const canFooter = footer.n > 0 && lines.length > footer.n;
    const canBoth = lines.length > totalNeeded;

    if (canHeader && (canBoth || !canFooter)) {
      const slice = lines.slice(0, header.n);
      const sig = slice.map((l) => l.normParts.join(" ")).join("|");
      if (sig === header.sig) {
        for (const ln of slice) for (const j of ln.indices) skip[i].add(j);
      }
    }
    if (canFooter) {
      const slice = lines.slice(-footer.n);
      const sig = slice.map((l) => l.normParts.join(" ")).join("|");
      if (sig === footer.sig) {
        for (const ln of slice) for (const j of ln.indices) skip[i].add(j);
      }
    }
  }

  // Item-level fallback: when whole-line detection fails (typical for tight
  // Hebrew layouts where nikud/baseline jitter merges page-number items into
  // the same y-cluster as adjacent body items), recurring `#` tokens in the
  // top/bottom line are almost certainly page numbers / year markers. Pure-
  // digit tokens are the only thing this matches, so it never trims real text.
  const skipHashIfRecurring = (end: "top" | "bottom") => {
    let pagesWithHash = 0;
    for (let i = 0; i < numPages; i++) {
      const lines = linesByPage[i];
      if (lines.length === 0) continue;
      const ln = end === "top" ? lines[0] : lines[lines.length - 1];
      if (ln.normParts.includes("#")) pagesWithHash++;
    }
    if (pagesWithHash < need) return;
    for (let i = 0; i < numPages; i++) {
      const lines = linesByPage[i];
      if (lines.length === 0) continue;
      const info = pageInfos.get(i);
      if (!info) continue;
      const ln = end === "top" ? lines[0] : lines[lines.length - 1];
      for (const j of ln.indices) {
        if (normalizeBandText(info.texts[j]) === "#") skip[i].add(j);
      }
    }
  };
  if (header.n === 0) skipHashIfRecurring("top");
  if (footer.n === 0) skipHashIfRecurring("bottom");

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
