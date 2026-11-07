import { describe, expect, it } from "vitest";
import { extrapolateTrack } from "../src/extrapolate.ts";
import type { TimelineTrack } from "../src/timeline.ts";

/** Two samples of a descent at 6,000 ft/min, 120 kt eastbound, with IDENT on. */
function descent(overrides: Record<string, (number | null)[]> = {}): TimelineTrack {
  return {
    id: "a", label: "A", kind: "observed", sources: [],
    channels: {
      latDeg: { label: "Latitude", unit: "deg" },
      lonDeg: { label: "Longitude", unit: "deg", interpolation: "angle" },
      altGeomFt: { label: "GNSS altitude", unit: "ft" },
      groundSpeedKt: { label: "Ground speed", unit: "kt" },
      trackDeg: { label: "Track", unit: "deg", interpolation: "angle" },
      vsFromGeomFpm: { label: "Vertical rate", unit: "ft/min" },
      turnRateDegS: { label: "Turn rate", unit: "deg/s" },
      spi: { label: "IDENT", unit: "bool", interpolation: "step" },
    },
    samples: {
      t: [0, 1], latDeg: [0, 0], lonDeg: [0, 0.0006], altGeomFt: [1100, 1000], groundSpeedKt: [120, 120],
      trackDeg: [90, 90], vsFromGeomFpm: [-6000, -6000], turnRateDegS: [0, 0], spi: [1, 1], ...overrides,
    },
  };
}

describe("extrapolateTrack", () => {
  it("continues the last report's speed, track and descent to the altitude asked for, and marks what it added", () => {
    const track = extrapolateTrack(descent(), { toAltGeomFt: 0, stepS: 1 });
    const { samples } = track;
    expect(samples.t).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(samples.altGeomFt!.slice(-3)).toEqual([200, 100, 0]);
    // 120 kt for 10 s is 617 m east.
    expect((samples.lonDeg!.at(-1)! - 0.0006) * 111_195).toBeCloseTo(617.3, 0);
    expect(samples.latDeg!.at(-1)).toBe(0);
    expect(samples.groundSpeedKt!.at(-1)).toBe(120);
    expect(samples.vsFromGeomFpm!.at(-1)).toBe(-6000);
    expect(samples.spi!.slice(-2)).toEqual([null, null]);
    expect(samples.extrapolated).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(track.channels.extrapolated).toMatchObject({ unit: "bool", interpolation: "step" });
  });

  it("follows the turn the aircraft was in", () => {
    const { samples } = extrapolateTrack(descent({ turnRateDegS: [9, 9] }), { toAltGeomFt: 0 });
    expect(samples.trackDeg!.at(-1)).toBe(180);
    // A quarter circle at 9°/s and 120 kt: as far south as east, 393 m each.
    expect(samples.latDeg!.at(-1)! * 111_195).toBeCloseTo(-393, -1);
    expect((samples.lonDeg!.at(-1)! - 0.0006) * 111_195).toBeCloseTo(393, -1);
  });

  it("ends exactly at the altitude, between steps", () => {
    const { samples } = extrapolateTrack(descent(), { toAltGeomFt: 960 });
    expect(samples.t.slice(2)).toEqual([1.1, 1.2, 1.3, 1.4]);
    expect(samples.altGeomFt!.slice(2)).toEqual([990, 980, 970, 960]);
  });

  it("will not continue away from the altitude, too far, or without what it needs", () => {
    expect(() => extrapolateTrack(descent(), { toAltGeomFt: 2000 })).toThrow(/not heading for 2000 ft/);
    expect(() => extrapolateTrack(descent(), { toAltGeomFt: -10_000 })).toThrow(/more than the 30 s/);
    expect(() => extrapolateTrack(descent({ trackDeg: [90, null] }), { toAltGeomFt: 0 })).toThrow(/no trackDeg/);
  });
});
