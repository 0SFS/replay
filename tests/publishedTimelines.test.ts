import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatTimelineJson, modelFromDefinition } from "../scripts/build-timeline.ts";
import { parseFlightTimeline, timelineSpan } from "../src/timeline.ts";
import { isTimelineId, parseTimelineIndex } from "../src/timelineIndex.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "public", "replay", "timelines");
const files = readdirSync(dir).filter(name => name.endsWith(".json") && name !== "index.json");
const read = (name: string): unknown => JSON.parse(readFileSync(path.join(dir, name), "utf8"));

describe("published timelines", () => {
  it("lists every timeline, and only those", () => {
    const index = parseTimelineIndex(read("index.json"));
    expect(index.map(entry => `${entry.id}.json`).sort()).toEqual([...files].sort());
  });

  it.each(files)("%s is a timeline whose moments fall within its tracks", name => {
    const timeline = parseFlightTimeline(read(name));
    expect(`${timeline.id}.json`).toBe(name);
    expect(isTimelineId(timeline.id)).toBe(true);
    const span = timelineSpan(timeline);
    for (const event of timeline.events) {
      expect(event.t, event.title).toBeGreaterThanOrEqual(span.start);
      expect(event.t, event.title).toBeLessThanOrEqual(span.end);
    }
    if (timeline.highlight) {
      expect(timeline.highlight.start).toBeLessThan(timeline.highlight.end);
      expect(timeline.highlight.start).toBeGreaterThanOrEqual(span.start);
      expect(timeline.highlight.end).toBeLessThanOrEqual(span.end);
    }
    expect(timeline.sources.length).toBeGreaterThan(0);
    expect(timeline.license).toBeDefined();
  });

  it.each(files)("%s credits each model it draws", name => {
    for (const track of parseFlightTimeline(read(name)).tracks) {
      const model = track.aircraft?.model;
      if (!model) continue;
      expect(model.credit?.licence, track.id).toBeTruthy();
      expect(model.credit?.artist, track.id).toBeTruthy();
    }
  });

  it.each(files)("%s credits its sound, and each radio moment is a line of its transcript", name => {
    const timeline = parseFlightTimeline(read(name));
    const span = timelineSpan(timeline);
    const sourceIds = new Set(timeline.sources.map(source => source.id));
    const starts = (timeline.audio ?? []).flatMap(audio => (audio.transcript ?? []).map(line => audio.t + line.at));
    for (const audio of timeline.audio ?? []) {
      expect(audio.sources.length, audio.id).toBeGreaterThan(0);
      for (const id of audio.sources) expect(sourceIds.has(id), `${audio.id} names ${id}`).toBe(true);
      expect(audio.sources.some(id => timeline.sources.find(source => source.id === id)?.license), `${audio.id} has a licence`).toBe(true);
      expect(audio.t).toBeGreaterThanOrEqual(span.start);
      expect(audio.t + audio.duration).toBeLessThanOrEqual(span.end);
    }
    for (const event of timeline.events.filter(candidate => candidate.kind === "radio")) {
      expect(starts.some(start => Math.abs(start - event.t) < 0.01), event.title).toBe(true);
    }
  });

  it("keeps each sample column on one line", () => {
    for (const name of files) {
      const text = readFileSync(path.join(dir, name), "utf8");
      expect(text).toBe(formatTimelineJson(JSON.parse(text)) + "\n");
    }
  });
});

describe("build-timeline", () => {
  it("formats objects indented and plain arrays on one line", () => {
    expect(formatTimelineJson({ a: [1, null, 2], b: { c: "d" }, e: [{ f: 1 }], g: undefined })).toBe(
      '{\n  "a": [1,null,2],\n  "b": {\n    "c": "d"\n  },\n  "e": [\n    {\n      "f": 1\n    }\n  ]\n}',
    );
  });

  it("takes a model, its turn, offset and credit from an aircraft definition", () => {
    const definition = {
      label: "Learjet 60", modelYawRad: Math.PI, modelOffset: { x: 0, y: -1, z: 0 },
      lods: [{ id: "hd", path: "aircraft/learjet-60/Learjet_60_HD.glb", credit: { artist: "OUTPISTON", licence: "CC BY-NC-SA 4.0" } }],
    };
    expect(modelFromDefinition(definition, "hd")).toEqual({
      url: "aircraft/learjet-60/Learjet_60_HD.glb", label: "Learjet 60", yawRad: Math.PI, offset: { x: 0, y: -1, z: 0 },
      credit: { artist: "OUTPISTON", licence: "CC BY-NC-SA 4.0" },
    });
    expect(() => modelFromDefinition(definition, "lod0")).toThrow('Learjet 60 has no "lod0" model; it has hd.');
  });

  it("names the model file of each published timeline where the fly app serves it", () => {
    for (const name of files) {
      for (const track of parseFlightTimeline(read(name)).tracks) {
        const url = track.aircraft?.model?.url;
        if (!url) continue;
        // Packages serve public/<url>; the fly app links them into its own public/.
        const served = ["../Learjet-60", "."].some(pkg => existsSync(path.join(root, pkg, "public", url)));
        expect(served, url).toBe(true);
      }
    }
  });
});
