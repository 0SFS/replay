import { extrapolateTrack } from "./extrapolate.ts";
import { addAttitudeEstimates } from "./kinematics.ts";
import { detectTrackInput, trackInput } from "./trackInputs.ts";
import {
  parseFlightTimeline, TIMELINE_FORMAT, TIMELINE_VERSION, TimelineError,
  type FlightTimeline, type TimelineAircraft, type TimelineEventKind, type TimelineAudio, type TimelineSource,
} from "./timeline.ts";

/**
 * A timeline described the way a person writes one: the recorded flights it is
 * made from and the moments, sources and caveats that go with them, with ISO
 * 8601 times that can be checked against the recordings by eye. The recipes in
 * data/ are specs plus where each track's file is.
 */
export interface TimelineSpec {
  id: string;
  title: string;
  subtitle?: string;
  timeZone?: string;
  /** t = 0. The first track's first kept sample, to the second, when omitted. */
  start?: string;
  highlight?: { start: string; end: string };
  license?: FlightTimeline["license"];
  sources: TimelineSource[];
  tracks: TrackSpec[];
  events: { at: string; title: string; detail?: string; kind: TimelineEventKind }[];
  audio?: AudioSpec[];
  notes?: string[];
}

/** Sound to play along, with `at`, the ISO 8601 instant its first second was heard, instead of `t`. */
export type AudioSpec = Omit<TimelineAudio, "t"> & { at: string };

export interface TrackSpec {
  id: string;
  label: string;
  /** A TRACK_INPUTS format, such as "readsb". */
  format: string;
  sources: string[];
  /** Keep samples from this time on. */
  from?: string;
  /** Keep samples up to this time. */
  to?: string;
  /** Laid over what the recording says about the aircraft. */
  aircraft?: TimelineAircraft;
  /**
   * Continues the track past its last report to the ground (src/extrapolate.ts):
   * `groundFt` above sea level, where sea level, the geoid, is `geoidFt` above
   * the WGS 84 ellipsoid that GNSS altitude is measured from.
   */
  extrapolate?: { groundFt: number; geoidFt: number };
}

function epochS(iso: string, where: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new TimelineError(`${where} is not an ISO 8601 time: ${iso}`);
  return ms / 1000;
}

const centi = (value: number) => Math.round(value * 100) / 100;

/** Builds a timeline from a spec and each track's parsed recording, in the same order. */
export function assembleTimeline(spec: TimelineSpec, recordings: readonly unknown[]): FlightTimeline {
  if (spec.tracks.length === 0 || recordings.length !== spec.tracks.length) throw new TimelineError("A timeline needs one recording per track, and at least one track.");
  let startEpochS = spec.start ? epochS(spec.start, "start") : undefined;
  const tracks = spec.tracks.map((trackSpec, index) => {
    const converted = trackInput(trackSpec.format).toTrack(recordings[index], {
      id: trackSpec.id,
      label: trackSpec.label,
      sources: trackSpec.sources,
      ...(trackSpec.from ? { fromEpochS: epochS(trackSpec.from, `tracks[${index}].from`) } : {}),
      ...(trackSpec.to ? { toEpochS: epochS(trackSpec.to, `tracks[${index}].to`) } : {}),
      ...(startEpochS !== undefined ? { startEpochS } : {}),
    });
    startEpochS ??= converted.startEpochS;
    const estimated = addAttitudeEstimates(converted.track);
    const track = trackSpec.extrapolate
      ? extrapolateTrack(estimated, { toAltGeomFt: trackSpec.extrapolate.groundFt + trackSpec.extrapolate.geoidFt })
      : estimated;
    const aircraft = { ...track.aircraft, ...trackSpec.aircraft };
    return Object.keys(aircraft).length ? { ...track, aircraft } : track;
  });
  const at = (iso: string, where: string) => centi(epochS(iso, where) - startEpochS!);
  return parseFlightTimeline({
    format: TIMELINE_FORMAT,
    version: TIMELINE_VERSION,
    id: spec.id,
    title: spec.title,
    ...(spec.subtitle ? { subtitle: spec.subtitle } : {}),
    start: new Date(startEpochS! * 1000).toISOString(),
    ...(spec.timeZone ? { timeZone: spec.timeZone } : {}),
    ...(spec.highlight ? { highlight: { start: at(spec.highlight.start, "highlight.start"), end: at(spec.highlight.end, "highlight.end") } } : {}),
    ...(spec.license ? { license: spec.license } : {}),
    sources: spec.sources,
    tracks,
    events: spec.events.map((event, index) => ({
      t: at(event.at, `events[${index}].at`),
      title: event.title,
      ...(event.detail ? { detail: event.detail } : {}),
      kind: event.kind,
    })),
    ...(spec.audio ? {
      audio: spec.audio.map(({ at: heard, ...audio }, index) => ({ ...audio, t: at(heard, `audio[${index}].at`) })),
    } : {}),
    ...(spec.notes ? { notes: spec.notes } : {}),
  });
}

/**
 * A timeline from a JSON file someone opened: a timeline itself, or a
 * recording any TRACK_INPUTS entry reads, replayed whole as one track.
 */
export function timelineFromJson(value: unknown, fileName: string): FlightTimeline {
  if (typeof value === "object" && value !== null && (value as { format?: unknown }).format === TIMELINE_FORMAT) return parseFlightTimeline(value);
  const input = detectTrackInput(value);
  if (!input) throw new TimelineError(`${fileName} is neither a flight timeline nor a recording this replay reads.`);
  const id = fileName.replace(/\.[^.]*$/, "") || "flight";
  const timeline = assembleTimeline({
    id, title: id, sources: [{ id: "file", name: fileName, url: "", note: `Opened from this device: ${input.label}.` }],
    tracks: [{ id: "track", label: fileName, format: input.format, sources: ["file"] }],
    events: [],
  }, [value]);
  const aircraft = timeline.tracks[0]!.aircraft;
  const title = [aircraft?.registration, aircraft?.description].filter(Boolean).join(", ");
  return title ? { ...timeline, title } : timeline;
}
