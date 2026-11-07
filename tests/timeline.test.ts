import { describe, expect, it } from "vitest";
import { lastKnown, parseFlightTimeline, sampleIndexAt, sampleTrack, timelineEpochMs, timelineSpan, TimelineError } from "../src/timeline.ts";
import { minimalTimeline, straightTrack } from "./fixtures.ts";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("parseFlightTimeline", () => {
  it("accepts a timeline and sorts its events by time", () => {
    const timeline = parseFlightTimeline(clone(minimalTimeline()));
    expect(timeline.events.map(event => event.title)).toEqual(["Earlier", "Later"]);
    expect(timeline.highlight).toEqual({ start: 5, end: 15 });
  });

  it.each([
    ["another format", (value: Record<string, unknown>) => { value.format = "kml"; }, /not a flight timeline/],
    ["another version", (value: Record<string, unknown>) => { value.version = 2; }, /version 2/],
    ["no tracks", (value: Record<string, unknown>) => { value.tracks = []; }, /at least one track/],
    ["a bad start", (value: Record<string, unknown>) => { value.start = "yesterday"; }, /ISO 8601/],
  ])("rejects %s", (_name, change, message) => {
    const value = clone(minimalTimeline()) as unknown as Record<string, unknown>;
    change(value);
    expect(() => parseFlightTimeline(value)).toThrow(message);
  });

  it("says which sample is wrong", () => {
    const decreasing = clone(minimalTimeline());
    decreasing.tracks[0]!.samples.t = [0, 20, 10];
    expect(() => parseFlightTimeline(decreasing)).toThrow("tracks[0].samples.t decreases at index 2.");
    const short = clone(minimalTimeline());
    short.tracks[0]!.samples.altBaroFt = [1, 2];
    expect(() => parseFlightTimeline(short)).toThrow(/altBaroFt must have one value per time \(3\)/);
    const position = clone(minimalTimeline());
    delete position.tracks[0]!.channels.lonDeg;
    expect(() => parseFlightTimeline(position)).toThrow(TimelineError);
  });

  it("checks that sound says how it was aligned, and that its transcript lies within it", () => {
    const audio = {
      id: "atc", label: "Center", kind: "radio", files: [{ url: "atc.mp3", type: "audio/mpeg" }], sources: [],
      t: 2, duration: 10, alignment: { method: "By hand", uncertaintyS: 1 }, transcript: [{ at: 1, end: 3, text: "Roger" }],
    };
    expect(parseFlightTimeline({ ...clone(minimalTimeline()), audio: [audio] }).audio?.[0]?.t).toBe(2);
    expect(() => parseFlightTimeline({ ...clone(minimalTimeline()), audio: [{ ...audio, alignment: undefined }] }))
      .toThrow("audio[0].alignment must say how the recording was aligned.");
    expect(() => parseFlightTimeline({ ...clone(minimalTimeline()), audio: [{ ...audio, transcript: [{ at: 9, end: 11, text: "Roger" }] }] }))
      .toThrow("audio[0].transcript[0] must lie within the recording, from at to end.");
    expect(() => parseFlightTimeline({ ...clone(minimalTimeline()), audio: [{ ...audio, files: [] }] })).toThrow(/at least one file/);
  });

  it("checks a track's model names a file and a label", () => {
    const value = clone(minimalTimeline());
    value.tracks[0]!.aircraft = { model: { url: "", label: "Learjet 60" } };
    expect(() => parseFlightTimeline(value)).toThrow("tracks[0].aircraft.model.url must be a non-empty string.");
  });
});

describe("sampling", () => {
  it("finds the sample at or before a time", () => {
    const t = [0, 10, 20];
    expect([-1, 0, 9.9, 10, 25].map(time => sampleIndexAt(t, time))).toEqual([-1, 0, 0, 1, 2]);
    expect(sampleIndexAt([], 0)).toBe(-1);
  });

  it("interpolates linearly, the short way round for angles, and holds steps", () => {
    const sample = sampleTrack(straightTrack(), 5)!;
    expect(sample.index).toBe(0);
    expect(sample.values.latDeg).toBeCloseTo(10.5);
    expect(sample.values.altBaroFt).toBeCloseTo(1400);
    expect(sample.values.trackDeg).toBeCloseTo(0);
    expect(Math.abs(sample.values.lonDeg!)).toBeCloseTo(180);
    expect(sample.values.spi).toBe(0);
    expect(sampleTrack(straightTrack(), 15)!.values.spi).toBe(1);
  });

  it("takes the nearer neighbour where the other has no value", () => {
    expect(sampleTrack(straightTrack(), 13)!.values.altGeomFt).toBeNull();
    expect(sampleTrack(straightTrack(), 17)!.values.altGeomFt).toBe(3000);
  });

  it("gives nothing outside the track", () => {
    expect(sampleTrack(straightTrack(), -1)).toBeNull();
    expect(sampleTrack(straightTrack(), 20.01)).toBeNull();
    expect(sampleTrack(straightTrack(), 20)!.values.latDeg).toBe(12);
  });

  it("finds the last value of a channel before a sample", () => {
    expect(lastKnown(straightTrack(), "altGeomFt", 1)).toEqual({ t: 0, value: 1000 });
    expect(lastKnown(straightTrack(), "missing", 1)).toBeNull();
  });

  it("spans every track and turns times into instants", () => {
    const timeline = minimalTimeline({ tracks: [straightTrack(), straightTrack({ id: "b", samples: { ...straightTrack().samples, t: [-5, 0, 30] } })] });
    expect(timelineSpan(timeline)).toEqual({ start: -5, end: 30 });
    expect(new Date(timelineEpochMs(timeline, 90)).toISOString()).toBe("2026-11-01T17:01:30.000Z");
  });
});
