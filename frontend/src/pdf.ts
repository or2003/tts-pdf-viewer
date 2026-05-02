import * as pdfjsLib from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export type PdfDoc = PDFDocumentProxy;
export type PdfPage = PDFPageProxy;

export async function loadPdf(data: ArrayBuffer): Promise<PdfDoc> {
  const task = pdfjsLib.getDocument({ data });
  return await task.promise;
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
  const dpr = window.devicePixelRatio || 1;

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
