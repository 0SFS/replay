import type { TimelineChannel, TimelineTrack } from "./timeline.ts";

/**
 * What can be worked out about an aircraft's motion from its path alone: rates
 * from positions and altitudes, and the attitude a model needs to be drawn
 * along the path. A recorded or simulated attitude, where a track has one,
 * always wins over these estimates.
 */

const FT_PER_KT_S = 6076.12 / 3600;
const M_PER_FT = 0.3048;
const G_M_S2 = 9.80665;

/** Half the window rates are fitted over. */
export const RATE_FIT_HALF_WINDOW_S = 2;

/** Where samples are sparse, the window reaches the next sample each side up to this far away. */
export const RATE_FIT_MAX_REACH_S = 30;

/** A least-squares line through the values around a sample: its value and its slope, per second, at the sample's time. */
export interface WindowFit {
  value: number;
  slope: number;
}

/**
 * The least-squares line through the values within ±halfWindowS of each
 * sample, or out to its nearest valued neighbours where they are further (up
 * to RATE_FIT_MAX_REACH_S); null where the sample has no value or the window
 * holds less than a second of values.
 */
export function windowFit(t: readonly number[], values: readonly (number | null)[], halfWindowS = RATE_FIT_HALF_WINDOW_S): (WindowFit | null)[] {
  const result: (WindowFit | null)[] = [];
  const valued = (j: number) => values[j] !== null && values[j] !== undefined;
  for (let i = 0; i < t.length; i++) {
    if (!valued(i)) { result.push(null); continue; }
    let before = i - 1;
    while (before >= 0 && !valued(before)) before--;
    let after = i + 1;
    while (after < t.length && !valued(after)) after++;
    const reach = (j: number) => (j >= 0 && j < t.length && Math.abs(t[j]! - t[i]!) <= RATE_FIT_MAX_REACH_S ? Math.abs(t[j]! - t[i]!) : 0);
    const from = t[i]! - Math.max(halfWindowS, reach(before));
    const to = t[i]! + Math.max(halfWindowS, reach(after));
    let low = i;
    while (low > 0 && t[low - 1]! >= from) low--;
    let n = 0, sumT = 0, sumY = 0, sumTT = 0, sumTY = 0, first = Infinity, last = -Infinity;
    for (let j = low; j < t.length && t[j]! <= to; j++) {
      const value = values[j];
      if (value === null || value === undefined) continue;
      // Relative to the sample, so large times keep their precision.
      const dt = t[j]! - t[i]!;
      n++; sumT += dt; sumY += value; sumTT += dt * dt; sumTY += dt * value;
      first = Math.min(first, dt); last = Math.max(last, dt);
    }
    const den = n * sumTT - sumT * sumT;
    if (last - first < 1 || den <= 0) { result.push(null); continue; }
    const slope = (n * sumTY - sumT * sumY) / den;
    result.push({ value: (sumY - slope * sumT) / n, slope });
  }
  return result;
}

/** The slope, per second, of windowFit's line at each sample. */
export function windowSlope(t: readonly number[], values: readonly (number | null)[], halfWindowS = RATE_FIT_HALF_WINDOW_S): (number | null)[] {
  return windowFit(t, values, halfWindowS).map(fit => fit?.slope ?? null);
}

/** Angles in degrees made continuous, so 359 then 1 reads as 359 then 361. Nulls stay null and do not break the run. */
export function unwrapDegrees(values: readonly (number | null)[]): (number | null)[] {
  let previous: number | null = null;
  let offset = 0;
  return values.map(value => {
    if (value === null) return null;
    if (previous !== null) {
      const step = value + offset - previous;
      if (step > 180) offset -= 360;
      else if (step < -180) offset += 360;
    }
    previous = value + offset;
    return previous;
  });
}

export const ATTITUDE_ESTIMATE_CHANNELS: Record<string, TimelineChannel> = {
  turnRateDegS: {
    label: "Turn rate", unit: "deg/s",
    derived: `Least-squares slope of track over ±${RATE_FIT_HALF_WINDOW_S} s, or out to the next sample each side where samples are further apart.`,
  },
  pitchEstDeg: {
    label: "Flight-path angle", unit: "deg",
    derived: "atan(vertical rate / ground speed). Stands in for pitch when drawing the aircraft; the angle of attack and wind are not known.",
  },
  rollEstDeg: {
    label: "Bank (estimated)", unit: "deg",
    derived: "Bank of a coordinated turn at the measured turn rate and speed: atan(horizontal speed × turn rate / (g × cos flight-path angle)). Wind and sideslip are not known.",
  },
};

/** Channels a track's vertical rate is taken from, best first. */
const VERTICAL_RATE_CHANNELS = ["vsFromGeomFpm", "geomRateFpm", "baroRateFpm"];

/**
 * Adds turn rate, flight-path angle and an estimated bank to a track with
 * ground speed, track and a vertical rate. The aircraft is drawn with these
 * where the track has no recorded attitude.
 */
export function addAttitudeEstimates(track: TimelineTrack): TimelineTrack {
  const { samples } = track;
  const t = samples.t;
  const groundSpeed = samples.groundSpeedKt;
  const course = samples.trackDeg;
  if (!groundSpeed || !course) return track;
  const rates = VERTICAL_RATE_CHANNELS.map(id => samples[id]).filter(column => column !== undefined);
  const onGround = samples.onGround;
  const airborne = (i: number) => !onGround || onGround[i] !== 1;

  const turnRate = windowSlope(t, unwrapDegrees(course.map((value, i) => (airborne(i) ? value : null))));
  const pitch: (number | null)[] = [];
  const roll: (number | null)[] = [];
  for (let i = 0; i < t.length; i++) {
    const gsKt = groundSpeed[i] ?? null;
    if (!airborne(i)) { pitch.push(0); roll.push(0); continue; }
    const vsFpm = rates.map(column => column[i] ?? null).find(value => value !== null) ?? null;
    if (gsKt === null || vsFpm === null) { pitch.push(null); roll.push(null); continue; }
    const horizontalFtS = gsKt * FT_PER_KT_S;
    const gamma = Math.atan2(vsFpm / 60, horizontalFtS);
    pitch.push(Math.round(gamma * 180 / Math.PI * 10) / 10);
    const omega = turnRate[i];
    if (omega === null || omega === undefined) { roll.push(null); continue; }
    const lateral = horizontalFtS * M_PER_FT * omega * Math.PI / 180;
    roll.push(Math.round(Math.atan2(lateral, G_M_S2 * Math.cos(gamma)) * 180 / Math.PI * 10) / 10);
  }
  return {
    ...track,
    channels: { ...track.channels, ...ATTITUDE_ESTIMATE_CHANNELS },
    samples: {
      ...samples,
      turnRateDegS: turnRate.map(value => (value === null ? null : Math.round(value * 100) / 100)),
      pitchEstDeg: pitch,
      rollEstDeg: roll,
    },
  };
}
