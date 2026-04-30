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

export async function renderPage(
  page: PdfPage,
  canvas: HTMLCanvasElement,
  textLayerDiv: HTMLDivElement,
  scale: number,
): Promise<{ width: number; height: number; spanTexts: string[] }> {
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  await page.render({ canvasContext: ctx, viewport }).promise;

  textLayerDiv.replaceChildren();
  textLayerDiv.style.width = `${Math.floor(viewport.width)}px`;
  textLayerDiv.style.height = `${Math.floor(viewport.height)}px`;
  textLayerDiv.style.setProperty("--scale-factor", String(scale));

  const textContent = await page.getTextContent();

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
}
