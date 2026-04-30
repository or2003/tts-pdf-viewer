import type { ChangeEvent } from "react";

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
  backendStatus: string;
  sentenceCount: number;
  currentIndex: number;
}

export default function Controls(p: Props) {
  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    p.onFileChange(f);
  }

  const playable = p.sentenceCount > 0;

  return (
    <div className="controls">
      <div className="row">
        <label className="file-input">
          <input type="file" accept="application/pdf" onChange={handleFile} />
          <span>{p.fileName ? `📄 ${p.fileName}` : "Choose PDF…"}</span>
        </label>
        <span className="status">{p.backendStatus}</span>
      </div>

      <div className="row">
        <button onClick={p.onPrev} disabled={!playable} title="Previous sentence">⏮</button>
        {p.isPlaying ? (
          <button onClick={p.onPause} disabled={!playable} className="primary" title="Pause">⏸ Pause</button>
        ) : (
          <button onClick={p.onPlay} disabled={!playable} className="primary" title="Play">▶ Play</button>
        )}
        <button onClick={p.onStop} disabled={!playable} title="Stop">⏹</button>
        <button onClick={p.onNext} disabled={!playable} title="Next sentence">⏭</button>

        <div className="meter">
          {playable ? `Sentence ${Math.max(0, p.currentIndex) + 1} / ${p.sentenceCount}` : "—"}
        </div>
      </div>

      <div className="row">
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
        <label className="slider">
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
