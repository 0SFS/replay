import { describe, expect, it } from "vitest";
import { addAttitudeEstimates, unwrapDegrees, windowFit, windowSlope } from "../src/kinematics.ts";
import { readsbTraceToTrack } from "../src/readsbTrace.ts";
import { syntheticTrace } from "./fixtures.ts";

describe("windowSlope", () => {
  it("fits the slope around each sample", () => {
    const t = [0, 1, 2, 3, 4, 5];
    const slopes = windowSlope(t, t.map(time => 100 + time * 20));
    for (const slope of slopes) expect(slope).toBeCloseTo(20);
  });

  it("reaches the next sample where samples are sparse, but not across a long gap", () => {
    expect(windowSlope([0, 20], [0, 400])).toEqual([20, 20]);
    expect(windowSlope([0, 100], [0, 400])).toEqual([null, null]);
  });

  it("gives nothing where a sample has no value", () => {
    expect(windowSlope([0, 1, 2], [0, null, 40])).toEqual([20, null, 20]);
  });
});

describe("windowFit", () => {
  it("gives the fitted line's value at each sample, which smooths steps out", () => {
    const fits = windowFit([0, 1, 2, 3, 4], [0, 0, 25, 25, 50]);
    expect(fits[2]!.value).toBeCloseTo(20);
    expect(fits[2]!.slope).toBeCloseTo(12.5);
    expect(windowFit([0, 1], [5, null])).toEqual([null, null]);
  });
});

describe("unwrapDegrees", () => {
  it("keeps a turn through north continuous", () => {
    expect(unwrapDegrees([350, 359, 1, null, 10])).toEqual([350, 359, 361, null, 370]);
    expect(unwrapDegrees([10, 350])).toEqual([10, -10]);
  });
});

describe("addAttitudeEstimates", () => {
  const track = addAttitudeEstimates(readsbTraceToTrack(syntheticTrace(), { id: "a", label: "a", sources: [] }).track);

  it("estimates the flight-path angle from the climb and the speed", () => {
    // 1,200 ft/min at 200 kt.
    expect(track.samples.pitchEstDeg![30]).toBeCloseTo(Math.atan2(20, 200 * 6076.12 / 3600) * 180 / Math.PI, 1);
  });

  it("estimates the bank of a coordinated turn", () => {
    expect(track.samples.turnRateDegS![30]).toBeCloseTo(3, 5);
    // A 3°/s turn at 200 kt banks about 29°.
    expect(track.samples.rollEstDeg![30]).toBeGreaterThan(28);
    expect(track.samples.rollEstDeg![30]).toBeLessThan(30);
  });

  it("draws the aircraft level on the ground", () => {
    expect(track.samples.pitchEstDeg![0]).toBe(0);
    expect(track.samples.rollEstDeg![0]).toBe(0);
  });

  it("says the estimates are derived", () => {
    expect(track.channels.rollEstDeg!.derived).toMatch(/coordinated turn/);
  });
});
