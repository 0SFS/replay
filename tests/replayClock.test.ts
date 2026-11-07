import { describe, expect, it } from "vitest";
import { createReplayClock } from "../src/replayClock.ts";

function frames() {
  let nowMs = 0;
  let pending: (() => void) | null = null;
  return {
    options: {
      now: () => nowMs,
      requestFrame: (callback: () => void) => { pending = callback; return 1; },
      cancelFrame: () => { pending = null; },
    },
    advance(ms: number) {
      nowMs += ms;
      const callback = pending;
      pending = null;
      callback?.();
    },
    get waiting() { return pending !== null; },
  };
}

describe("createReplayClock", () => {
  it("advances by real time times its rate while playing", () => {
    const frame = frames();
    const clock = createReplayClock({ ...frame.options, start: 0, end: 100, t: 10, rate: 2 });
    clock.play();
    frame.advance(500);
    expect(clock.get()).toEqual({ t: 11, playing: true, rate: 2 });
    clock.pause();
    expect(frame.waiting).toBe(false);
    frame.advance(1000);
    expect(clock.get().t).toBe(11);
  });

  it("stops at the end, and plays again from the start", () => {
    const frame = frames();
    const clock = createReplayClock({ ...frame.options, start: 0, end: 10, t: 9 });
    clock.play();
    frame.advance(5000);
    expect(clock.get()).toMatchObject({ t: 10, playing: false });
    clock.play();
    expect(clock.get()).toMatchObject({ t: 0, playing: true });
  });

  it("keeps seeks within its span and tells listeners", () => {
    const clock = createReplayClock({ ...frames().options, start: 0, end: 10 });
    const seen: number[] = [];
    const stop = clock.subscribe(() => seen.push(clock.get().t));
    clock.seek(-5);
    clock.seek(50);
    clock.setRate(0);
    stop();
    clock.seek(3);
    expect(seen).toEqual([0, 10]);
    expect(clock.get().rate).toBe(1);
  });

  it("does not count time from before a seek", () => {
    const frame = frames();
    const clock = createReplayClock({ ...frame.options, start: 0, end: 100 });
    clock.play();
    frame.advance(1000);
    clock.seek(50);
    frame.advance(1000);
    expect(clock.get().t).toBe(51);
  });
});
