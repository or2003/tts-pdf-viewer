import * as pdfjsLib from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export type PdfDoc = PDFDocumentProxy;
export type PdfPage = PDFPageProxy;

export function isMobileEnv(): boolean {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return coarse || /iPhone|iPad|iPod|Android/i.test(ua);
}

export async function loadPdf(data: ArrayBuffer): Promise<PdfDoc> {
  const task = pdfjsLib.getDocument({ data });
  return await task.promise;
}

export interface PageSpanInfo {
  texts: string[];
  yCoords: (number | null)[];
  pageH: number;
}

// Extract per-span text + y-coordinates for a page WITHOUT painting a canvas.
// Renders pdfjs TextLayer into a detached <div> and reads back DOM spans the
// same way renderPage() does on the visible textLayer, so sentence-list
// indices and the visible page's `data-global-span-index` stamps stay in
// lockstep — including pdfjs marked-content wrapper spans.
export async function extractPageSpanInfo(page: PdfPage): Promise<PageSpanInfo> {
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();
  const div = document.createElement("div");
  div.style.setProperty("--scale-factor", "1");
  const TextLayerCtor = (pdfjsLib as unknown as {
    TextLayer?: new (opts: unknown) => { render: () => Promise<void> };
  }).TextLayer;
  if (!TextLayerCtor) {
    throw new Error("pdfjs TextLayer not available; please use pdfjs-dist >= 4.x");
  }
  const layer = new TextLayerCtor({ textContentSource: textContent, container: div, viewport });
  await layer.render();
  const texts: string[] = [];
  div.querySelectorAll<HTMLSpanElement>("span").forEach((s) => texts.push(s.textContent ?? ""));

  // Walk items in tree order, mirroring pdfjs TextLayer's span emission:
  // marked-content begin → wrapper span (no y); end → no span; TextItem → leaf span (y from transform[5]).
  const yCoords: (number | null)[] = [];
  for (const item of textContent.items) {
    if (!item || typeof item !== "object") continue;
    if ("str" in item) {
      const tr = (item as { transform?: number[] }).transform;
      yCoords.push(tr ? tr[5] : null);
    } else if ("type" in item) {
      const t = (item as { type?: string }).type;
      if (t === "beginMarkedContent" || t === "beginMarkedContentProps") {
        yCoords.push(null);
      }
      // endMarkedContent: no DOM span emitted
    }
  }
  // Defensive: if our walk diverges from the actual DOM count, pad/truncate
  // so callers can index safely.
  while (yCoords.length < texts.length) yCoords.push(null);
  if (yCoords.length > texts.length) yCoords.length = texts.length;

  // Free pdfjs's per-page caches now that we're done with this page.
  try {
    page.cleanup();
  } catch {
    // best-effort
  }

  return { texts, yCoords, pageH: viewport.height };
}

export interface RenderHandle {
  promise: Promise<{ width: number; height: number; spanTexts: string[] }>;
  cancel: () => void;
}

export function renderPage(
  page: PdfPage,
  canvas: HTMLCanvasElement,
  textLayerDiv: HTMLDivElement,
  scale: number,
): RenderHandle {
  const viewport = page.getViewport({ scale });
  // Cap canvas pixel area so high-DPR mobile devices don't blow past
  // per-canvas memory limits (iOS Safari ~16M px, much less in aggregate).
  const MAX_AREA = isMobileEnv() ? 3_000_000 : 8_000_000;
  const rawDpr = window.devicePixelRatio || 1;
  const maxDprByArea = Math.sqrt(MAX_AREA / (viewport.width * viewport.height));
  const dpr = Math.max(1, Math.min(rawDpr, maxDprByArea));

  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const renderTask = page.render({ canvasContext: ctx, viewport });
  let cancelled = false;

  const promise = (async () => {
    await renderTask.promise;
    if (cancelled) throw new RenderCancelled();

    textLayerDiv.replaceChildren();
    textLayerDiv.style.width = `${Math.floor(viewport.width)}px`;
    textLayerDiv.style.height = `${Math.floor(viewport.height)}px`;
    textLayerDiv.style.setProperty("--scale-factor", String(scale));

    const textContent = await page.getTextContent();
    if (cancelled) throw new RenderCancelled();

    const TextLayerCtor = (pdfjsLib as unknown as { TextLayer?: new (opts: unknown) => { render: () => Promise<void> } })
      .TextLayer;
    if (!TextLayerCtor) {
      throw new Error("pdfjs TextLayer not available; please use pdfjs-dist >= 4.x");
    }
    const textLayer = new TextLayerCtor({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
    });
    await textLayer.render();
    if (cancelled) throw new RenderCancelled();

    const spans = Array.from(textLayerDiv.querySelectorAll<HTMLSpanElement>("span"));
    const spanTexts: string[] = [];
    spans.forEach((span, i) => {
      span.dataset.spanIndex = String(i);
      spanTexts.push(span.textContent ?? "");
    });

    return {
      width: Math.floor(viewport.width),
      height: Math.floor(viewport.height),
      spanTexts,
    };
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      try {
        renderTask.cancel();
      } catch {
        // already settled
      }
    },
  };
}

export class RenderCancelled extends Error {
  constructor() {
    super("render cancelled");
    this.name = "RenderCancelled";
  }
}

export function isRenderCancelled(e: unknown): boolean {
  if (e instanceof RenderCancelled) return true;
  if (e && typeof e === "object" && "name" in e) {
    const name = (e as { name?: string }).name;
    return name === "RenderingCancelledException" || name === "RenderCancelled";
  }
  return false;
}
