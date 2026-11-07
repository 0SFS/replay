import { isReadsbTrace, readsbTraceToTrack, type ReadsbTrackOptions } from "./readsbTrace.ts";
import type { TimelineTrack } from "./timeline.ts";

export type TrackInputOptions = ReadsbTrackOptions;

/**
 * A kind of recorded flight a timeline track can be made from. Each reads one
 * parsed file and gives a track, with t = 0 at `startEpochS` when given.
 * Another source, such as OpenSky state vectors or the simulator's flight
 * recorder, is one more entry in TRACK_INPUTS.
 */
export interface TrackInput {
  format: string;
  label: string;
  accepts(data: unknown): boolean;
  toTrack(data: unknown, options: TrackInputOptions): { track: TimelineTrack; startEpochS: number };
}

export const TRACK_INPUTS: readonly TrackInput[] = [
  {
    format: "readsb",
    label: "readsb trace (adsb.lol, ADS-B Exchange, airplanes.live, adsb.fi and other tar1090 sites)",
    accepts: isReadsbTrace,
    toTrack(data, options) {
      if (!isReadsbTrace(data)) throw new Error("This is not a readsb trace: it needs `icao`, `timestamp` and `trace`.");
      return readsbTraceToTrack(data, options);
    },
  },
];

export function trackInput(format: string): TrackInput {
  const input = TRACK_INPUTS.find(candidate => candidate.format === format);
  if (!input) throw new Error(`No track input reads "${format}"; known: ${TRACK_INPUTS.map(candidate => candidate.format).join(", ")}.`);
  return input;
}

/** The input that reads a parsed file, or null. */
export function detectTrackInput(data: unknown): TrackInput | null {
  return TRACK_INPUTS.find(input => input.accepts(data)) ?? null;
}
