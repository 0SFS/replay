import { TimelineError, type TimelineChannel, type TimelineTrack } from "./timeline.ts";

/**
 * Continues a track past its last report to a GNSS altitude, such as the
 * ground's, at the last report's ground speed, turn rate and vertical rate.
 * Nothing it adds was reported: every added sample has `extrapolated` set, and
 * the channels it does not continue are null there.
 */

const M_PER_NM = 1852;
const EARTH_RADIUS_M = 6_371_008.8;

export interface ExtrapolateOptions {
  /** The GNSS altitude to continue the track to, in feet above the WGS 84 ellipsoid. */
  toAltGeomFt: number;
  /** Seconds between the added samples. */
  stepS?: number;
  /** The longest a track may be continued, in seconds. */
  maxS?: number;
}

export const EXTRAPOLATED_CHANNEL: TimelineChannel = {
  label: "Extrapolated", unit: "bool", interpolation: "step",
  derived: "Set past the last report, where the track is continued at the last report's ground speed, turn rate and vertical rate. Position, GNSS altitude, ground speed, track and rates there were worked out, not reported.",
};

/** Vertical rates a track can be continued at, best first. */
const VERTICAL_RATE_CHANNELS = ["vsFromGeomFpm", "geomRateFpm"];

/** Channels that keep the last report's value in the samples added. */
const HELD_CHANNELS = ["groundSpeedKt", "turnRateDegS", "pitchEstDeg", "rollEstDeg"];

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

export function extrapolateTrack(track: TimelineTrack, options: ExtrapolateOptions): TimelineTrack {
  const { samples } = track;
  const stepS = options.stepS ?? 0.1;
  const maxS = options.maxS ?? 30;
  const last = samples.t.length - 1;
  const at = (id: string) => samples[id]?.[last] ?? null;
  const need = (id: string) => {
    const value = at(id);
    if (value === null) throw new TimelineError(`Track ${track.id} cannot be extrapolated: its last sample has no ${id}.`);
    return value;
  };
  const t0 = samples.t[last]!;
  const lat0 = need("latDeg"), lon0 = need("lonDeg"), alt0 = need("altGeomFt");
  const speedMS = need("groundSpeedKt") * M_PER_NM / 3600;
  const course0Deg = need("trackDeg");
  const rateId = VERTICAL_RATE_CHANNELS.find(id => at(id) !== null);
  if (!rateId) throw new TimelineError(`Track ${track.id} cannot be extrapolated: its last sample has no vertical rate.`);
  const rateFtS = at(rateId)! / 60;
  const turnDegS = at("turnRateDegS") ?? 0;

  const durationS = (options.toAltGeomFt - alt0) / rateFtS;
  if (!(durationS > 0)) throw new TimelineError(`Track ${track.id} is not heading for ${options.toAltGeomFt} ft at its last report.`);
  if (durationS > maxS) throw new TimelineError(`Track ${track.id} would take ${durationS.toFixed(1)} s to reach ${options.toAltGeomFt} ft, more than the ${maxS} s it may be extrapolated.`);
  const endT = round(t0 + durationS, 2);
  const times: number[] = [];
  for (let k = 1; round(t0 + k * stepS, 2) < endT - 0.005; k++) times.push(round(t0 + k * stepS, 2));
  times.push(endT);

  const course0 = course0Deg * Math.PI / 180;
  const turn = turnDegS * Math.PI / 180;
  const added = times.map((time, index) => {
    const tau = time - t0;
    // Along a circle at the turn rate; north and east in metres from the last report.
    const north = Math.abs(turn * tau) < 1e-9 ? speedMS * tau * Math.cos(course0) : speedMS / turn * (Math.sin(course0 + turn * tau) - Math.sin(course0));
    const east = Math.abs(turn * tau) < 1e-9 ? speedMS * tau * Math.sin(course0) : speedMS / turn * (Math.cos(course0) - Math.cos(course0 + turn * tau));
    const lon = lon0 + east / (EARTH_RADIUS_M * Math.cos(lat0 * Math.PI / 180)) * 180 / Math.PI;
    return {
      latDeg: round(lat0 + north / EARTH_RADIUS_M * 180 / Math.PI, 6),
      lonDeg: round(((lon + 180) % 360 + 360) % 360 - 180, 6),
      altGeomFt: index === times.length - 1 ? options.toAltGeomFt : Math.round(alt0 + rateFtS * tau),
      trackDeg: round(((course0Deg + turnDegS * tau) % 360 + 360) % 360, 1),
      [rateId]: at(rateId),
    } as Record<string, number | null>;
  });

  const extended: Record<string, (number | null)[]> = { t: [...samples.t, ...times] };
  for (const id of Object.keys(track.channels)) {
    const column = samples[id] ?? [];
    const value = (row: Record<string, number | null>) => (id in row ? row[id]! : HELD_CHANNELS.includes(id) ? at(id) : null);
    extended[id] = [...column, ...added.map(value)];
  }
  extended.extrapolated = [...samples.t.map(() => 0), ...times.map(() => 1)];
  return {
    ...track,
    channels: { ...track.channels, extrapolated: EXTRAPOLATED_CHANNEL },
    samples: extended as TimelineTrack["samples"],
  };
}
