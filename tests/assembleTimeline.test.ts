import { describe, expect, it } from "vitest";
import { assembleTimeline, timelineFromJson, type TimelineSpec } from "../src/assembleTimeline.ts";
import { TRACK_INPUTS, detectTrackInput, trackInput } from "../src/trackInputs.ts";
import { minimalTimeline, syntheticTrace, TRACE_EPOCH_S } from "./fixtures.ts";

const iso = (epochS: number) => new Date(epochS * 1000).toISOString();

const spec: TimelineSpec = {
  id: "synthetic",
  title: "Synthetic climb",
  timeZone: "America/New_York",
  highlight: { start: iso(TRACE_EPOCH_S + 10), end: iso(TRACE_EPOCH_S + 50) },
  sources: [{ id: "test", name: "Test", url: "https://example.test/" }],
  tracks: [{ id: "N722BD", label: "N722BD", format: "readsb", sources: ["test"], from: iso(TRACE_EPOCH_S + 2), aircraft: { description: "Bombardier Learjet 60", model: { url: "aircraft/learjet-60/Learjet_60_HD.glb", label: "Learjet 60" } } }],
  events: [{ at: iso(TRACE_EPOCH_S + 30), title: "IDENT", kind: "observation" }],
};

describe("assembleTimeline", () => {
  it("starts at the first kept sample and puts every time on that clock", () => {
    const timeline = assembleTimeline(spec, [syntheticTrace()]);
    expect(timeline.start).toBe(iso(TRACE_EPOCH_S + 2));
    expect(timeline.tracks[0]!.samples.t[0]).toBe(0);
    expect(timeline.highlight).toEqual({ start: 8, end: 48 });
    expect(timeline.events).toEqual([{ t: 28, title: "IDENT", kind: "observation" }]);
  });

  it("adds the attitude estimates and lays the spec's aircraft over the recording's", () => {
    const track = assembleTimeline(spec, [syntheticTrace()]).tracks[0]!;
    expect(track.channels.rollEstDeg).toBeDefined();
    expect(track.aircraft).toMatchObject({ registration: "N722BD", type: "LJ60", description: "Bombardier Learjet 60", model: { label: "Learjet 60" } });
  });

  it("continues a track to the ground a spec gives, from sea level and the geoid", () => {
    // The synthetic flight ends at 2,080 ft, climbing 1,200 ft/min: 2,200 ft is 6 s on.
    const tracks = [{ ...spec.tracks[0]!, extrapolate: { groundFt: 2230, geoidFt: -30 } }];
    const track = assembleTimeline({ ...spec, tracks }, [syntheticTrace()]).tracks[0]!;
    expect(track.samples.t.at(-1)).toBeCloseTo(63, 1);
    expect(track.samples.altGeomFt!.at(-1)).toBe(2200);
    expect(track.samples.extrapolated!.at(-1)).toBe(1);
  });

  it("keeps a start the spec gives", () => {
    const timeline = assembleTimeline({ ...spec, start: iso(TRACE_EPOCH_S - 60) }, [syntheticTrace()]);
    expect(timeline.tracks[0]!.samples.t[0]).toBe(62);
  });

  it("needs one recording per track and a known format", () => {
    expect(() => assembleTimeline(spec, [])).toThrow(/one recording per track/);
    expect(() => assembleTimeline({ ...spec, tracks: [{ ...spec.tracks[0]!, format: "opensky" }] }, [syntheticTrace()])).toThrow(/No track input reads "opensky"; known: readsb/);
  });
});

describe("timelineFromJson", () => {
  it("opens a timeline as it is", () => {
    expect(timelineFromJson(JSON.parse(JSON.stringify(minimalTimeline())), "test.json").id).toBe("test");
  });

  it("opens a recording as a one-track timeline named for the aircraft", () => {
    const timeline = timelineFromJson(syntheticTrace(), "trace_full_a9ab17.json");
    expect(timeline.id).toBe("trace_full_a9ab17");
    expect(timeline.title).toBe("N722BD, BOMBARDIER LEARJET 60");
    expect(timeline.tracks).toHaveLength(1);
    expect(timeline.sources[0]!.note).toMatch(/Opened from this device/);
  });

  it("says when a file is neither", () => {
    expect(() => timelineFromJson({ hello: "world" }, "notes.json")).toThrow("notes.json is neither a flight timeline nor a recording this replay reads.");
  });
});

describe("track inputs", () => {
  it("each input has a distinct format and recognizes its own files", () => {
    expect(new Set(TRACK_INPUTS.map(input => input.format)).size).toBe(TRACK_INPUTS.length);
    expect(detectTrackInput(syntheticTrace())).toBe(trackInput("readsb"));
    expect(detectTrackInput([])).toBeNull();
  });
});
