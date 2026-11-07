import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplayController, readReplayAddress, replayAddressSearch, type ReplayAddress } from "../src/replayController.ts";
import type { ReplayScene, ReplaySubject } from "../src/replayScene.ts";
import { minimalTimeline, syntheticTrace } from "./fixtures.ts";

const INDEX = { timelines: [{ id: "test", title: "Test flight", start: "2026-11-01T17:00:00.000Z" }] };

function setup(files: Record<string, unknown> = { "/replay/timelines/index.json": INDEX, "/replay/timelines/test.json": minimalTimeline() }) {
  const addresses: ReplayAddress[] = [];
  const controller = createReplayController({
    baseUrl: "/",
    fetchJson: async url => {
      if (!(url in files)) throw new Error("404 Not Found");
      return JSON.parse(JSON.stringify(files[url]));
    },
    writeAddress: address => { addresses.push(address); },
    clockOptions: { now: () => 0, requestFrame: () => 1, cancelFrame: () => {} },
  });
  return { controller, addresses };
}

function fakeScene() {
  const calls: string[] = [];
  let subject: ReplaySubject | null = null;
  const scene = {
    runtime: null as never,
    follow(next: ReplaySubject | null) { subject = next; calls.push(next ? "follow" : "follow none"); },
    show(t: number) { calls.push(`show ${t}`); },
    setPlaying(playing: boolean) { calls.push(`playing ${playing}`); },
    destroy() {},
  } satisfies ReplayScene;
  return { scene, calls, subject: () => subject };
}

describe("replay address", () => {
  it("reads a timeline, a time and a speed", () => {
    expect(readReplayAddress("?timeline=N722BD-2026-11-01&t=8175.5&rate=2")).toEqual({ timeline: "N722BD-2026-11-01", t: 8175.5, rate: 2 });
    expect(readReplayAddress("?t=&rate=-1")).toEqual({ timeline: null, t: null, rate: null });
  });

  it("writes them beside other parameters, leaving out the usual speed", () => {
    expect(replayAddressSearch("?gkey=abc&t=1", { timeline: "x", t: 12.345, rate: 1 })).toBe("?gkey=abc&t=12.3&timeline=x");
    expect(replayAddressSearch("?timeline=x&t=1&rate=2", { timeline: null, t: null, rate: null })).toBe("");
  });
});

describe("createReplayController", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("opens a published flight at its highlight and puts it in the address", async () => {
    const { controller, addresses } = setup();
    await controller.loadFlights();
    await controller.openPublished("test");
    const { session, error, loading } = controller.getState();
    expect(error).toBeNull();
    expect(loading).toBeNull();
    expect(session?.publishedId).toBe("test");
    expect(session?.clock.get().t).toBe(5);
    expect(addresses.at(-1)).toEqual({ timeline: "test", t: 5, rate: 1 });
  });

  it("rewrites the address once the replay settles, not on every seek", async () => {
    const { controller, addresses } = setup();
    await controller.openPublished("test", { t: 1 });
    const clock = controller.getState().session!.clock;
    const before = addresses.length;
    clock.seek(2);
    clock.seek(3);
    clock.seek(4);
    expect(addresses).toHaveLength(before);
    vi.advanceTimersByTime(1000);
    expect(addresses.slice(before)).toEqual([{ timeline: "test", t: 4, rate: 1 }]);
  });

  it("says when a flight cannot be opened", async () => {
    const { controller } = setup();
    await controller.openPublished("missing");
    expect(controller.getState().error).toBe('The flight "missing" could not be opened: 404 Not Found');
    await controller.openPublished("../secrets");
    expect(controller.getState().error).toMatch(/is not a timeline id/);
  });

  it("opens a recording from this device without putting it in the address", async () => {
    const { controller, addresses } = setup();
    await controller.openFile({ name: "trace_full_a9ab17.json", text: async () => JSON.stringify(syntheticTrace()) });
    expect(controller.getState().session?.timeline.title).toBe("N722BD, BOMBARDIER LEARJET 60");
    expect(addresses.at(-1)).toEqual({ timeline: null, t: null, rate: null });
    await controller.openFile({ name: "notes.txt", text: async () => "hello" });
    expect(controller.getState().error).toBe("notes.txt could not be opened: It is not JSON.");
  });

  it("drops a load that finishes after a later one began", async () => {
    const { controller } = setup();
    const first = controller.openPublished("test");
    await controller.openFile({ name: "trace.json", text: async () => JSON.stringify(syntheticTrace()) });
    await first;
    expect(controller.getState().session?.publishedId).toBeNull();
  });

  it("has the 3D view follow the open flight and its clock", async () => {
    const { controller } = setup();
    const view = fakeScene();
    controller.attachScene(view.scene);
    await controller.openPublished("test");
    expect(view.subject()?.poseAt(5)?.latDeg).toBeCloseTo(10.5);
    expect(view.subject()?.epochMs).toBe(Date.parse(minimalTimeline().start));
    const clock = controller.getState().session!.clock;
    view.calls.length = 0;
    clock.seek(7);
    clock.play();
    clock.pause();
    expect(view.calls).toEqual(["show 7", "show 7", "playing true", "show 7", "playing false"]);
  });

  it("lists published flights, and says when the list is missing", async () => {
    const listed = setup();
    await listed.controller.loadFlights();
    expect(listed.controller.getState().flights).toEqual(INDEX.timelines);
    const missing = setup({});
    await missing.controller.loadFlights();
    expect(missing.controller.getState().flights).toEqual([]);
    expect(missing.controller.getState().error).toMatch(/list of flights could not be loaded/);
  });

  it("reports where the replay is, for a feedback file", async () => {
    const { controller } = setup();
    expect(controller.report()).toMatchObject({ timeline: null, t: null, view: { status: "starting" }, flights: null });
    await controller.loadFlights();
    await controller.openPublished("test", { t: 6.25, rate: 4 });
    expect(controller.report()).toEqual({
      timeline: { id: "test", title: minimalTimeline().title, publishedId: "test" },
      t: 6.25, rate: 4, playing: false,
      view: { status: "starting" }, model: { status: "none" }, loading: null, error: null, flights: 1,
      radio: { selected: null, enabled: true, status: "none", offsetS: null },
    });
  });

  it("reports the 3D view's failure and keeps the replay", async () => {
    const { controller } = setup();
    controller.attachScene(null, "WebGL is not available");
    await controller.openPublished("test");
    expect(controller.getState().view).toEqual({ status: "error", message: "WebGL is not available" });
    expect(controller.mapState()?.pose?.latDeg).toBeCloseTo(10.5);
  });
});
