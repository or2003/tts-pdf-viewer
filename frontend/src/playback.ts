import type { Sentence } from "./types";
import { fetchSentenceAudio } from "./tts";

interface CacheEntry {
  url: string;
  promise: Promise<string>;
}

const PREFETCH_AHEAD = 2;

export interface PlaybackEvents {
  onSentenceStart: (index: number) => void;
  onSentenceEnd: (index: number) => void;
  onStop: () => void;
  onError: (err: Error) => void;
}

export class PlaybackEngine {
  private audio: HTMLAudioElement;
  private sentences: Sentence[] = [];
  private cache = new Map<number, CacheEntry>();
  private aborts = new Map<number, AbortController>();
  private currentIndex = -1;
  private playing = false;
  private speed = 1;
  private events: PlaybackEvents;

  constructor(events: PlaybackEvents) {
    this.events = events;
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
    if (fromIndex !== undefined) {
      this.currentIndex = fromIndex;
    } else if (this.currentIndex < 0) {
      this.currentIndex = 0;
    } else if (this.audio.paused && !this.audio.ended && this.audio.src) {
      this.audio.playbackRate = this.speed;
      this.playing = true;
      await this.audio.play();
      return;
    }
    this.playing = true;
    await this.playCurrent();
  }

  pause(): void {
    if (!this.audio.paused) this.audio.pause();
    this.playing = false;
  }

  stop(): void {
    this.playing = false;
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
    const hit = this.cache.get(idx);
    if (hit) return hit.promise;
    const ac = new AbortController();
    this.aborts.set(idx, ac);
    const sentence = this.sentences[idx];
    const promise = fetchSentenceAudio(sentence.text, sentence.lang, ac.signal).then((blob) => {
      const url = URL.createObjectURL(blob);
      const entry = this.cache.get(idx);
      if (entry) entry.url = url;
      else this.cache.set(idx, { url, promise });
      return url;
    });
    this.cache.set(idx, { url: "", promise });
    return promise;
  }

  private clearCache(): void {
    for (const entry of this.cache.values()) {
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    this.cache.clear();
  }

  private handleEnded = (): void => {
    const idx = this.currentIndex;
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
