import { describe, expect, it } from "vitest";
import { isTimelineId, parseTimelineIndex, timelineIndexUrl, timelineUrl } from "../src/timelineIndex.ts";

describe("timeline index", () => {
  it("names files under the site's base", () => {
    expect(timelineUrl("/", "N722BD-2026-11-01")).toBe("/replay/timelines/N722BD-2026-11-01.json");
    expect(timelineIndexUrl("/repo/")).toBe("/repo/replay/timelines/index.json");
  });

  it("takes only ids that are one path segment", () => {
    expect(isTimelineId("N722BD-2026-11-01")).toBe(true);
    for (const id of ["", "../x", "a/b", ".hidden", "a b"]) expect(isTimelineId(id), id).toBe(false);
    expect(() => timelineUrl("/", "../secrets")).toThrow(/not a timeline id/);
  });

  it("leaves out entries that are not timelines", () => {
    expect(parseTimelineIndex({ timelines: [
      { id: "ok", title: "OK", start: "2026-11-01T00:00:00Z", subtitle: "s" },
      { id: "../bad", title: "Bad", start: "2026-11-01T00:00:00Z" },
      { id: "no-title", start: "2026-11-01T00:00:00Z" },
      null,
    ] })).toEqual([{ id: "ok", title: "OK", start: "2026-11-01T00:00:00Z", subtitle: "s" }]);
    expect(() => parseTimelineIndex({})).toThrow(/timelines array/);
  });
});
