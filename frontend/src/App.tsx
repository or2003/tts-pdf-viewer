import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Controls from "./components/Controls";
import PdfViewer from "./components/PdfViewer";
import { PlaybackEngine } from "./playback";
import { checkBackendHealth } from "./tts";
import type { Sentence } from "./types";

export default function App() {
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1.0);
  const [scale, setScale] = useState(1.4);
  const [backendStatus, setBackendStatus] = useState("checking backend…");

  const engineRef = useRef<PlaybackEngine | null>(null);

  useEffect(() => {
    const engine = new PlaybackEngine({
      onSentenceStart: (i) => {
        setCurrentIndex(i);
        setIsPlaying(true);
      },
      onSentenceEnd: () => {},
      onStop: () => {
        setIsPlaying(false);
      },
      onError: (err) => {
        setIsPlaying(false);
        setBackendStatus(`error: ${err.message}`);
      },
    });
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    checkBackendHealth().then((r) => {
      if (cancelled) return;
      setBackendStatus(r.ok ? "backend ready" : `backend offline: ${r.detail}`);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setSpeed(speed);
  }, [speed]);

  useEffect(() => {
    engineRef.current?.setSentences(sentences);
    setCurrentIndex(-1);
  }, [sentences]);

  const handleFile = useCallback(async (file: File | null) => {
    if (!file) {
      setFileBuffer(null);
      setFileName(null);
      setSentences([]);
      return;
    }
    setFileName(file.name);
    const buf = await file.arrayBuffer();
    setFileBuffer(buf);
  }, []);

  const onSentencesReady = useCallback((s: Sentence[]) => {
    setSentences(s);
  }, []);

  const onSpanClick = useCallback((sentenceId: number) => {
    void engineRef.current?.play(sentenceId);
  }, []);

  const highlighted = useMemo<Sentence | null>(() => {
    if (currentIndex < 0 || currentIndex >= sentences.length) return null;
    return sentences[currentIndex];
  }, [currentIndex, sentences]);

  return (
    <div className="app">
      <header>
        <h1>PDF Reader</h1>
        <div className="subtitle">Local TTS · English (Kokoro/MLX) + Hebrew (Israwave)</div>
      </header>

      <Controls
        fileName={fileName}
        onFileChange={handleFile}
        isPlaying={isPlaying}
        onPlay={() => void engineRef.current?.play()}
        onPause={() => engineRef.current?.pause()}
        onStop={() => engineRef.current?.stop()}
        onPrev={() => engineRef.current?.prev()}
        onNext={() => engineRef.current?.next()}
        speed={speed}
        onSpeedChange={setSpeed}
        scale={scale}
        onScaleChange={setScale}
        backendStatus={backendStatus}
        sentenceCount={sentences.length}
        currentIndex={currentIndex}
      />

      <PdfViewer
        fileBuffer={fileBuffer}
        scale={scale}
        sentences={sentences}
        highlightedSentence={highlighted}
        onSentencesReady={onSentencesReady}
        onSpanClick={onSpanClick}
      />
    </div>
  );
}
