import type { ChangeEvent } from "react";
import type { Sentence } from "../types";
import SentenceScrubber from "./SentenceScrubber";

interface Props {
  fileName: string | null;
  onFileChange: (file: File | null) => void;
  isPlaying: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onPrev: () => void;
  onNext: () => void;
  speed: number;
  onSpeedChange: (s: number) => void;
  scale: number;
  onScaleChange: (s: number) => void;
  status: string;
  sentences: Sentence[];
  currentIndex: number;
  onSeekSentence: (index: number) => void;
  onOpenSettings: () => void;
  onOpenToc: () => void;
}

export default function Controls(p: Props) {
  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    p.onFileChange(f);
  }

  const playable = p.sentences.length > 0;

  return (
    <div className="controls">
      <div className="row top-row">
        <label className="file-input">
          <input type="file" accept="application/pdf" onChange={handleFile} />
          <span>{p.fileName ? `📄 ${p.fileName}` : "Choose PDF…"}</span>
        </label>
        <button className="icon-btn" onClick={p.onOpenToc} disabled={!playable} title="Table of contents" aria-label="Table of contents">📑</button>
        <button className="icon-btn" onClick={p.onOpenSettings} title="Settings" aria-label="Settings">⚙</button>
        <span className="status" title={p.status}>{p.status}</span>
      </div>

      <div className="row transport-row">
        <button className="transport" onClick={p.onPrev} disabled={!playable} title="Previous sentence" aria-label="Previous">⏮</button>
        {p.isPlaying ? (
          <button className="transport primary" onClick={p.onPause} disabled={!playable} title="Pause" aria-label="Pause">⏸</button>
        ) : (
          <button className="transport primary" onClick={p.onPlay} disabled={!playable} title="Play" aria-label="Play">▶</button>
        )}
        <button className="transport" onClick={p.onStop} disabled={!playable} title="Stop" aria-label="Stop">⏹</button>
        <button className="transport" onClick={p.onNext} disabled={!playable} title="Next sentence" aria-label="Next">⏭</button>
        <div className="scrubber-wrap">
          <SentenceScrubber
            sentences={p.sentences}
            currentIndex={p.currentIndex}
            onSeek={p.onSeekSentence}
          />
        </div>
      </div>

      <div className="row sliders-row">
        <label className="slider">
          <span>Speed: {p.speed.toFixed(2)}×</span>
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.05}
            value={p.speed}
            onChange={(e) => p.onSpeedChange(Number(e.target.value))}
          />
        </label>
        <label className="slider zoom-slider">
          <span>Zoom: {(p.scale * 100).toFixed(0)}%</span>
          <input
            type="range"
            min={0.6}
            max={2.5}
            step={0.1}
            value={p.scale}
            onChange={(e) => p.onScaleChange(Number(e.target.value))}
          />
        </label>
      </div>
    </div>
  );
}
