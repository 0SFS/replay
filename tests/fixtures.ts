import type { ReadsbTrace } from "../src/readsbTrace.ts";
import { TIMELINE_FORMAT, TIMELINE_VERSION, type FlightTimeline, type TimelineTrack } from "../src/timeline.ts";

export const TRACE_EPOCH_S = 1_793_554_320;

/**
 * A minute of an invented flight as readsb writes it: five seconds on the
 * ground, then a climbing right turn at 3°/s, 200 kt and 1,200 ft/min, with
 * IDENT pressed at 30 s and one stale row.
 */
export function syntheticTrace(): ReadsbTrace {
  const trace: unknown[][] = [];
  for (let i = 0; i < 60; i++) {
    const airborne = i >= 5;
    const geom = airborne ? 1000 + (i - 5) * 20 : 25;
    const details = i === 0 ? { spi: 0, nic: 8 } : i === 30 ? { spi: 1, nic: 8 } : null;
    trace.push([
      i, 26.68 + i * 0.0005, -80.1 + i * 0.0005, airborne ? geom - 100 : "ground",
      airborne ? 200 : 10, airborne ? 90 + (i - 5) * 3 : 90, 0, airborne ? 1216 : 0,
      details, "adsb_icao", airborne ? geom : null, airborne ? 1216 : null, null, null,
    ]);
    // readsb repeats a position as stale when nothing new came.
    if (i === 40) trace.push([i + 0.5, 0, 0, 0, 0, 0, 1, 0, null, "adsb_icao", 0, 0, null, null]);
  }
  return { icao: "a9ab17", r: "N722BD", t: "LJ60", desc: "BOMBARDIER LEARJET 60", timestamp: TRACE_EPOCH_S, trace };
}

export function straightTrack(overrides: Partial<TimelineTrack> = {}): TimelineTrack {
  return {
    id: "a",
    label: "A",
    kind: "observed",
    sources: [],
    channels: {
      latDeg: { label: "Latitude", unit: "deg" },
      lonDeg: { label: "Longitude", unit: "deg", interpolation: "angle" },
      altGeomFt: { label: "GNSS altitude", unit: "ft" },
      altBaroFt: { label: "Pressure altitude", unit: "ft" },
      trackDeg: { label: "Track", unit: "deg", interpolation: "angle" },
      spi: { label: "IDENT", unit: "bool", interpolation: "step" },
    },
    samples: {
      t: [0, 10, 20],
      latDeg: [10, 11, 12],
      lonDeg: [179, -179, -177],
      altGeomFt: [1000, null, 3000],
      altBaroFt: [900, 1900, 2900],
      trackDeg: [350, 10, 30],
      spi: [0, 1, 0],
    },
    ...overrides,
  };
}

export function minimalTimeline(overrides: Partial<FlightTimeline> = {}): FlightTimeline {
  return {
    format: TIMELINE_FORMAT,
    version: TIMELINE_VERSION,
    id: "test",
    title: "Test flight",
    start: "2026-11-01T17:00:00.000Z",
    timeZone: "America/New_York",
    highlight: { start: 5, end: 15 },
    sources: [],
    tracks: [straightTrack()],
    events: [{ t: 12, title: "Later", kind: "observation" }, { t: 2, title: "Earlier", kind: "phase" }],
    ...overrides,
  };
}
