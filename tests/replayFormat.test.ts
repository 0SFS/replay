import { describe, expect, it } from "vitest";
import { formatChannelValue, timelineClockFormat } from "../src/replayFormat.ts";

describe("timelineClockFormat", () => {
  it("reads times where the flight was and in UTC", () => {
    const format = timelineClockFormat({ start: "2026-11-01T15:32:00Z", timeZone: "America/New_York" });
    const t = 2 * 3600 + 16 * 60 + 15;
    expect(format.local(t)).toBe("12:48:15 EST");
    expect(format.utc(t)).toBe("17:48:15 UTC");
    expect(format.short(t)).toBe("12:48:15");
    expect(format.date(t)).toBe("Sun, Nov 1, 2026");
  });

  it("reads UTC where a timeline names no zone", () => {
    expect(timelineClockFormat({ start: "2026-11-01T00:00:00Z" }).short(61)).toBe("00:01:01");
  });
});

describe("formatChannelValue", () => {
  it("writes each unit as a reading", () => {
    expect(formatChannelValue("altGeomFt", { label: "", unit: "ft" }, 35450.4)).toBe("35,450 ft");
    expect(formatChannelValue("vsFromGeomFpm", { label: "", unit: "ft/min" }, -20928)).toBe("-20,928 ft/min");
    expect(formatChannelValue("trackDeg", { label: "", unit: "deg" }, 99.04)).toBe("99.0°");
    expect(formatChannelValue("latDeg", { label: "", unit: "deg" }, 26.632676)).toBe("26.63268°");
    expect(formatChannelValue("spi", { label: "", unit: "bool" }, 1)).toBe("on");
    expect(formatChannelValue("nic", { label: "", unit: "count" }, 9)).toBe("9");
    expect(formatChannelValue("turnRateDegS", { label: "", unit: "deg/s" }, 0.71)).toBe("0.7 deg/s");
    expect(formatChannelValue("altGeomFt", { label: "", unit: "ft" }, null)).toBe("—");
  });
});
