import { useEffect, useRef, useState } from "react";
import type { Sentence } from "../types";

interface Props {
  sentences: Sentence[];
  currentIndex: number;
  onSeek: (index: number) => void;
}

export default function SentenceScrubber({ sentences, currentIndex, onSeek }: Props) {
  const [dragValue, setDragValue] = useState<number | null>(null);
  const [tooltipX, setTooltipX] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset drag state if external index moves while we're not dragging.
  useEffect(() => {
    if (dragValue === null) return;
    // no-op
  }, [currentIndex, dragValue]);

  if (sentences.length === 0) {
    return <div className="scrubber empty">No sentences</div>;
  }

  const max = sentences.length - 1;
  const value = dragValue ?? Math.max(0, currentIndex);
  const target = sentences[value];
  const targetPage = target?.spans[0]?.pageIndex ?? 0;
  const snippet = (target?.text ?? "").slice(0, 60);

  function updateTooltipPos(v: number) {
    const el = inputRef.current;
    if (!el) return;
    const ratio = max > 0 ? v / max : 0;
    const rect = el.getBoundingClientRect();
    setTooltipX(rect.left + ratio * rect.width);
  }

  return (
    <div className="scrubber">
      <input
        ref={inputRef}
        type="range"
        min={0}
        max={max}
        step={1}
        value={value}
        onInput={(e) => {
          const v = Number((e.target as HTMLInputElement).value);
          setDragValue(v);
          updateTooltipPos(v);
        }}
        onChange={(e) => {
          const v = Number(e.target.value);
          setDragValue(null);
          setTooltipX(null);
          onSeek(v);
        }}
        onMouseDown={() => updateTooltipPos(value)}
        onTouchStart={() => updateTooltipPos(value)}
        onBlur={() => { setDragValue(null); setTooltipX(null); }}
        aria-label="Jump to sentence"
      />
      <div className="scrubber-meta">
        Sentence {value + 1} / {sentences.length} · Page {targetPage + 1}
      </div>
      {dragValue !== null && tooltipX !== null && snippet && (
        <div
          className="scrubber-tooltip"
          style={{ left: `${tooltipX}px` }}
        >
          <strong>p.{targetPage + 1} · #{value + 1}</strong>
          <div className="snippet">{snippet}{(target?.text.length ?? 0) > 60 ? "…" : ""}</div>
        </div>
      )}
    </div>
  );
}
