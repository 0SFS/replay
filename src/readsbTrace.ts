import { RATE_FIT_HALF_WINDOW_S, windowSlope } from "./kinematics.ts";
import type { TimelineAircraft, TimelineChannel, TimelineTrack } from "./timeline.ts";

/**
 * A readsb `trace_full_<icao>.json`, the per-aircraft history that adsb.lol,
 * ADS-B Exchange and other tar1090 networks keep. Each row of `trace` is
 * [seconds after `timestamp`, lat, lon, baro altitude ft | "ground" | null,
 * ground speed kt, track deg, flags, vertical rate ft/min, details | null,
 * source, GNSS altitude ft, GNSS vertical rate ft/min, IAS kt, roll deg].
 */
export interface ReadsbTrace {
  icao: string;
  r?: string;
  t?: string;
  desc?: string;
  timestamp: number;
  trace: unknown[][];
}

/** Row flags, from readsb's README-json. */
const FLAG_STALE = 1;
const FLAG_RATE_IS_GEOMETRIC = 4;
const FLAG_ALTITUDE_IS_GEOMETRIC = 8;

/** ADS-B carries vertical rate in 64 ft/min steps up to this magnitude; a larger rate reads as this. */
export const ADSB_VERTICAL_RATE_LIMIT_FPM = 32640;

/** A pressure altitude that stays put while GNSS altitude moves this far is a held value, not a report. */
const STALE_BARO_GEOM_CHANGE_FT = 500;

export const READSB_CHANNELS: Record<string, TimelineChannel> = {
  latDeg: { label: "Latitude", unit: "deg" },
  lonDeg: { label: "Longitude", unit: "deg", interpolation: "angle" },
  altBaroFt: {
    label: "Pressure altitude", unit: "ft",
    note: "Barometric altitude as the transponder reported it, referenced to 29.92 inHg: the altitude air traffic control sees. "
      + `readsb repeats the last value when messages stop carrying one; a value repeated while GNSS altitude moves more than ${STALE_BARO_GEOM_CHANGE_FT} ft is left out after its first report.`,
  },
  altGeomFt: {
    label: "GNSS altitude", unit: "ft",
    note: "Satellite-navigation height as the transponder reported it.",
  },
  groundSpeedKt: { label: "Ground speed", unit: "kt" },
  trackDeg: { label: "Track", unit: "deg", interpolation: "angle", note: "Direction of travel over the ground, true north." },
  baroRateFpm: {
    label: "Vertical rate (reported, barometric)", unit: "ft/min",
    note: `ADS-B cannot carry a rate beyond ±${ADSB_VERTICAL_RATE_LIMIT_FPM.toLocaleString("en-US")} ft/min; faster reads as that limit.`,
  },
  geomRateFpm: {
    label: "Vertical rate (reported, GNSS)", unit: "ft/min",
    note: `ADS-B cannot carry a rate beyond ±${ADSB_VERTICAL_RATE_LIMIT_FPM.toLocaleString("en-US")} ft/min; faster reads as that limit.`,
  },
  vsFromGeomFpm: {
    label: "Vertical rate (from GNSS altitude)", unit: "ft/min",
    derived: `Least-squares slope of GNSS altitude over ±${RATE_FIT_HALF_WINDOW_S} s, or out to the next sample each side where samples are further apart. Not limited the way the reported rate is, but noisier: GNSS altitude comes in 25 ft steps.`,
  },
  onGround: { label: "On the ground", unit: "bool", interpolation: "step" },
  spi: {
    label: "IDENT (SPI)", unit: "bool", interpolation: "step",
    note: "The transponder's Special Position Identification flag, set for about 18 s when IDENT is pressed. Carried on detail rows and held until the next one.",
  },
  nic: {
    label: "Position integrity (NIC)", unit: "count", interpolation: "step",
    note: "Navigation Integrity Category, 0 (unknown) to 11. Carried on detail rows and held until the next one.",
  },
};

export interface ReadsbTrackOptions {
  id: string;
  label: string;
  sources: string[];
  /** Keep rows at or after this instant, in seconds since 1970. */
  fromEpochS?: number;
  /** Keep rows at or before this instant, in seconds since 1970. */
  toEpochS?: number;
  /** t = 0 of the timeline, in seconds since 1970. Defaults to the first kept row, rounded down to the second. */
  startEpochS?: number;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number | null, digits: number): number | null {
  if (value === null) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Nulls the repeats of a pressure altitude that stays the same while GNSS
 * altitude changes by more than STALE_BARO_GEOM_CHANGE_FT: readsb holds the
 * last barometric value once the transponder stops sending one.
 */
export function dropHeldBaroAltitude(baro: (number | null)[], geom: readonly (number | null)[]): (number | null)[] {
  const result = baro.slice();
  let runStart = 0;
  for (let i = 1; i <= baro.length; i++) {
    if (i < baro.length && baro[i] !== null && baro[i] === baro[runStart]) continue;
    const runEnd = i - 1;
    if (runEnd > runStart && baro[runStart] !== null) {
      const known = geom.slice(runStart, runEnd + 1).filter((value): value is number => value !== null);
      const moved = known.length > 1 ? Math.max(...known) - Math.min(...known) : 0;
      if (moved > STALE_BARO_GEOM_CHANGE_FT) for (let j = runStart + 1; j <= runEnd; j++) result[j] = null;
    }
    runStart = i;
  }
  return result;
}

/** Whether a parsed JSON file looks like a readsb trace. */
export function isReadsbTrace(value: unknown): value is ReadsbTrace {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.icao === "string" && typeof record.timestamp === "number" && Array.isArray(record.trace);
}

/** The aircraft a trace names, from the network's aircraft database. */
export function readsbAircraft(trace: ReadsbTrace): TimelineAircraft {
  return {
    ...(trace.r ? { registration: trace.r } : {}),
    ...(trace.t ? { type: trace.t } : {}),
    ...(trace.desc ? { description: trace.desc } : {}),
    icao24: trace.icao.replace(/^~/, ""),
  };
}

/** Converts a readsb trace into one timeline track. */
export function readsbTraceToTrack(trace: ReadsbTrace, options: ReadsbTrackOptions): { track: TimelineTrack; startEpochS: number } {
  if (typeof trace.timestamp !== "number" || !Array.isArray(trace.trace)) throw new Error("This is not a readsb trace: it needs `timestamp` and `trace`.");
  const rows = trace.trace.filter(row => {
    const at = trace.timestamp + (row[0] as number);
    if (options.fromEpochS !== undefined && at < options.fromEpochS) return false;
    if (options.toEpochS !== undefined && at > options.toEpochS) return false;
    return true;
  });
  if (rows.length === 0) throw new Error("No trace rows fall in the requested time.");
  const startEpochS = options.startEpochS ?? Math.floor(trace.timestamp + (rows[0]![0] as number));

  const columns: Record<string, (number | null)[]> = {};
  for (const id of Object.keys(READSB_CHANNELS)) columns[id] = [];
  const t: number[] = [];
  let spi: number | null = null;
  let nic: number | null = null;
  for (const row of rows) {
    // Details come every few rows; the flags they carry hold until the next.
    const details = row[8];
    if (details && typeof details === "object") {
      const record = details as Record<string, unknown>;
      if (typeof record.spi === "number") spi = record.spi ? 1 : 0;
      if (typeof record.nic === "number") nic = record.nic;
    }
    const flags = numberOrNull(row[6]) ?? 0;
    // A stale row repeats an old position.
    if (flags & FLAG_STALE) continue;
    const lat = numberOrNull(row[1]);
    const lon = numberOrNull(row[2]);
    if (lat === null || lon === null) continue;
    const onGround = row[3] === "ground";
    const altitude = numberOrNull(row[3]);
    const rate = numberOrNull(row[7]);
    t.push(round(trace.timestamp + (row[0] as number) - startEpochS, 2)!);
    columns.latDeg!.push(round(lat, 6));
    columns.lonDeg!.push(round(lon, 6));
    columns.altBaroFt!.push(flags & FLAG_ALTITUDE_IS_GEOMETRIC ? null : altitude);
    columns.altGeomFt!.push(numberOrNull(row[10]) ?? (flags & FLAG_ALTITUDE_IS_GEOMETRIC ? altitude : null));
    columns.groundSpeedKt!.push(round(numberOrNull(row[4]), 1));
    columns.trackDeg!.push(round(numberOrNull(row[5]), 1));
    columns.baroRateFpm!.push(flags & FLAG_RATE_IS_GEOMETRIC ? null : rate);
    columns.geomRateFpm!.push(numberOrNull(row[11]) ?? (flags & FLAG_RATE_IS_GEOMETRIC ? rate : null));
    columns.vsFromGeomFpm!.push(null);
    columns.onGround!.push(onGround ? 1 : 0);
    columns.spi!.push(spi);
    columns.nic!.push(nic);
  }
  columns.altBaroFt = dropHeldBaroAltitude(columns.altBaroFt!, columns.altGeomFt!);
  const airborneGeom = columns.altGeomFt!.map((value, i) => (columns.onGround![i] ? null : value));
  columns.vsFromGeomFpm = windowSlope(t, airborneGeom).map(slope => (slope === null ? null : Math.round(slope * 60)));
  return {
    startEpochS,
    track: {
      id: options.id,
      label: options.label,
      kind: "observed",
      aircraft: readsbAircraft(trace),
      sources: options.sources,
      channels: READSB_CHANNELS,
      samples: { t, ...columns } as TimelineTrack["samples"],
    },
  };
}
