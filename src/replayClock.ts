/** Where a replay is in its timeline, and whether it is moving. */
export interface ReplayClockState {
  /** Seconds after the timeline's start. */
  t: number;
  playing: boolean;
  /** Timeline seconds per real second. */
  rate: number;
}

export interface ReplayClock {
  get(): ReplayClockState;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Moves to `t`, kept within the clock's span. */
  seek(t: number): void;
  setRate(rate: number): void;
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

export interface ReplayClockOptions {
  start: number;
  end: number;
  t?: number;
  rate?: number;
  /** Milliseconds, as performance.now() gives them. */
  now?(): number;
  /** Calls back on the next frame, as requestAnimationFrame does. */
  requestFrame?(callback: () => void): number;
  cancelFrame?(handle: number): void;
}

/** The rates offered; the clock takes any positive rate. */
export const REPLAY_RATES = [0.25, 0.5, 1, 2, 5, 10, 30, 60] as const;

/**
 * A replay's clock: it advances by real time × rate on each frame while
 * playing, and stops at the end. Play from the end starts again.
 */
export function createReplayClock(options: ReplayClockOptions): ReplayClock {
  const now = options.now ?? (() => performance.now());
  const requestFrame = options.requestFrame ?? (callback => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? (handle => cancelAnimationFrame(handle));
  const clamp = (t: number) => Math.min(options.end, Math.max(options.start, t));
  let state: ReplayClockState = { t: clamp(options.t ?? options.start), playing: false, rate: options.rate ?? 1 };
  const listeners = new Set<() => void>();
  let frame: number | null = null;
  let lastMs = 0;

  const set = (next: Partial<ReplayClockState>) => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  };
  const tick = () => {
    frame = null;
    if (!state.playing) return;
    const at = now();
    const t = clamp(state.t + (at - lastMs) / 1000 * state.rate);
    lastMs = at;
    if (t >= options.end) { set({ t, playing: false }); return; }
    set({ t });
    frame = requestFrame(tick);
  };
  const stopFrames = () => {
    if (frame !== null) cancelFrame(frame);
    frame = null;
  };

  const clock: ReplayClock = {
    get: () => state,
    play() {
      if (state.playing) return;
      lastMs = now();
      set({ playing: true, ...(state.t >= options.end ? { t: options.start } : {}) });
      frame = requestFrame(tick);
    },
    pause() {
      if (!state.playing) return;
      stopFrames();
      set({ playing: false });
    },
    toggle() {
      if (state.playing) clock.pause();
      else clock.play();
    },
    seek(t) {
      lastMs = now();
      set({ t: clamp(t) });
    },
    setRate(rate) {
      if (!(rate > 0)) return;
      set({ rate });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    destroy() {
      stopFrames();
      listeners.clear();
    },
  };
  return clock;
}
