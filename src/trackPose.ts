import { RATE_FIT_HALF_WINDOW_S, windowFit } from "./kinematics.ts";
import { sampleTrack, type TimelineTrack, type TrackSample } from "./timeline.ts";

const M_PER_FT = 0.3048;
const RAD_PER_DEG = Math.PI / 180;

/** Where an aircraft is and how it is turned, as the 3D view and the map draw it. */
export interface TrackPose {
  latDeg: number;
  lonDeg: number;
  /** Height above the WGS 84 ellipsoid. */
  altMeters: number;
  headingRad: number;
  pitchRad: number;
  rollRad: number;
  /** Whether pitch and bank were recorded, or worked out from the path. */
  attitude: "recorded" | "estimated";
  sample: TrackSample;
}

/** A place on the globe, its height above the WGS 84 ellipsoid in metres. */
export interface GeoPoint {
  latDeg: number;
  lonDeg: number;
  altMeters: number;
}

/** Where a view of a pose looks: at it, its way, loading detail for its height as the flight does. */
export interface PoseView {
  latDeg: number;
  lonDeg: number;
  headingDeg: number;
  zoomMeters: number;
}

export function poseView(pose: TrackPose): PoseView {
  return {
    latDeg: pose.latDeg,
    lonDeg: pose.lonDeg,
    headingDeg: pose.headingRad / RAD_PER_DEG,
    zoomMeters: Math.max(250, Math.min(pose.altMeters * 1.5, 12_000)),
  };
}

/**
 * Channels a pose is read from, best first. A simulated or recorded attitude
 * wins over one estimated from the path; GNSS altitude, which is height above
 * the ellipsoid like the globe's, wins over pressure altitude.
 */
const HEADING = ["headingDeg", "trackDeg"];
const PITCH = ["pitchDeg", "pitchEstDeg"];
const ROLL = ["rollDeg", "rollEstDeg"];
const ALTITUDE = ["altGeomFt", "altBaroFt"];

/**
 * Each null replaced along a straight line in time between the values each
 * side of it, or by the nearest value before the first or after the last, so
 * a gap in a column does not drop the aircraft.
 */
export function fillGaps(t: readonly number[], column: readonly (number | null)[]): (number | null)[] {
  const result = column.slice();
  let before = -1;
  for (let i = 0; i <= column.length; i++) {
    if (i < column.length && column[i] === null) continue;
    for (let j = before + 1; j < i; j++) {
      if (before < 0) result[j] = i < column.length ? column[i]! : null;
      else if (i === column.length) result[j] = column[before]!;
      else result[j] = column[before]! + (column[i]! - column[before]!) * (t[j]! - t[before]!) / (t[i]! - t[before]!);
    }
    before = i;
  }
  return result;
}

/**
 * The altitude the aircraft and its path are drawn at: at each report, a
 * least-squares line through the reports within ±RATE_FIT_HALF_WINDOW_S,
 * which takes out the 25 ft steps and repeated values ADS-B reports altitude
 * with but keeps anything that lasts longer; in gaps, a straight line between
 * the reports. Samples marked in `exact`, such as extrapolated ones, have no
 * such steps and are drawn as they are, so a track continued to the ground
 * ends on it.
 */
export function drawnAltitudeFt(t: readonly number[], column: readonly (number | null)[], exact?: readonly (number | null)[]): (number | null)[] {
  const fits = windowFit(t, column, RATE_FIT_HALF_WINDOW_S);
  return fillGaps(t, column.map((value, i) => (value === null || exact?.[i] === 1 ? value : fits[i]?.value ?? value)));
}

export interface TrackPoser {
  /** Where the aircraft is drawn at `t`, along the path through every sample. */
  poseAt(t: number): TrackPose | null;
  /**
   * Where the sample at `index` was reported, at the altitude reported rather
   * than the smoothed one the path is drawn at; null for a sample that is not
   * a report, such as an extrapolated one, or that has no position.
   */
  reportAt(index: number): GeoPoint | null;
  /** The altitude, in feet, the path is drawn at through each sample. */
  altitudeFtColumn: (number | null)[];
}

/** Turns a track into poses at any time within it. */
export function createTrackPoser(track: TimelineTrack): TrackPoser {
  const t = track.samples.t;
  const altitudeId = ALTITUDE.find(id => track.channels[id] && track.samples[id]?.some(value => value !== null));
  const altitudeFtColumn = altitudeId ? drawnAltitudeFt(t, track.samples[altitudeId]!, track.samples.extrapolated) : t.map(() => 0);
  const filled: TimelineTrack = {
    ...track,
    channels: { ...track.channels, poseAltitudeFt: { label: "Altitude", unit: "ft" } },
    samples: { ...track.samples, poseAltitudeFt: altitudeFtColumn },
  };
  const recorded = PITCH[0]! in track.channels && ROLL[0]! in track.channels;
  const first = (values: Record<string, number | null>, ids: string[]) => {
    for (const id of ids) if (values[id] !== null && values[id] !== undefined) return values[id]!;
    return 0;
  };
  return {
    altitudeFtColumn,
    poseAt(time) {
      const sample = sampleTrack(filled, time);
      if (!sample) return null;
      const { values } = sample;
      if (values.latDeg === null || values.lonDeg === null) return null;
      return {
        latDeg: values.latDeg!,
        lonDeg: values.lonDeg!,
        altMeters: (values.poseAltitudeFt ?? 0) * M_PER_FT,
        headingRad: first(values, HEADING) * RAD_PER_DEG,
        pitchRad: first(values, PITCH) * RAD_PER_DEG,
        rollRad: first(values, ROLL) * RAD_PER_DEG,
        attitude: recorded ? "recorded" : "estimated",
        sample,
      };
    },
    reportAt(index) {
      const { samples } = track;
      if (samples.extrapolated?.[index] === 1) return null;
      const latDeg = samples.latDeg?.[index] ?? null;
      const lonDeg = samples.lonDeg?.[index] ?? null;
      if (latDeg === null || lonDeg === null) return null;
      const reportedFt = altitudeId ? samples[altitudeId]![index] ?? null : null;
      return { latDeg, lonDeg, altMeters: (reportedFt ?? altitudeFtColumn[index] ?? 0) * M_PER_FT };
    },
  };
}
