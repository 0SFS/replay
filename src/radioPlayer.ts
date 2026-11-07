import type { ReplayClock } from "./replayClock.ts";
import type { TimelineAudio, TimelineAudioFile, TimelineTranscriptLine } from "./timeline.ts";

/** The part of an HTMLAudioElement the player drives, so that tests can stand in for it. */
export interface AudioOutput {
  src: string;
  preload: string;
  currentTime: number;
  playbackRate: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly duration: number;
  play(): Promise<void>;
  pause(): void;
  canPlayType(type: string): string;
  addEventListener(type: "error" | "loadedmetadata", listener: () => void): void;
  removeEventListener(type: "error" | "loadedmetadata", listener: () => void): void;
}

/** A sound the player can play along with the replay: the timeline's, or a file from this device. */
export interface RadioTrack {
  id: string;
  label: string;
  files: TimelineAudioFile[];
  /** Seconds after the timeline's start at which the sound's first second plays, as aligned. */
  t: number;
  /** Seconds the listener has moved it by: more plays it later. */
  offsetS: number;
  /** Seconds; null until a file from this device has loaded. */
  duration: number | null;
  transcript: TimelineTranscriptLine[];
  /** The timeline's entry, with how it was aligned and where it came from. Absent for a file from this device. */
  audio?: TimelineAudio;
}

export type RadioStatus =
  /** Sound is off. */
  | "off"
  /** There is nothing to play. */
  | "none"
  /** The replay is before or after the sound. */
  | "outside"
  | "paused"
  /** The replay's speed is outside SOUND_RATES. */
  | "speed"
  | "loading"
  | "playing"
  /** The browser would not start the sound without a tap or a click. */
  | "blocked"
  /** No file this browser can play. */
  | "unsupported"
  | "error";

export interface RadioState {
  tracks: RadioTrack[];
  selected: string | null;
  enabled: boolean;
  status: RadioStatus;
}

/** The speeds sound plays at; faster or slower, the replay is silent. */
export const SOUND_RATES = { min: 0.25, max: 2 } as const;
/** How far the sound may drift from the replay's clock before it is moved back. */
export const MAX_DRIFT_S = 0.3;

/** Seconds into the sound at the replay's time `t`, or null before or after it. */
export function soundTimeAt(track: RadioTrack, t: number): number | null {
  const at = t - track.t - track.offsetS;
  return at >= 0 && at < (track.duration ?? Infinity) ? at : null;
}

/** Seconds after the timeline's start at which `at` seconds into the sound play. */
export function timelineTimeOf(track: RadioTrack, at: number): number {
  return track.t + track.offsetS + at;
}

/** Seconds a transcript line stays up after its words end, so that a short one can be read. */
const LINE_HOLD_S = 1;

/** The transcript line being said `at` seconds into the sound, held a moment after it ends. */
export function transcriptLineAt(track: RadioTrack, at: number | null): TimelineTranscriptLine | null {
  if (at === null) return null;
  let found: TimelineTranscriptLine | null = null;
  for (const line of track.transcript) {
    if (line.at > at) break;
    if (at <= line.end + LINE_HOLD_S) found = line;
  }
  return found;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The start of a LiveATC archive from its name, such as
 * KZMA-Sec-Nov-01-2026-1730Z.mp3, in milliseconds since 1970, or null for
 * another name. LiveATC names each half-hour file by the time it starts.
 */
export function liveAtcStartMs(fileName: string): number | null {
  const match = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(\d{2})-(\d{4})-(\d{2})(\d{2})z/i.exec(fileName);
  if (!match) return null;
  const [, month, day, year, hour, minute] = match;
  return Date.UTC(Number(year), MONTHS.indexOf(month!.toLowerCase()), Number(day), Number(hour), Number(minute));
}

export function trackFromAudio(audio: TimelineAudio): RadioTrack {
  return {
    id: audio.id, label: audio.label, files: audio.files, t: audio.t, offsetS: 0,
    duration: audio.duration, transcript: audio.transcript ?? [], audio,
  };
}

export interface RadioPlayerOptions {
  clock: ReplayClock;
  audio: readonly TimelineAudio[];
  /** Makes the element that plays the sound, the first time there is something to play. Without it the player is silent. */
  createOutput?: () => AudioOutput;
  /** Lets go of a file from this device: URL.revokeObjectURL. */
  revokeUrl?: (url: string) => void;
  /** Whether sound is on at first. */
  enabled?: boolean;
}

export interface RadioPlayer {
  getState(): RadioState;
  subscribe(listener: () => void): () => void;
  /** Called from a tap or a click, so that a browser that blocked the sound lets it start. */
  setEnabled(enabled: boolean): void;
  select(id: string): void;
  /** Moves a sound against the replay: more seconds play it later. */
  setOffset(id: string, offsetS: number): void;
  /** Adds a file from this device, playing from `t` seconds after the timeline's start, and selects it. */
  addLocal(file: { name: string; type: string; url: string }, t: number): void;
  /** Where a file from this device starts, in seconds after the timeline's start. */
  setStart(id: string, t: number): void;
  destroy(): void;
}

/**
 * Plays a recording along with the replay. The replay's clock leads: the
 * sound starts, stops, seeks and changes speed with it, and is moved back
 * when it drifts more than MAX_DRIFT_S from it.
 */
export function createRadioPlayer(options: RadioPlayerOptions): RadioPlayer {
  const { clock } = options;
  const listeners = new Set<() => void>();
  let state: RadioState = {
    tracks: options.audio.map(trackFromAudio),
    selected: options.audio[0]?.id ?? null,
    enabled: options.enabled ?? true,
    status: "none",
  };
  let output: AudioOutput | null = null;
  let loadedUrl: string | null = null;
  let starting = false;
  // A refusal to play, or a file that failed, waits for the listener before it is tried again.
  let held: "blocked" | "error" | null = null;
  let wasPlaying = clock.get().playing;
  let localCount = 0;

  const set = (next: Partial<RadioState>) => {
    const changed = Object.entries(next).some(([key, value]) => state[key as keyof RadioState] !== value);
    if (!changed) return;
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  };
  const selected = () => state.tracks.find(track => track.id === state.selected) ?? null;
  const stop = () => {
    if (output && !output.paused) output.pause();
  };
  const onError = () => {
    held = "error";
    sync();
  };
  const onMetadata = () => {
    const track = selected();
    if (!output || !track || track.duration !== null || !Number.isFinite(output.duration)) return;
    replaceTrack({ ...track, duration: output.duration });
  };
  const replaceTrack = (next: RadioTrack) => {
    set({ tracks: state.tracks.map(track => track.id === next.id ? next : track) });
    sync();
  };
  /** The element, with the selected sound's first playable file loaded, or why there is none. */
  const prepare = (track: RadioTrack): AudioOutput | "unsupported" | null => {
    if (!options.createOutput) return null;
    if (!output) {
      output = options.createOutput();
      output.preload = "auto";
      output.addEventListener("error", onError);
      output.addEventListener("loadedmetadata", onMetadata);
    }
    const file = track.files.find(candidate => output!.canPlayType(candidate.type) !== "");
    if (!file) return "unsupported";
    if (loadedUrl !== file.url) {
      stop();
      output.src = file.url;
      loadedUrl = file.url;
    }
    return output;
  };

  const sync = () => {
    const { t, playing, rate } = clock.get();
    // Pressing play is a click the browser counts, so try again what it refused.
    if (playing && !wasPlaying && held === "blocked") held = null;
    wasPlaying = playing;
    const track = selected();
    if (!track) { stop(); set({ status: "none" }); return; }
    if (!state.enabled) { stop(); set({ status: "off" }); return; }
    if (held) { stop(); set({ status: held }); return; }
    const at = soundTimeAt(track, t);
    // Load what is about to play, so that it starts on time.
    const nearlyAt = at ?? soundTimeAt(track, t + 10 * Math.max(rate, 1));
    if (nearlyAt === null) { stop(); set({ status: "outside" }); return; }
    const out = prepare(track);
    if (out === "unsupported") { stop(); set({ status: "unsupported" }); return; }
    if (at === null) { stop(); set({ status: "outside" }); return; }
    if (!playing) {
      stop();
      if (out && Math.abs(out.currentTime - at) > 0.05) out.currentTime = at;
      set({ status: "paused" });
      return;
    }
    if (rate < SOUND_RATES.min || rate > SOUND_RATES.max) { stop(); set({ status: "speed" }); return; }
    if (!out) { set({ status: "playing" }); return; }
    if (out.playbackRate !== rate) out.playbackRate = rate;
    if (out.paused) {
      if (starting) return;
      starting = true;
      out.currentTime = at;
      set({ status: "loading" });
      out.play().then(() => {
        starting = false;
        sync();
      }, (error: unknown) => {
        starting = false;
        held = error instanceof Error && error.name === "NotAllowedError" ? "blocked" : "error";
        sync();
      });
      return;
    }
    if (!out.seeking && Math.abs(out.currentTime - at) > MAX_DRIFT_S) out.currentTime = at;
    set({ status: "playing" });
  };
  const stopClock = clock.subscribe(sync);
  sync();

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setEnabled(enabled) {
      held = null;
      set({ enabled });
      sync();
    },
    select(id) {
      if (!state.tracks.some(track => track.id === id)) return;
      held = null;
      set({ selected: id });
      sync();
    },
    setOffset(id, offsetS) {
      const track = state.tracks.find(candidate => candidate.id === id);
      if (track && Number.isFinite(offsetS)) replaceTrack({ ...track, offsetS });
    },
    addLocal(file, t) {
      localCount += 1;
      const id = `local-${localCount}`;
      const track: RadioTrack = { id, label: file.name, files: [{ url: file.url, type: file.type || "audio/mpeg" }], t, offsetS: 0, duration: null, transcript: [] };
      held = null;
      set({ tracks: [...state.tracks, track], selected: id });
      sync();
    },
    setStart(id, t) {
      const track = state.tracks.find(candidate => candidate.id === id);
      if (track && !track.audio && Number.isFinite(t)) replaceTrack({ ...track, t });
    },
    destroy() {
      stopClock();
      listeners.clear();
      if (output) {
        output.pause();
        output.removeEventListener("error", onError);
        output.removeEventListener("loadedmetadata", onMetadata);
        output.src = "";
      }
      for (const track of state.tracks) {
        if (!track.audio) for (const file of track.files) options.revokeUrl?.(file.url);
      }
    },
  };
}
