import { describe, expect, it } from "vitest";
import { dropHeldBaroAltitude, isReadsbTrace, readsbTraceToTrack } from "../src/readsbTrace.ts";
import { syntheticTrace, TRACE_EPOCH_S } from "./fixtures.ts";

const options = { id: "N722BD", label: "N722BD", sources: ["adsblol"] };

describe("readsbTraceToTrack", () => {
  it("reads every row but the stale one, from the first row's second", () => {
    const { track, startEpochS } = readsbTraceToTrack(syntheticTrace(), options);
    expect(startEpochS).toBe(TRACE_EPOCH_S);
    expect(track.samples.t).toHaveLength(60);
    expect(track.samples.t.includes(40.5)).toBe(false);
    expect(track.aircraft).toEqual({ registration: "N722BD", type: "LJ60", description: "BOMBARDIER LEARJET 60", icao24: "a9ab17" });
  });

  it("separates ground rows, pressure altitude and GNSS altitude", () => {
    const { samples } = readsbTraceToTrack(syntheticTrace(), options).track;
    expect(samples.onGround!.slice(0, 6)).toEqual([1, 1, 1, 1, 1, 0]);
    expect(samples.altBaroFt![0]).toBeNull();
    expect(samples.altBaroFt![5]).toBe(900);
    expect(samples.altGeomFt![5]).toBe(1000);
  });

  it("holds IDENT and integrity from the detail rows that carry them", () => {
    const { samples } = readsbTraceToTrack(syntheticTrace(), options).track;
    expect(samples.spi![29]).toBe(0);
    expect(samples.spi![30]).toBe(1);
    expect(samples.spi![59]).toBe(1);
    expect(samples.nic![59]).toBe(8);
  });

  it("fits vertical rate to GNSS altitude in the air only", () => {
    const { samples } = readsbTraceToTrack(syntheticTrace(), options).track;
    expect(samples.vsFromGeomFpm![2]).toBeNull();
    expect(samples.vsFromGeomFpm![30]).toBe(1200);
  });

  it("keeps the requested span and starts where asked", () => {
    const { track, startEpochS } = readsbTraceToTrack(syntheticTrace(), { ...options, fromEpochS: TRACE_EPOCH_S + 10, toEpochS: TRACE_EPOCH_S + 19, startEpochS: TRACE_EPOCH_S });
    expect(startEpochS).toBe(TRACE_EPOCH_S);
    expect(track.samples.t[0]).toBe(10);
    expect(track.samples.t.at(-1)).toBe(19);
    expect(() => readsbTraceToTrack(syntheticTrace(), { ...options, fromEpochS: TRACE_EPOCH_S + 1000 })).toThrow(/No trace rows/);
  });

  it("recognizes a trace", () => {
    expect(isReadsbTrace(syntheticTrace())).toBe(true);
    expect(isReadsbTrace({ format: "0sfs-flight-timeline" })).toBe(false);
    expect(isReadsbTrace(null)).toBe(false);
  });
});

describe("dropHeldBaroAltitude", () => {
  it("leaves out a pressure altitude held while GNSS altitude falls", () => {
    expect(dropHeldBaroAltitude([9000, 8750, 8750, 8750, 8750], [9200, 8950, 8100, 7000, 5000])).toEqual([9000, 8750, null, null, null]);
  });

  it("keeps a pressure altitude repeated in level flight", () => {
    expect(dropHeldBaroAltitude([41000, 41000, 41000], [41500, 41525, 41500])).toEqual([41000, 41000, 41000]);
  });

  it("keeps gaps as gaps", () => {
    expect(dropHeldBaroAltitude([null, null, 5000], [100, 900, 5100])).toEqual([null, null, 5000]);
  });
});
