import { timelineFromJson } from "./assembleTimeline.ts";
import { createRadioPlayer, type AudioOutput, type RadioPlayer, type RadioStatus } from "./radioPlayer.ts";
import { createReplayClock, type ReplayClock } from "./replayClock.ts";
import { timelineClockFormat, type TimelineClockFormat } from "./replayFormat.ts";
import type { ReplayMapState } from "./replayMapOverlay.ts";
import type { ReplayModelState, ReplayScene } from "./replayScene.ts";
import { parseFlightTimeline, timelineSpan, TimelineError, type FlightTimeline, type TimelineTrack } from "./timeline.ts";
import { parseTimelineIndex, timelineIndexUrl, timelineUrl, type TimelineIndexEntry } from "./timelineIndex.ts";
import { createTrackPoser, type TrackPose, type TrackPoser } from "./trackPose.ts";

/** One timeline open in the replay. */
export interface ReplaySession {
  timeline: FlightTimeline;
  /** The track the view follows: the timeline's first. */
  track: TimelineTrack;
  span: { start: number; end: number };
  clock: ReplayClock;
  /** The timeline's sound, and any the listener opened, played along with the clock. */
  radio: RadioPlayer;
  poseAt(t: number): TrackPose | null;
  /** Where each of the track's samples was reported: TrackPoser.reportAt. */
  reportAt: TrackPoser["reportAt"];
  format: TimelineClockFormat;
  /** The id it is published under, so its address can be shared; null for a file opened from this device. */
  publishedId: string | null;
}

export type ReplayViewState =
  | { status: "starting" }
  | { status: "ready" }
  | { status: "error"; message: string };

export interface ReplayState {
  /** The published timelines, once their list has loaded. */
  flights: TimelineIndexEntry[] | null;
  session: ReplaySession | null;
  /** What is loading, said for a person. */
  loading: string | null;
  error: string | null;
  view: ReplayViewState;
  model: ReplayModelState;
}

/** What a feedback file or a report says about the replay. */
export interface ReplayReport {
  timeline: { id: string; title: string; publishedId: string | null } | null;
  t: number | null;
  rate: number | null;
  playing: boolean | null;
  view: ReplayViewState;
  model: ReplayModelState;
  loading: string | null;
  error: string | null;
  /** How many published flights the list has, once it has loaded. */
  flights: number | null;
  /** The sound playing along, if the timeline has any. */
  radio: { selected: string | null; enabled: boolean; status: RadioStatus; offsetS: number | null } | null;
}

export interface ReplayAddress {
  timeline: string | null;
  t: number | null;
  rate: number | null;
}

export interface ReplayControllerOptions {
  /** Where the site's files are: import.meta.env.BASE_URL in the app. */
  baseUrl: string;
  fetchJson(url: string): Promise<unknown>;
  /** Puts the replay's place in the address bar, so a reload or a shared link opens it there. */
  writeAddress(address: ReplayAddress): void;
  /** For the clocks the controller makes; tests drive time themselves. */
  clockOptions?: Pick<Parameters<typeof createReplayClock>[0], "now" | "requestFrame" | "cancelFrame">;
  /** Makes the element that plays a timeline's sound: `() => new Audio()`. Without it the replay is silent. */
  createAudioOutput?: () => AudioOutput;
  /** Lets go of a sound file opened from this device: URL.revokeObjectURL. */
  revokeUrl?: (url: string) => void;
}

export interface ReplayController {
  getState(): ReplayState;
  subscribe(listener: () => void): () => void;
  /** Loads a published timeline and opens it at `t` (its highlight when omitted). */
  openPublished(id: string, at?: { t?: number | null; rate?: number | null }): Promise<void>;
  /** Opens a timeline or a recording from this device. */
  openFile(file: Pick<File, "name" | "text">): Promise<void>;
  /** Opens a timeline already in memory. */
  open(timeline: FlightTimeline, at?: { t?: number | null; rate?: number | null; publishedId?: string | null }): void;
  loadFlights(): Promise<void>;
  /** The 3D view, once it has started, or why it could not. */
  attachScene(scene: ReplayScene | null, error?: string): void;
  /** What the map draws. */
  mapState(): ReplayMapState | null;
  /** Calls back whenever what the map draws may have changed. */
  subscribeFrames(listener: () => void): () => void;
  report(): ReplayReport;
  destroy(): void;
}

/** How long the address waits for the replay to settle before it is rewritten: Safari allows 100 rewrites in 30 s. */
const ADDRESS_DELAY_MS = 400;

/** Reads ?timeline=, ?t= and ?rate= from an address. */
export function readReplayAddress(search: string): ReplayAddress {
  const params = new URLSearchParams(search);
  const number = (name: string) => {
    const raw = params.get(name);
    const value = raw === null || raw.trim() === "" ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const rate = number("rate");
  return { timeline: params.get("timeline"), t: number("t"), rate: rate !== null && rate > 0 ? rate : null };
}

/** Writes the replay's place into an address's query, keeping any other parameters. */
export function replayAddressSearch(search: string, address: ReplayAddress): string {
  const params = new URLSearchParams(search);
  const put = (name: string, value: string | null) => {
    if (value === null) params.delete(name);
    else params.set(name, value);
  };
  put("timeline", address.timeline);
  put("t", address.t === null ? null : String(Math.round(address.t * 10) / 10));
  put("rate", address.rate === null || address.rate === 1 ? null : String(address.rate));
  const query = params.toString();
  return query ? `?${query}` : "";
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createReplayController(options: ReplayControllerOptions): ReplayController {
  let state: ReplayState = { flights: null, session: null, loading: null, error: null, view: { status: "starting" }, model: { status: "none" } };
  const listeners = new Set<() => void>();
  const frameListeners = new Set<() => void>();
  let scene: ReplayScene | null = null;
  let stopClock: (() => void) | null = null;
  let addressTimer: ReturnType<typeof setTimeout> | null = null;
  // Each open counts up, so a load that finishes after a later one began is dropped.
  let generation = 0;

  const set = (next: Partial<ReplayState>) => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  };
  const frame = () => {
    for (const listener of [...frameListeners]) listener();
  };
  const writeAddressNow = () => {
    if (addressTimer !== null) clearTimeout(addressTimer);
    addressTimer = null;
    const session = state.session;
    if (!session) return;
    const { t, rate } = session.clock.get();
    options.writeAddress({ timeline: session.publishedId, t: session.publishedId ? t : null, rate: session.publishedId ? rate : null });
  };
  const writeAddressSoon = () => {
    if (addressTimer !== null) clearTimeout(addressTimer);
    addressTimer = setTimeout(writeAddressNow, ADDRESS_DELAY_MS);
  };
  const follow = () => {
    const session = state.session;
    scene?.follow(session ? {
      poseAt: session.poseAt,
      times: session.track.samples.t,
      reportAt: session.reportAt,
      epochMs: Date.parse(session.timeline.start),
      model: session.track.aircraft?.model,
      onModelState: model => { if (state.session === session) set({ model }); },
    } : null);
    if (session) scene?.show(session.clock.get().t);
  };
  const close = () => {
    stopClock?.();
    stopClock = null;
    state.session?.radio.destroy();
    state.session?.clock.destroy();
  };

  const controller: ReplayController = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    open(timeline, at = {}) {
      generation += 1;
      close();
      const track = timeline.tracks[0]!;
      const span = timelineSpan(timeline);
      const poser = createTrackPoser(track);
      const clock = createReplayClock({
        ...options.clockOptions,
        start: span.start, end: span.end,
        t: at.t ?? timeline.highlight?.start ?? span.start,
        rate: at.rate ?? 1,
      });
      const radio = createRadioPlayer({
        clock, audio: timeline.audio ?? [],
        ...(options.createAudioOutput ? { createOutput: options.createAudioOutput } : {}),
        ...(options.revokeUrl ? { revokeUrl: options.revokeUrl } : {}),
      });
      const session: ReplaySession = {
        timeline, track, span, clock, radio, poseAt: poser.poseAt, reportAt: poser.reportAt,
        format: timelineClockFormat(timeline),
        publishedId: at.publishedId ?? null,
      };
      let wasPlaying = false;
      stopClock = clock.subscribe(() => {
        const { t, playing } = clock.get();
        scene?.show(t);
        if (playing !== wasPlaying) scene?.setPlaying(playing);
        wasPlaying = playing;
        frame();
        // While it plays the address would change every frame; it is written once the replay stops.
        if (!playing) writeAddressSoon();
      });
      set({ session, loading: null, error: null, model: { status: "none" } });
      scene?.setPlaying(false);
      follow();
      frame();
      writeAddressNow();
    },
    async openPublished(id, at = {}) {
      const mine = ++generation;
      const entry = state.flights?.find(flight => flight.id === id);
      set({ loading: entry ? entry.title : id, error: null });
      try {
        const timeline = parseFlightTimeline(await options.fetchJson(timelineUrl(options.baseUrl, id)));
        if (mine !== generation) return;
        controller.open(timeline, { ...at, publishedId: id });
      } catch (error) {
        if (mine !== generation) return;
        set({ loading: null, error: `The flight "${id}" could not be opened: ${message(error)}` });
      }
    },
    async openFile(file) {
      const mine = ++generation;
      set({ loading: file.name, error: null });
      try {
        let value: unknown;
        try {
          value = JSON.parse(await file.text());
        } catch {
          throw new TimelineError("It is not JSON.");
        }
        const timeline = timelineFromJson(value, file.name);
        if (mine !== generation) return;
        controller.open(timeline);
      } catch (error) {
        if (mine !== generation) return;
        set({ loading: null, error: `${file.name} could not be opened: ${message(error)}` });
      }
    },
    async loadFlights() {
      try {
        set({ flights: parseTimelineIndex(await options.fetchJson(timelineIndexUrl(options.baseUrl))) });
      } catch (error) {
        set({ flights: [], error: state.error ?? `The list of flights could not be loaded: ${message(error)}` });
      }
    },
    attachScene(next, error) {
      scene = next;
      set({ view: next ? { status: "ready" } : { status: "error", message: error ?? "The 3D view could not start." } });
      follow();
    },
    mapState() {
      const session = state.session;
      if (!session) return null;
      const { t } = session.clock.get();
      return { track: session.track, t, pose: session.poseAt(t) };
    },
    report() {
      const { session, view, model, loading, error, flights } = state;
      const clock = session?.clock.get();
      const radio = session?.radio.getState();
      const sound = radio?.tracks.find(candidate => candidate.id === radio.selected);
      return {
        timeline: session ? { id: session.timeline.id, title: session.timeline.title, publishedId: session.publishedId } : null,
        t: clock ? Math.round(clock.t * 100) / 100 : null,
        rate: clock?.rate ?? null,
        playing: clock?.playing ?? null,
        view, model, loading, error,
        flights: flights?.length ?? null,
        radio: radio ? { selected: radio.selected, enabled: radio.enabled, status: radio.status, offsetS: sound?.offsetS ?? null } : null,
      };
    },
    subscribeFrames(listener) {
      frameListeners.add(listener);
      return () => { frameListeners.delete(listener); };
    },
    destroy() {
      generation += 1;
      if (addressTimer !== null) clearTimeout(addressTimer);
      close();
      listeners.clear();
      frameListeners.clear();
    },
  };
  return controller;
}
