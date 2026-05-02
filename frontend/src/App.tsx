import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Controls from "./components/Controls";
import PdfViewer from "./components/PdfViewer";
import SettingsPanel from "./components/SettingsPanel";
import TocDrawer from "./components/TocDrawer";
import { PlaybackEngine } from "./playback";
import { loadVoices, pickDefaultVoice } from "./voices";
import type { Sentence, Settings, Voice } from "./types";

const SETTINGS_KEY = "tts.settings.v1";

function defaultWorkerUrl(): string {
  const env = (import.meta as unknown as { env?: { VITE_WORKER_URL?: string } }).env;
  return env?.VITE_WORKER_URL ?? "/api";
}

function defaultPrimaryLang(): string {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  return (nav || "en").split("-")[0].toLowerCase();
}

function loadSettings(): Settings {
  const fallback: Settings = {
    primaryLang: defaultPrimaryLang(),
    voicesByLang: {},
    rate: "+0%",
    pitch: "+0Hz",
    workerUrl: defaultWorkerUrl(),
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...fallback, ...parsed, voicesByLang: parsed.voicesByLang ?? {} };
  } catch {
    return fallback;
  }
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore quota
  }
}

export default function App() {
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1.0);
  const [scale, setScale] = useState(1.4);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [status, setStatus] = useState("ready");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);

  const engineRef = useRef<PlaybackEngine | null>(null);

  // Mount engine once.
  useEffect(() => {
    const engine = new PlaybackEngine(
      {
        onSentenceStart: (i) => {
          setCurrentIndex(i);
          setIsPlaying(true);
        },
        onSentenceEnd: () => {},
        onStop: () => setIsPlaying(false),
        onError: (err) => {
          setIsPlaying(false);
          setStatus(`error: ${err.message}`);
        },
      },
      settings,
    );
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist settings + push to engine.
  useEffect(() => {
    saveSettings(settings);
    engineRef.current?.setSettings(settings);
  }, [settings]);

  const loadVoiceList = useCallback(async () => {
    setVoicesError(null);
    try {
      const list = await loadVoices(settings.workerUrl);
      setVoices(list);
      engineRef.current?.setVoices(list);
      // Seed default voices for primary lang if not configured.
      setSettings((prev) => {
        const prefix = prev.primaryLang.toLowerCase().split("-")[0];
        if (prev.voicesByLang[prefix]) return prev;
        const def = pickDefaultVoice(list, prefix);
        if (!def) return prev;
        return { ...prev, voicesByLang: { ...prev.voicesByLang, [prefix]: def.shortName } };
      });
      setStatus(`${list.length} voices ready`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setVoicesError(msg);
      setStatus(`worker offline: ${msg}`);
    }
  }, [settings.workerUrl]);

  useEffect(() => {
    void loadVoiceList();
  }, [loadVoiceList]);

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
    engineRef.current?.seekToSentence(sentenceId);
  }, []);

  const onSeekSentence = useCallback((index: number) => {
    engineRef.current?.seekToSentence(index);
  }, []);

  const onSeekPage = useCallback((pageIndex: number) => {
    engineRef.current?.seekToPage(pageIndex);
  }, []);

  const highlighted = useMemo<Sentence | null>(() => {
    if (currentIndex < 0 || currentIndex >= sentences.length) return null;
    return sentences[currentIndex];
  }, [currentIndex, sentences]);

  return (
    <div className="app">
      <header>
        <h1>PDF Reader</h1>
        <div className="subtitle">Microsoft Edge TTS · all languages · skip by sentence or page</div>
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
        status={status}
        sentences={sentences}
        currentIndex={currentIndex}
        onSeekSentence={onSeekSentence}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenToc={() => setTocOpen(true)}
      />

      <PdfViewer
        fileBuffer={fileBuffer}
        scale={scale}
        primaryLang={settings.primaryLang}
        sentences={sentences}
        highlightedSentence={highlighted}
        onSentencesReady={onSentencesReady}
        onSpanClick={onSpanClick}
      />

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={setSettings}
        voices={voices}
        voicesError={voicesError}
        onReloadVoices={loadVoiceList}
      />

      <TocDrawer
        open={tocOpen}
        onClose={() => setTocOpen(false)}
        sentences={sentences}
        currentIndex={currentIndex}
        onSeekSentence={onSeekSentence}
        onSeekPage={onSeekPage}
      />
    </div>
  );
}
