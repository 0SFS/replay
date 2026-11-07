import { describe, expect, it } from "vitest";
import { createSkyTimeHold, skyTimeValues } from "../src/skyTime.ts";

function fakeSettings(registered = true) {
  const forced = new Map<string, Array<{ value: string | number; token: object }>>();
  return {
    has: (id: string) => registered && id.startsWith("sky.time."),
    force(id: string, value: string | number) {
      const token = {};
      forced.set(id, [...forced.get(id) ?? [], { value, token }]);
      return () => { forced.set(id, forced.get(id)!.filter(entry => entry.token !== token)); };
    },
    value: (id: string) => forced.get(id)?.at(-1)?.value,
    held: () => [...forced.values()].reduce((sum, stack) => sum + stack.length, 0),
  };
}

describe("skyTimeValues", () => {
  it("sets the day and the hour in UTC, to the minute", () => {
    expect(skyTimeValues(Date.parse("2026-11-01T17:48:15Z"))).toEqual({
      "sky.time.mode": "fixed", "sky.time.date": "2026-11-01", "sky.time.utcHours": 17 + 48 / 60,
    });
    expect(skyTimeValues(Date.parse("2026-11-01T23:59:45Z"))).toMatchObject({ "sky.time.date": "2026-11-02", "sky.time.utcHours": 0 });
  });
});

describe("createSkyTimeHold", () => {
  it("holds the sky at the moment shown, changing it once a minute", () => {
    const settings = fakeSettings();
    const hold = createSkyTimeHold(settings, "test");
    hold.set(Date.parse("2026-11-01T17:48:15Z"));
    hold.set(Date.parse("2026-11-01T17:48:25Z"));
    expect(settings.held()).toBe(3);
    hold.set(Date.parse("2026-11-01T17:49:00Z"));
    expect(settings.held()).toBe(3);
    expect(settings.value("sky.time.utcHours")).toBeCloseTo(17 + 49 / 60);
    expect(settings.value("sky.time.mode")).toBe("fixed");
  });

  it("lets go when told, or when there is nothing to show", () => {
    const settings = fakeSettings();
    const hold = createSkyTimeHold(settings, "test");
    hold.set(0);
    hold.set(null);
    expect(settings.held()).toBe(0);
    hold.set(0);
    hold.release();
    expect(settings.held()).toBe(0);
  });

  it("does nothing where the globe has no sky time", () => {
    const settings = fakeSettings(false);
    createSkyTimeHold(settings, "test").set(0);
    expect(settings.held()).toBe(0);
  });
});
