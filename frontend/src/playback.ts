import type { Sentence, Settings, Voice } from "./types";
import { fetchSentenceAudio } from "./tts";
import { resolveVoiceForLang } from "./voices";

interface CacheEntry {
  url: string;
  promise: Promise<string>;
  size: number;
  voice: string;
}

const PREFETCH_AHEAD = 2;
const MIN_AUDIO_BYTES = 500;
const MIN_PLAYED_MS = 100;
const MAX_CONSECUTIVE_SHORT = 2;

export interface PlaybackEvents {
  onSentenceStart: (index: number) => void;
  onSentenceEnd: (index: number) => void;
  onStop: () => void;
  onError: (err: Error) => void;
}

export class PlaybackEngine {
  private audio: HTMLAudioElement;
  private sentences: Sentence[] = [];
  private voices: Voice[] = [];
  private settings: Settings;
  private cache = new Map<number, CacheEntry>();
  private aborts = new Map<number, AbortController>();
  private currentIndex = -1;
  private playing = false;
  private speed = 1;
  private events: PlaybackEvents;
  private consecutiveShort = 0;

  constructor(events: PlaybackEvents, settings: Settings) {
    this.events = events;
    this.settings = settings;
    this.audio = new Audio();
    this.audio.preservesPitch = true;
    this.audio.addEventListener("ended", this.handleEnded);
    this.audio.addEventListener("error", this.handleAudioError);
  }

  setSentences(sentences: Sentence[]): void {
    this.stop();
    this.sentences = sentences;
    this.clearCache();
  }

  setVoices(voices: Voice[]): void {
    this.voices = voices;
  }

  /**
   * Replace settings. If the voice mapping or worker URL changed, drop the
   * audio cache so subsequent fetches use the new voice.
   */
  setSettings(next: Settings): void {
    const voiceChanged =
      this.settings.workerUrl !== next.workerUrl ||
      this.settings.rate !== next.rate ||
      this.settings.pitch !== next.pitch ||
      JSON.stringify(this.settings.voicesByLang) !== JSON.stringify(next.voicesByLang) ||
      this.settings.primaryLang !== next.primaryLang;
    this.settings = next;
    if (voiceChanged) this.clearCache();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.audio.playbackRate = speed;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  current(): number {
    return this.currentIndex;
  }

  async play(fromIndex?: number): Promise<void> {
    if (this.sentences.length === 0) return;
    if (fromIndex !== undefined && fromIndex !== this.currentIndex) {
      // Hard seek — reset audio element so next playCurrent loads fresh blob.
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.currentIndex = fromIndex;
    } else if (this.currentIndex < 0) {
      this.currentIndex = 0;
    } else if (this.audio.paused && !this.audio.ended && this.audio.src) {
      this.audio.playbackRate = this.speed;
      this.playing = true;
      this.events.onSentenceStart(this.currentIndex);
      await this.audio.play();
      return;
    }
    this.playing = true;
    await this.playCurrent();
  }

  /** Jump to a specific sentence index and start playback. */
  seekToSentence(index: number): void {
    if (index < 0 || index >= this.sentences.length) return;
    void this.play(index);
  }

  /** Jump to the first sentence whose first span is on the given page. */
  seekToPage(pageIndex: number): void {
    const idx = this.sentences.findIndex((s) => s.spans[0]?.pageIndex === pageIndex);
    if (idx >= 0) this.seekToSentence(idx);
  }

  pause(): void {
    if (!this.audio.paused) this.audio.pause();
    this.playing = false;
    this.events.onStop();
  }

  stop(): void {
    this.playing = false;
    this.consecutiveShort = 0;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.currentIndex = -1;
    for (const a of this.aborts.values()) a.abort();
    this.aborts.clear();
    this.events.onStop();
  }

  next(): void {
    if (this.currentIndex < this.sentences.length - 1) {
      void this.play(this.currentIndex + 1);
    }
  }

  prev(): void {
    if (this.currentIndex > 0) {
      void this.play(this.currentIndex - 1);
    }
  }

  dispose(): void {
    this.stop();
    this.audio.removeEventListener("ended", this.handleEnded);
    this.audio.removeEventListener("error", this.handleAudioError);
    this.clearCache();
  }

  private resolveVoice(idx: number): Voice | null {
    const sentence = this.sentences[idx];
    if (!sentence) return null;
    return resolveVoiceForLang(this.voices, this.settings.voicesByLang, sentence.lang);
  }

  private async playCurrent(): Promise<void> {
    const idx = this.currentIndex;
    if (idx < 0 || idx >= this.sentences.length) {
      this.playing = false;
      this.events.onStop();
      return;
    }

    this.events.onSentenceStart(idx);
    this.prefetchAhead(idx);

    try {
      const url = await this.ensureAudio(idx);
      if (!this.playing || this.currentIndex !== idx) return;
      const entry = this.cache.get(idx);
      if (entry && entry.size > 0 && entry.size < MIN_AUDIO_BYTES) {
        this.playing = false;
        this.events.onError(new Error(`empty audio for sentence ${idx} (${entry.size} bytes)`));
        return;
      }
      this.audio.src = url;
      this.audio.playbackRate = this.speed;
      await this.audio.play();
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      this.playing = false;
      this.events.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private prefetchAhead(idx: number): void {
    for (let k = 1; k <= PREFETCH_AHEAD; k++) {
      const j = idx + k;
      if (j >= this.sentences.length) break;
      void this.ensureAudio(j).catch(() => {});
    }
  }

  private ensureAudio(idx: number): Promise<string> {
    const sentence = this.sentences[idx];
    if (!sentence) return Promise.reject(new Error("Out of range"));
    const voice = this.resolveVoice(idx);
    if (!voice) {
      return Promise.reject(new Error(`No voice available for lang "${sentence.lang}"`));
    }

    const hit = this.cache.get(idx);
    if (hit && hit.voice === voice.shortName) return hit.promise;
    if (hit && hit.url) URL.revokeObjectURL(hit.url);

    const ac = new AbortController();
    this.aborts.set(idx, ac);
    const promise = fetchSentenceAudio(
      this.settings.workerUrl,
      {
        text: sentence.text,
        voice: voice.shortName,
        provider: voice.provider,
        rate: this.settings.rate,
        pitch: this.settings.pitch,
      },
      ac.signal,
    ).then((blob) => {
      const url = URL.createObjectURL(blob);
      const entry = this.cache.get(idx);
      if (entry) {
        entry.url = url;
        entry.size = blob.size;
        entry.voice = voice.shortName;
      } else {
        this.cache.set(idx, { url, promise, size: blob.size, voice: voice.shortName });
      }
      return url;
    });
    this.cache.set(idx, { url: "", promise, size: 0, voice: voice.shortName });
    return promise;
  }

  private clearCache(): void {
    for (const entry of this.cache.values()) {
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    this.cache.clear();
    for (const a of this.aborts.values()) a.abort();
    this.aborts.clear();
  }

  private handleEnded = (): void => {
    const idx = this.currentIndex;
    const playedMs = (this.audio.currentTime || 0) * 1000;
    if (playedMs < MIN_PLAYED_MS) {
      this.consecutiveShort += 1;
      if (this.consecutiveShort >= MAX_CONSECUTIVE_SHORT) {
        this.playing = false;
        this.consecutiveShort = 0;
        this.events.onError(new Error("playback halted: empty audio (check Worker log)"));
        return;
      }
    } else {
      this.consecutiveShort = 0;
    }
    this.events.onSentenceEnd(idx);
    if (!this.playing) return;
    if (idx + 1 >= this.sentences.length) {
      this.playing = false;
      this.events.onStop();
      return;
    }
    this.currentIndex = idx + 1;
    void this.playCurrent();
  };

  private handleAudioError = (): void => {
    const err = this.audio.error;
    if (err) {
      this.events.onError(new Error(`audio error code=${err.code}`));
      this.playing = false;
    }
  };
}
