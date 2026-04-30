export type Lang = "en" | "he";

export interface SpanRef {
  pageIndex: number;
  spanIndex: number;
  charStart: number;
  charEnd: number;
}

export interface Sentence {
  id: number;
  text: string;
  lang: Lang;
  spans: SpanRef[];
}

export interface PageRender {
  pageIndex: number;
  width: number;
  height: number;
  spanTexts: string[];
}
