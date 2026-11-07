/**
 * A flight timeline: what one or more aircraft did over time, in one file that
 * a page can replay on any device without running a simulation again. Tracks
 * observed by ADS-B and tracks flown by the simulator share the format, so a
 * replay can lay them over each other. docs/timeline-format.md describes it.
 */

export const TIMELINE_FORMAT = "0sfs-flight-timeline";
export const TIMELINE_VERSION = 1;

/** How a value between two samples is found. */
export type ChannelInterpolation = "linear" | "angle" | "step";

export interface TimelineChannel {
  label: string;
  /** "deg", "ft", "kt", "ft/min", "bool", "count" or another short unit. */
  unit: string;
  /** Linear when omitted. Angles take the shorter way round; steps hold the earlier sample. */
  interpolation?: ChannelInterpolation;
  /** How the channel was computed, when the source did not report it directly. */
  derived?: string;
  note?: string;
}

export type TrackSamples = { t: number[] } & Record<string, (number | null)[]>;

/** Credit a model's licence asks for, shown wherever the model is. */
export interface TimelineModelCredit {
  artist: string;
  licence: string;
  sourceUrl?: string;
  note?: string;
}

/** A 3D model to draw a track with, as an 0SFS aircraft definition gives it. */
export interface TimelineModel {
  /** Relative to the site's root, such as "aircraft/learjet-60/Learjet_60_HD.glb". */
  url: string;
  label: string;
  /** Turn about the vertical axis that points the model's nose forward, as in the aircraft definition. */
  yawRad?: number;
  /** Metres from the model's origin to the point the track's position refers to, as in the aircraft definition. */
  offset?: { x: number; y: number; z: number };
  credit?: TimelineModelCredit;
  /** How the model differs from the aircraft it stands for, such as another aircraft's paint. */
  note?: string;
}

export interface TimelineAircraft {
  registration?: string;
  /** ICAO type designator, such as "LJ60". */
  type?: string;
  description?: string;
  /** Mode S address in hex. */
  icao24?: string;
  model?: TimelineModel;
}

export interface TimelineTrack {
  id: string;
  label: string;
  kind: "observed" | "simulated";
  aircraft?: TimelineAircraft;
  /** Ids of the timeline's sources this track comes from. */
  sources: string[];
  /** Every track has latDeg and lonDeg; the rest are optional. */
  channels: Record<string, TimelineChannel>;
  /** One column per channel and `t`, seconds after the timeline's start, never decreasing. */
  samples: TrackSamples;
}

export type TimelineEventKind = "phase" | "observation" | "radio" | "note";

export interface TimelineEvent {
  /** Seconds after the timeline's start. */
  t: number;
  title: string;
  detail?: string;
  kind: TimelineEventKind;
}

export interface TimelineSource {
  id: string;
  name: string;
  url: string;
  license?: string;
  licenseUrl?: string;
  attribution?: string;
  retrieved?: string;
  note?: string;
}

/** One way to fetch a sound recording. */
export interface TimelineAudioFile {
  /** Absolute, or relative to the site's root. */
  url: string;
  /** MIME type with codecs, such as `audio/ogg; codecs="opus"`, which a browser checks before it fetches. */
  type: string;
}

/** What was said, at seconds into the recording. */
export interface TimelineTranscriptLine {
  at: number;
  end: number;
  text: string;
}

/** A sound recording that plays along with the replay, such as air traffic control's frequency. */
export interface TimelineAudio {
  id: string;
  label: string;
  kind: "radio";
  /** The same audio in more than one format, in order of preference: a browser plays the first it can. */
  files: TimelineAudioFile[];
  /** Ids of the timeline's sources the audio comes from. */
  sources: string[];
  /** Seconds after the timeline's start at which the recording's first second plays. */
  t: number;
  /** Seconds. */
  duration: number;
  /** How `t` was found, and within how many seconds it is known. */
  alignment: { method: string; uncertaintyS: number };
  transcript?: TimelineTranscriptLine[];
  /** Where the transcript came from and how far to trust it. */
  transcriptNote?: string;
  note?: string;
}

export interface FlightTimeline {
  format: typeof TIMELINE_FORMAT;
  version: typeof TIMELINE_VERSION;
  id: string;
  title: string;
  subtitle?: string;
  /** ISO 8601 instant of t = 0. */
  start: string;
  /** IANA zone for local times, such as "America/New_York". UTC when omitted. */
  timeZone?: string;
  /** The part a viewer opens on, in seconds after the start. */
  highlight?: { start: number; end: number };
  license?: { id: string; url: string; attribution: string };
  sources: TimelineSource[];
  /** The first track is the one the replay follows. Two aircraft, or a flight and its simulation, are two tracks. */
  tracks: TimelineTrack[];
  events: TimelineEvent[];
  /** Sound that plays along with the replay. */
  audio?: TimelineAudio[];
  /** Caveats a reader should see before drawing conclusions. */
  notes?: string[];
}

export class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineError";
  }
}

const EVENT_KINDS: readonly TimelineEventKind[] = ["phase", "observation", "radio", "note"];
const INTERPOLATIONS: readonly ChannelInterpolation[] = ["linear", "angle", "step"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TimelineError(`${where} must be a non-empty string.`);
  return value;
}

function requireFinite(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TimelineError(`${where} must be a finite number.`);
  return value;
}

function parseTrack(value: unknown, index: number): TimelineTrack {
  const where = `tracks[${index}]`;
  if (!isRecord(value)) throw new TimelineError(`${where} must be an object.`);
  const kind = value.kind;
  if (kind !== "observed" && kind !== "simulated") throw new TimelineError(`${where}.kind must be "observed" or "simulated".`);
  if (!isRecord(value.channels)) throw new TimelineError(`${where}.channels must be an object.`);
  if (!isRecord(value.samples)) throw new TimelineError(`${where}.samples must be an object.`);
  const channels = value.channels as Record<string, TimelineChannel>;
  for (const [id, channel] of Object.entries(channels)) {
    if (!isRecord(channel)) throw new TimelineError(`${where}.channels.${id} must be an object.`);
    requireString(channel.label, `${where}.channels.${id}.label`);
    if (typeof channel.unit !== "string") throw new TimelineError(`${where}.channels.${id}.unit must be a string.`);
    if (channel.interpolation !== undefined && !INTERPOLATIONS.includes(channel.interpolation)) {
      throw new TimelineError(`${where}.channels.${id}.interpolation must be one of ${INTERPOLATIONS.join(", ")}.`);
    }
  }
  for (const required of ["latDeg", "lonDeg"]) {
    if (!channels[required]) throw new TimelineError(`${where} needs a ${required} channel.`);
  }
  const samples = value.samples as Record<string, unknown>;
  const t = samples.t;
  if (!Array.isArray(t) || t.length === 0) throw new TimelineError(`${where}.samples.t must be a non-empty array.`);
  for (let i = 0; i < t.length; i++) {
    requireFinite(t[i], `${where}.samples.t[${i}]`);
    if (i > 0 && (t[i] as number) < (t[i - 1] as number)) throw new TimelineError(`${where}.samples.t decreases at index ${i}.`);
  }
  for (const id of Object.keys(channels)) {
    const column = samples[id];
    if (!Array.isArray(column) || column.length !== t.length) {
      throw new TimelineError(`${where}.samples.${id} must have one value per time (${t.length}).`);
    }
    for (let i = 0; i < column.length; i++) {
      const sample = column[i];
      if (sample !== null && (typeof sample !== "number" || !Number.isFinite(sample))) {
        throw new TimelineError(`${where}.samples.${id}[${i}] must be a finite number or null.`);
      }
    }
  }
  const model = isRecord(value.aircraft) ? value.aircraft.model : undefined;
  if (model !== undefined) {
    if (!isRecord(model)) throw new TimelineError(`${where}.aircraft.model must be an object.`);
    requireString(model.url, `${where}.aircraft.model.url`);
    requireString(model.label, `${where}.aircraft.model.label`);
    if (model.note !== undefined) requireString(model.note, `${where}.aircraft.model.note`);
  }
  return {
    ...(isRecord(value.aircraft) ? { aircraft: value.aircraft as TimelineAircraft } : {}),
    id: requireString(value.id, `${where}.id`),
    label: requireString(value.label, `${where}.label`),
    kind,
    sources: Array.isArray(value.sources) ? value.sources.filter((id): id is string => typeof id === "string") : [],
    channels,
    samples: samples as TrackSamples,
  };
}

function parseAudio(value: unknown, index: number): TimelineAudio {
  const where = `audio[${index}]`;
  if (!isRecord(value)) throw new TimelineError(`${where} must be an object.`);
  if (value.kind !== "radio") throw new TimelineError(`${where}.kind must be "radio".`);
  if (!Array.isArray(value.files) || value.files.length === 0) throw new TimelineError(`${where}.files must list at least one file.`);
  value.files.forEach((file: unknown, i: number) => {
    if (!isRecord(file)) throw new TimelineError(`${where}.files[${i}] must be an object.`);
    requireString(file.url, `${where}.files[${i}].url`);
    requireString(file.type, `${where}.files[${i}].type`);
  });
  if (!Array.isArray(value.sources)) throw new TimelineError(`${where}.sources must be a list of source ids.`);
  const duration = requireFinite(value.duration, `${where}.duration`);
  if (duration <= 0) throw new TimelineError(`${where}.duration must be more than 0.`);
  if (!isRecord(value.alignment)) throw new TimelineError(`${where}.alignment must say how the recording was aligned.`);
  requireString(value.alignment.method, `${where}.alignment.method`);
  requireFinite(value.alignment.uncertaintyS, `${where}.alignment.uncertaintyS`);
  const transcript = value.transcript;
  if (transcript !== undefined) {
    if (!Array.isArray(transcript)) throw new TimelineError(`${where}.transcript must be a list.`);
    transcript.forEach((line: unknown, i: number) => {
      const at = `${where}.transcript[${i}]`;
      if (!isRecord(line)) throw new TimelineError(`${at} must be an object.`);
      const start = requireFinite(line.at, `${at}.at`);
      const end = requireFinite(line.end, `${at}.end`);
      if (start < 0 || end < start || end > duration) throw new TimelineError(`${at} must lie within the recording, from at to end.`);
      if (i > 0 && start < (transcript[i - 1] as TimelineTranscriptLine).at) throw new TimelineError(`${at} comes before the line above it.`);
      requireString(line.text, `${at}.text`);
    });
  }
  return {
    ...(value as unknown as TimelineAudio),
    id: requireString(value.id, `${where}.id`),
    label: requireString(value.label, `${where}.label`),
    t: requireFinite(value.t, `${where}.t`),
  };
}

/** Checks a parsed JSON value and returns it as a timeline, or throws a TimelineError that says what is wrong. */
export function parseFlightTimeline(value: unknown): FlightTimeline {
  if (!isRecord(value)) throw new TimelineError("A timeline must be a JSON object.");
  if (value.format !== TIMELINE_FORMAT) throw new TimelineError(`This file is not a flight timeline (format must be "${TIMELINE_FORMAT}").`);
  if (value.version !== TIMELINE_VERSION) throw new TimelineError(`This replay reads timeline version ${TIMELINE_VERSION}; the file is version ${String(value.version)}.`);
  const start = requireString(value.start, "start");
  if (!Number.isFinite(Date.parse(start))) throw new TimelineError("start must be an ISO 8601 time.");
  if (!Array.isArray(value.tracks) || value.tracks.length === 0) throw new TimelineError("A timeline needs at least one track.");
  const tracks = value.tracks.map(parseTrack);
  const events = (Array.isArray(value.events) ? value.events : []).map((event: unknown, index: number): TimelineEvent => {
    if (!isRecord(event)) throw new TimelineError(`events[${index}] must be an object.`);
    const kind = event.kind ?? "note";
    if (!EVENT_KINDS.includes(kind as TimelineEventKind)) throw new TimelineError(`events[${index}].kind must be one of ${EVENT_KINDS.join(", ")}.`);
    return {
      t: requireFinite(event.t, `events[${index}].t`),
      title: requireString(event.title, `events[${index}].title`),
      ...(typeof event.detail === "string" ? { detail: event.detail } : {}),
      kind: kind as TimelineEventKind,
    };
  }).sort((a, b) => a.t - b.t);
  let highlight: FlightTimeline["highlight"];
  if (value.highlight !== undefined) {
    if (!isRecord(value.highlight)) throw new TimelineError("highlight must be an object.");
    highlight = { start: requireFinite(value.highlight.start, "highlight.start"), end: requireFinite(value.highlight.end, "highlight.end") };
  }
  return {
    ...(value as unknown as FlightTimeline),
    id: requireString(value.id, "id"),
    title: requireString(value.title, "title"),
    start,
    sources: Array.isArray(value.sources) ? value.sources as TimelineSource[] : [],
    tracks,
    events,
    ...(highlight ? { highlight } : {}),
    ...(value.audio !== undefined ? { audio: parseAudioList(value.audio) } : {}),
  };
}

function parseAudioList(value: unknown): TimelineAudio[] {
  if (!Array.isArray(value)) throw new TimelineError("audio must be a list.");
  return value.map(parseAudio);
}

/** The first and last time any track has a sample. */
export function timelineSpan(timeline: FlightTimeline): { start: number; end: number } {
  let start = Infinity;
  let end = -Infinity;
  for (const track of timeline.tracks) {
    const t = track.samples.t;
    start = Math.min(start, t[0]!);
    end = Math.max(end, t[t.length - 1]!);
  }
  return { start, end };
}

/** Milliseconds since 1970 of a time on the timeline. */
export function timelineEpochMs(timeline: FlightTimeline, t: number): number {
  return Date.parse(timeline.start) + t * 1000;
}

/** Index of the last sample at or before `t`, or -1 before the first. */
export function sampleIndexAt(times: readonly number[], t: number): number {
  let low = 0;
  let high = times.length - 1;
  if (high < 0 || t < times[0]!) return -1;
  if (t >= times[high]!) return high;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (times[middle]! <= t) low = middle;
    else high = middle - 1;
  }
  return low;
}

function wrapDegrees(value: number, min: number): number {
  return ((value - min) % 360 + 360) % 360 + min;
}

function interpolate(a: number | null, b: number | null, f: number, mode: ChannelInterpolation, lowerBound: number): number | null {
  if (mode === "step") return a;
  if (a === null || b === null) return f < 0.5 ? a : b;
  if (mode === "angle") {
    const delta = wrapDegrees(b - a, -180);
    return wrapDegrees(a + delta * f, lowerBound);
  }
  return a + (b - a) * f;
}

export interface TrackSample {
  /** Time asked for. */
  t: number;
  /** Index of the sample at or before `t`. */
  index: number;
  values: Record<string, number | null>;
}

/**
 * The track's state at `t`, interpolated between its samples, or null outside
 * the time it covers. Where one neighbour has no value, the nearer neighbour's
 * value (or its absence) is used; a step channel holds the earlier sample.
 */
export function sampleTrack(track: TimelineTrack, t: number): TrackSample | null {
  const times = track.samples.t;
  const index = sampleIndexAt(times, t);
  if (index < 0 || t > times[times.length - 1]!) return null;
  const next = Math.min(index + 1, times.length - 1);
  const span = times[next]! - times[index]!;
  const f = span > 0 ? (t - times[index]!) / span : 0;
  const values: Record<string, number | null> = {};
  for (const [id, channel] of Object.entries(track.channels)) {
    const column = track.samples[id]!;
    const mode = channel.interpolation ?? "linear";
    // Longitudes stay within ±180; headings and tracks within 0–360.
    const lowerBound = id === "lonDeg" ? -180 : 0;
    values[id] = interpolate(column[index] ?? null, column[next] ?? null, f, mode, lowerBound);
  }
  return { t, index, values };
}

/** The last value of a channel at or before sample `index`, skipping nulls. */
export function lastKnown(track: TimelineTrack, channel: string, index: number): { t: number; value: number } | null {
  const column = track.samples[channel];
  if (!column) return null;
  for (let i = Math.min(index, column.length - 1); i >= 0; i--) {
    const value = column[i];
    if (value !== null && value !== undefined) return { t: track.samples.t[i]!, value };
  }
  return null;
}
