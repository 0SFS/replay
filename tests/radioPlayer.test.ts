import { describe, expect, it } from "vitest";
import { createRadioPlayer, liveAtcStartMs, soundTimeAt, timelineTimeOf, trackFromAudio, transcriptLineAt, type AudioOutput } from "../src/radioPlayer.ts";
import { createReplayClock } from "../src/replayClock.ts";
import type { TimelineAudio } from "../src/timeline.ts";

/** A minute of radio heard from t = 100 on a timeline 0–300 s long. */
function radio(overrides: Partial<TimelineAudio> = {}): TimelineAudio {
  return {
    id: "atc", label: "Center", kind: "radio",
    files: [{ url: "atc.opus", type: 'audio/ogg; codecs="opus"' }, { url: "atc.mp3", type: "audio/mpeg" }],
    sources: ["atc"], t: 100, duration: 60,
    alignment: { method: "By hand", uncertaintyS: 2 },
    transcript: [{ at: 5, end: 8, text: "Climb three seven zero" }, { at: 20, end: 21, text: "Mayday" }],
    ...overrides,
  };
}

/** A stand-in for an audio element: it plays what it is asked to once `resolve` runs, and keeps time only when told. */
function fakeOutput(playable: (type: string) => boolean = () => true) {
  const calls: string[] = [];
  let pending: { resolve(): void; reject(error: Error): void } | null = null;
  const output = {
    src: "", preload: "", playbackRate: 1, paused: true, seeking: false, duration: NaN,
    currentTimeValue: 0,
    get currentTime() { return this.currentTimeValue; },
    set currentTime(value: number) { this.currentTimeValue = value; calls.push(`seek ${value.toFixed(2)}`); },
    play() {
      calls.push("play");
      return new Promise<void>((resolve, reject) => {
        pending = { resolve: () => { output.paused = false; resolve(); }, reject };
      });
    },
    pause() { output.paused = true; calls.push("pause"); },
    canPlayType: (type: string) => playable(type) ? "maybe" : "",
    addEventListener() {},
    removeEventListener() {},
  };
  return {
    output: output as typeof output & AudioOutput,
    calls,
    async started() { pending?.resolve(); pending = null; await Promise.resolve(); await Promise.resolve(); },
    async refused(name: string) {
      const error = new Error("refused");
      error.name = name;
      pending?.reject(error);
      pending = null;
      await Promise.resolve(); await Promise.resolve();
    },
  };
}

function setup(audio = radio(), playable?: (type: string) => boolean) {
  let nowMs = 0;
  let pending: (() => void) | null = null;
  const clock = createReplayClock({
    start: 0, end: 300, t: 90,
    now: () => nowMs,
    requestFrame: callback => { pending = callback; return 1; },
    cancelFrame: () => { pending = null; },
  });
  const fake = fakeOutput(playable);
  const player = createRadioPlayer({ clock, audio: [audio], createOutput: () => fake.output });
  const advance = (ms: number) => {
    nowMs += ms;
    const callback = pending;
    pending = null;
    callback?.();
  };
  return { clock, player, fake, advance };
}

describe("soundTimeAt and transcriptLineAt", () => {
  it("maps the replay's time into the sound, with the listener's offset", () => {
    const track = trackFromAudio(radio());
    expect(soundTimeAt(track, 99)).toBeNull();
    expect(soundTimeAt(track, 130)).toBe(30);
    expect(soundTimeAt(track, 160)).toBeNull();
    const later = { ...track, offsetS: 1.5 };
    expect(soundTimeAt(later, 130)).toBe(28.5);
    expect(timelineTimeOf(later, 28.5)).toBe(130);
  });

  it("finds the line being said, and holds it a moment after", () => {
    const track = trackFromAudio(radio());
    expect(transcriptLineAt(track, 4)).toBeNull();
    expect(transcriptLineAt(track, 6)?.text).toBe("Climb three seven zero");
    expect(transcriptLineAt(track, 8.5)?.text).toBe("Climb three seven zero");
    expect(transcriptLineAt(track, 12)).toBeNull();
    expect(transcriptLineAt(track, null)).toBeNull();
  });
});

describe("liveAtcStartMs", () => {
  it("reads the start of a LiveATC archive from its name", () => {
    expect(liveAtcStartMs("KZMA-Sec-Nov-01-2026-1730Z.mp3")).toBe(Date.parse("2026-11-01T17:30:00Z"));
    expect(liveAtcStartMs("atc.mp3")).toBeNull();
  });
});

describe("createRadioPlayer", () => {
  it("starts with the replay inside the sound, where the replay is, in a file the browser plays", async () => {
    const { clock, player, fake } = setup(radio(), type => type === "audio/mpeg");
    expect(player.getState().status).toBe("outside");
    clock.seek(130);
    expect(player.getState().status).toBe("paused");
    expect(fake.output.src).toBe("atc.mp3");
    clock.play();
    expect(fake.calls.slice(-2)).toEqual(["seek 30.00", "play"]);
    expect(player.getState().status).toBe("loading");
    await fake.started();
    expect(player.getState().status).toBe("playing");
    clock.pause();
    expect(fake.output.paused).toBe(true);
    expect(player.getState().status).toBe("paused");
  });

  it("waits until the replay reaches the sound, and stops at its end", async () => {
    const { clock, player, fake, advance } = setup();
    clock.play();
    advance(5000);
    expect(player.getState().status).toBe("outside");
    expect(fake.calls).not.toContain("play");
    advance(6000);
    expect(fake.calls.slice(-2)).toEqual(["seek 1.00", "play"]);
    await fake.started();
    clock.seek(170);
    expect(fake.output.paused).toBe(true);
    expect(player.getState().status).toBe("outside");
  });

  it("follows the replay's speed, and is silent outside the speeds sound plays at", async () => {
    const { clock, player, fake } = setup();
    clock.seek(130);
    clock.setRate(2);
    clock.play();
    await fake.started();
    expect(fake.output.playbackRate).toBe(2);
    clock.setRate(5);
    expect(fake.output.paused).toBe(true);
    expect(player.getState().status).toBe("speed");
  });

  it("moves the sound back when it drifts, but not for less", async () => {
    const { clock, fake, advance } = setup();
    clock.seek(130);
    clock.play();
    await fake.started();
    fake.calls.length = 0;
    fake.output.currentTimeValue = 30.2;
    advance(100);
    expect(fake.calls).toEqual([]);
    fake.output.currentTimeValue = 29;
    advance(100);
    expect(fake.calls).toEqual(["seek 30.20"]);
  });

  it("plays later after an offset, and not at all with sound off", async () => {
    const { clock, player, fake } = setup();
    player.setOffset("atc", 2);
    clock.seek(130);
    clock.play();
    expect(fake.calls.slice(-2)).toEqual(["seek 28.00", "play"]);
    await fake.started();
    player.setEnabled(false);
    expect(fake.output.paused).toBe(true);
    expect(player.getState().status).toBe("off");
  });

  it("waits for a click after the browser refuses to play, then tries again", async () => {
    const { clock, player, fake, advance } = setup();
    clock.seek(130);
    clock.play();
    await fake.refused("NotAllowedError");
    expect(player.getState().status).toBe("blocked");
    fake.calls.length = 0;
    advance(100);
    expect(fake.calls).toEqual([]);
    clock.pause();
    clock.play();
    expect(fake.calls).toContain("play");
  });

  it("says so when the browser plays none of the files", () => {
    const { clock, player } = setup(radio(), () => false);
    clock.seek(130);
    expect(player.getState().status).toBe("unsupported");
  });

  it("adds a file from this device where its start puts it, and lets go of it at the end", () => {
    const clock = createReplayClock({ start: 0, end: 300, t: 50, now: () => 0, requestFrame: () => 1, cancelFrame: () => {} });
    const fake = fakeOutput();
    const revoked: string[] = [];
    const player = createRadioPlayer({ clock, audio: [], createOutput: () => fake.output, revokeUrl: url => revoked.push(url) });
    expect(player.getState().status).toBe("none");
    player.addLocal({ name: "KZMA-Nov-01-2026-1730Z.mp3", type: "audio/mpeg", url: "blob:1" }, 40);
    expect(player.getState().selected).toBe("local-1");
    expect(player.getState().status).toBe("paused");
    expect(fake.output.currentTime).toBe(10);
    player.setStart("local-1", 45);
    expect(fake.output.currentTime).toBe(5);
    player.destroy();
    expect(revoked).toEqual(["blob:1"]);
  });
});
