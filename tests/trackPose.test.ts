import { describe, expect, it } from "vitest";
import { createTrackPoser, drawnAltitudeFt, fillGaps, poseView } from "../src/trackPose.ts";
import { straightTrack } from "./fixtures.ts";

describe("fillGaps", () => {
  it("fills each gap along a straight line in time, and the ends from the nearest value", () => {
    expect(fillGaps([0, 1, 2, 3, 5, 6], [null, 5, null, null, 9, null])).toEqual([5, 5, 6, 7, 9, 9]);
    expect(fillGaps([0, 1], [null, null])).toEqual([null, null]);
  });
});

describe("drawnAltitudeFt", () => {
  it("takes out the 25 ft steps altitude is reported in, but not a climb", () => {
    const t = Array.from({ length: 41 }, (_, i) => i / 2);
    const reported = t.map(time => Math.round((1000 + 10 * time) / 25) * 25);
    const drawn = drawnAltitudeFt(t, reported);
    // Away from the ends, where the window is one-sided, the drawn line keeps within a few feet of the real one.
    for (let i = 4; i < t.length - 4; i++) expect(Math.abs(drawn[i]! - (1000 + 10 * t[i]!))).toBeLessThan(5);
    expect(drawnAltitudeFt([0, 1, 2], [null, 7, null])).toEqual([7, 7, 7]);
  });

  it("draws extrapolated samples as they are, so a track continued to the ground ends on it", () => {
    const drawn = drawnAltitudeFt([0, 1, 2, 3, 4], [1000, 1025, 1000, 500, 0], [0, 0, 0, 1, 1]);
    expect(drawn.slice(3)).toEqual([500, 0]);
    expect(drawn[1]).not.toBe(1025);
  });
});

describe("createTrackPoser", () => {
  it("places the aircraft by GNSS altitude, filling its gaps, in metres", () => {
    const poser = createTrackPoser(straightTrack());
    // GNSS altitude is missing at 10 s; a straight line between the reports each side stands in.
    expect(poser.altitudeFtColumn).toEqual([1000, 2000, 3000]);
    expect(poser.poseAt(0)!.altMeters).toBeCloseTo(304.8);
  });

  it("uses pressure altitude where a track has no GNSS altitude", () => {
    const track = straightTrack();
    delete track.channels.altGeomFt;
    expect(createTrackPoser(track).altitudeFtColumn).toEqual([900, 1900, 2900]);
  });

  it("turns the aircraft along its track, estimated unless pitch and bank were recorded", () => {
    const pose = createTrackPoser(straightTrack()).poseAt(5)!;
    expect(pose.headingRad).toBeCloseTo(0);
    expect(pose.pitchRad).toBe(0);
    expect(pose.attitude).toBe("estimated");
    const recorded = straightTrack();
    recorded.channels.pitchDeg = { label: "Pitch", unit: "deg" };
    recorded.channels.rollDeg = { label: "Bank", unit: "deg" };
    recorded.samples.pitchDeg = [10, 10, 10];
    recorded.samples.rollDeg = [-30, -30, -30];
    const flown = createTrackPoser(recorded).poseAt(5)!;
    expect(flown.attitude).toBe("recorded");
    expect(flown.rollRad).toBeCloseTo(-Math.PI / 6);
  });

  it("gives where each sample was reported, at the altitude reported, and no report where it was extrapolated", () => {
    const track = straightTrack();
    track.channels.extrapolated = { label: "Extrapolated", unit: "bool", interpolation: "step" };
    track.samples.extrapolated = [0, 0, 1];
    const poser = createTrackPoser(track);
    expect(poser.reportAt(0)).toEqual({ latDeg: 10, lonDeg: 179, altMeters: 1000 * 0.3048 });
    // No altitude was reported at 10 s: the path's stands in.
    expect(poser.reportAt(1)!.altMeters).toBeCloseTo(2000 * 0.3048);
    expect(poser.reportAt(2)).toBeNull();
  });

  it("gives no pose outside the track", () => {
    expect(createTrackPoser(straightTrack()).poseAt(21)).toBeNull();
  });
});

describe("poseView", () => {
  it("loads detail for the height, within the flight's limits", () => {
    const pose = createTrackPoser(straightTrack()).poseAt(0)!;
    expect(poseView(pose)).toMatchObject({ latDeg: 10, lonDeg: 179 });
    expect(poseView(pose).zoomMeters).toBeCloseTo(457.2);
    expect(poseView({ ...pose, altMeters: 0 }).zoomMeters).toBe(250);
    expect(poseView({ ...pose, altMeters: 12_000 }).zoomMeters).toBe(12_000);
    expect(poseView({ ...pose, headingRad: Math.PI }).headingDeg).toBeCloseTo(180);
  });
});
